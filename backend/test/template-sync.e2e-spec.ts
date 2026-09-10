import { BadRequestException, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Role } from '@prisma/client';

import { AppModule } from '../src/app.module';
import type { AuthUser } from '../src/common/auth-user';
import { MetaGraphClient, MetaGraphError } from '../src/integrations/meta-graph.client';
import {
  templateSendability,
  TEMPLATE_VERDICT_MAX_AGE_MS,
} from '../src/omnichannel/omnichannel-policy';
import { OmnichannelService } from '../src/omnichannel/omnichannel.service';
import {
  TEMPLATE_SYNC_JOB,
  TemplateSyncService,
  templateKey,
} from '../src/omnichannel/template-sync.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * INT-08 - Meta decides whether a template may be sent, not the person who
 * typed it in.
 *
 * The old rule was one locally stored string. A head-office user chose
 * `status: "approved"` in a form, and that word unlocked sending outside the
 * 24-hour customer-care window for ever: nothing reconciled it with Meta, and
 * nothing expired it. A template Meta later paused for quality stayed
 * "approved" here until somebody noticed.
 */

const A = { org: 'org_tpl_a', slug: 'tpl-a', store: 'store_tpl_a', integ: 'int_tpl_a', waba: '110022003300' };
const B = { org: 'org_tpl_b', slug: 'tpl-b', store: 'store_tpl_b', integ: 'int_tpl_b', waba: '220033004400' };

class FakeGraph {
  calls: Array<{ path: string; providerCode: string }> = [];
  pages: Array<unknown> = [];

  async getForIntegration(
    _organisationId: string,
    _integrationId: string,
    path: string,
    _query: Record<string, string>,
    providerCode = 'meta_ads',
  ) {
    this.calls.push({ path, providerCode });
    const next = this.pages.shift();
    if (next instanceof Error) throw next;
    return (next ?? { data: [] }) as never;
  }
}

function tpl(name: string, language: string, status: string, category = 'utility') {
  return { id: `${name}-${language}`, name, language, status, category };
}

describe('INT-08 provider-authoritative WhatsApp templates (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sync: TemplateSyncService;
  let omnichannel: OmnichannelService;
  const graph = new FakeGraph();
  const userIds: Record<string, string> = {};

  const principal = (org: string): AuthUser => ({
    id: userIds[org],
    name: 'Head Office',
    email: `ho@${org}.local`,
    role: Role.head_office,
    organisationId: org,
    storeIds: [org === A.org ? A.store : B.store],
    allStores: true,
  });

  async function localTemplate(
    t: typeof A,
    name: string,
    language: string,
    over: { providerStatus?: string; syncedAt?: Date | null; isActive?: boolean } = {},
  ) {
    return prisma.integrationAsset.create({
      data: {
        organisationId: t.org,
        integrationId: t.integ,
        kind: 'message_template',
        externalId: `${name}:${language}`,
        name,
        isActive: over.isActive ?? true,
        providerOwnershipVerified: over.providerStatus === 'APPROVED',
        lastVerifiedAt: over.syncedAt ?? null,
        metadata: {
          channel: 'whatsapp',
          languageCode: language,
          category: 'utility',
          approvalStatus: 'pending',
          variables: [],
          recordedAt: '2026-09-01T00:00:00.000Z',
          ...(over.providerStatus
            ? {
                providerStatus: over.providerStatus,
                providerSyncedAt: (over.syncedAt ?? new Date()).toISOString(),
              }
            : {}),
        },
      },
    });
  }

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MetaGraphClient)
      .useValue(graph)
      .compile();
    app = mod.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    sync = app.get(TemplateSyncService);
    omnichannel = app.get(OmnichannelService);

    await teardown(prisma);
    for (const t of [A, B]) {
      await prisma.organisation.create({
        data: { id: t.org, name: t.slug, slug: t.slug, industryPackCode: 'retail' },
      });
      await prisma.store.create({
        data: { id: t.store, name: 'Main', city: 'Delhi', timezone: 'Asia/Kolkata', organisationId: t.org },
      });
      await prisma.integration.create({
        data: {
          id: t.integ, organisationId: t.org, providerCode: 'whatsapp_cloud',
          name: 'WhatsApp', status: 'connected',
          config: { whatsappBusinessAccountId: t.waba },
        },
      });
      userIds[t.org] = (
        await prisma.user.create({
          data: {
            email: `ho@${t.slug}.local`, name: 'Head Office', role: 'head_office',
            passwordHash: 'x', isActive: true, approvalStatus: 'approved', organisationId: t.org,
            userStores: { create: { storeId: t.store, isPrimary: true } },
          },
        })
      ).id;
    }
  }, 180_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  beforeEach(async () => {
    graph.calls = [];
    graph.pages = [];
    for (const t of [A, B]) {
      await prisma.integrationAsset.deleteMany({ where: { organisationId: t.org, kind: 'message_template' } });
    }
  });

  // -------------------------------------------------------------------
  // The rule itself (pure)
  // -------------------------------------------------------------------

  describe('sendability rule', () => {
    const fresh = new Date('2026-09-09T12:00:00.000Z');

    it('refuses a template no provider has ever confirmed', () => {
      expect(
        templateSendability({ isActive: true, providerStatus: 'UNKNOWN', providerSyncedAt: null }, fresh),
      ).toMatchObject({ sendable: false, code: 'never_verified' });
    });

    it('refuses every provider status except APPROVED', () => {
      for (const status of ['PENDING', 'REJECTED', 'PAUSED', 'DISABLED', 'DELETED', 'REMOVED'] as const) {
        expect(
          templateSendability({ isActive: true, providerStatus: status, providerSyncedAt: fresh }, fresh),
        ).toMatchObject({ sendable: false, code: 'not_approved_by_provider' });
      }
    });

    it('refuses an approval that is older than the freshness window', () => {
      const stale = new Date(fresh.getTime() - TEMPLATE_VERDICT_MAX_AGE_MS - 1_000);
      expect(
        templateSendability({ isActive: true, providerStatus: 'APPROVED', providerSyncedAt: stale }, fresh),
      ).toMatchObject({ sendable: false, code: 'verdict_stale' });
      // ...and accepts one inside it.
      const recent = new Date(fresh.getTime() - 60_000);
      expect(
        templateSendability({ isActive: true, providerStatus: 'APPROVED', providerSyncedAt: recent }, fresh),
      ).toMatchObject({ sendable: true, code: 'sendable' });
    });

    it('refuses a template an operator switched off, however approved it is', () => {
      expect(
        templateSendability({ isActive: false, providerStatus: 'APPROVED', providerSyncedAt: fresh }, fresh),
      ).toMatchObject({ sendable: false, code: 'inactive' });
    });

    it('identifies a template by name AND language', () => {
      expect(templateKey('Order_Update', 'en_US')).toBe('order_update:en_US');
      expect(templateKey('order_update', { language: 'hi' })).toBe('order_update:hi');
      expect(templateKey('order update', 'en_US')).toBeNull();
      expect(templateKey('order_update', 'not-a-language-code-at-all')).toBeNull();
    });
  });

  // -------------------------------------------------------------------
  // Synchronisation
  // -------------------------------------------------------------------

  it('records the provider verdict for each template, and refuses to invent one', async () => {
    await localTemplate(A, 'order_update', 'en_US');
    await localTemplate(A, 'promo_blast', 'en_US');
    await localTemplate(A, 'old_notice', 'en_US');
    graph.pages = [
      {
        data: [tpl('order_update', 'en_US', 'APPROVED'), tpl('promo_blast', 'en_US', 'PAUSED')],
      },
    ];

    const result = await sync.sync(A.org, A.integ);

    expect(result).toMatchObject({ providerTemplates: 2, approved: 1, removed: 1, discovered: 0 });
    expect(graph.calls[0]).toEqual({ path: `${A.waba}/message_templates`, providerCode: 'whatsapp_cloud' });

    const rows = await prisma.integrationAsset.findMany({
      where: { organisationId: A.org, kind: 'message_template' },
      orderBy: { externalId: 'asc' },
    });
    // Keyed by the bare name here; identity on disk is name:language.
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));

    expect(byName.order_update.providerOwnershipVerified).toBe(true);
    expect(byName.order_update.lastError).toBeNull();
    expect((byName.order_update.metadata as { providerStatus: string }).providerStatus).toBe('APPROVED');

    expect(byName.promo_blast.providerOwnershipVerified).toBe(false);
    expect((byName.promo_blast.metadata as { providerStatus: string }).providerStatus).toBe('PAUSED');
    expect(byName.promo_blast.lastError).toMatch(/PAUSED/);

    // A template the provider did not mention is REMOVED, not left alone.
    expect(byName.old_notice.providerOwnershipVerified).toBe(false);
    expect((byName.old_notice.metadata as { providerStatus: string }).providerStatus).toBe('REMOVED');
  });

  it('demotes a template Meta pauses after it was approved', async () => {
    await localTemplate(A, 'order_update', 'en_US');
    graph.pages = [{ data: [tpl('order_update', 'en_US', 'APPROVED')] }];
    await sync.sync(A.org, A.integ);
    expect(
      (await prisma.integrationAsset.findFirstOrThrow({ where: { externalId: 'order_update:en_US' } }))
        .providerOwnershipVerified,
    ).toBe(true);

    graph.pages = [{ data: [tpl('order_update', 'en_US', 'PAUSED')] }];
    await sync.sync(A.org, A.integ);

    const after = await prisma.integrationAsset.findFirstOrThrow({ where: { name: 'order_update' } });
    expect(after.providerOwnershipVerified).toBe(false);
    expect((after.metadata as { providerStatus: string }).providerStatus).toBe('PAUSED');
  });

  it('does not let an approved English template vouch for another language', async () => {
    // The local row is the Hindi template; the provider only approved English.
    await localTemplate(A, 'order_update', 'hi');
    graph.pages = [{ data: [tpl('order_update', 'en_US', 'APPROVED')] }];

    await sync.sync(A.org, A.integ);

    const hindi = await prisma.integrationAsset.findFirstOrThrow({
      where: { organisationId: A.org, externalId: 'order_update:hi' },
    });
    expect(hindi.providerOwnershipVerified).toBe(false);
    expect((hindi.metadata as { providerStatus: string }).providerStatus).toBe('REMOVED');
    // And the reason names the language, so nobody hunts for a deleted template.
    expect(hindi.lastError).toMatch(/only in en_US/);

    // The English one now arrives as its OWN row rather than being suppressed:
    // identity is name AND language, so both can be held at once and each keeps
    // the verdict Meta actually gave it.
    const english = await prisma.integrationAsset.findFirstOrThrow({
      where: { organisationId: A.org, externalId: 'order_update:en_US' },
    });
    expect(english.providerOwnershipVerified).toBe(true);
    expect(
      await prisma.integrationAsset.count({ where: { organisationId: A.org, kind: 'message_template' } }),
    ).toBe(2);
  });

  it('discovers templates the provider has that nobody recorded here', async () => {
    graph.pages = [{ data: [tpl('shipping_update', 'en_US', 'APPROVED'), tpl('draft_one', 'en_US', 'PENDING')] }];

    const result = await sync.sync(A.org, A.integ);

    expect(result.discovered).toBe(2);
    const rows = await prisma.integrationAsset.findMany({
      where: { organisationId: A.org, kind: 'message_template' },
      orderBy: { externalId: 'asc' },
    });
    expect(rows.map((r) => r.externalId)).toEqual(['draft_one:en_US', 'shipping_update:en_US']);
    expect(rows.find((r) => r.name === 'shipping_update')!.providerOwnershipVerified).toBe(true);
    expect(rows.find((r) => r.name === 'draft_one')!.providerOwnershipVerified).toBe(false);
    // Discovered, not declared: nothing pretends a person recorded these.
    expect((rows[0].metadata as { discoveredFromProvider: boolean }).discoveredFromProvider).toBe(true);
  });

  it('preserves the local record and its history through a sync', async () => {
    await localTemplate(A, 'order_update', 'en_US');
    graph.pages = [{ data: [tpl('order_update', 'en_US', 'APPROVED')] }];
    await sync.sync(A.org, A.integ);

    const row = await prisma.integrationAsset.findFirstOrThrow({ where: { externalId: 'order_update:en_US' } });
    const metadata = row.metadata as Record<string, unknown>;
    // What the operator recorded is still there beside what the provider said.
    expect(metadata.approvalStatus).toBe('pending');
    expect(metadata.languageCode).toBe('en_US');
    expect(metadata.recordedAt).toBe('2026-09-01T00:00:00.000Z');
    expect(metadata.providerStatus).toBe('APPROVED');
  });

  it('never reaches into another tenant', async () => {
    await localTemplate(A, 'order_update', 'en_US');
    await localTemplate(B, 'order_update', 'en_US');
    graph.pages = [{ data: [tpl('order_update', 'en_US', 'APPROVED')] }];

    await sync.sync(A.org, A.integ);

    const theirs = await prisma.integrationAsset.findFirstOrThrow({
      where: { organisationId: B.org, externalId: 'order_update:en_US' },
    });
    expect(theirs.providerOwnershipVerified).toBe(false);
    expect(theirs.lastVerifiedAt).toBeNull();
  });

  it('redacts and bounds a provider failure instead of storing the request', async () => {
    const secret = 'EAAGxSuperSecretTokenValue1234567890';
    graph.pages = [new MetaGraphError(`failed access_token=${secret} Bearer ${secret} ${'x'.repeat(600)}`, 400)];

    await expect(sync.sync(A.org, A.integ)).rejects.toThrow();

    const integration = await prisma.integration.findUniqueOrThrow({ where: { id: A.integ } });
    expect(integration.lastError).not.toContain(secret);
    expect(integration.lastError).toContain('access_token=[redacted]');
    expect(integration.lastError!.length).toBeLessThanOrEqual(300);
  });

  it('refuses to sync a connection with no WhatsApp Business Account recorded', async () => {
    await prisma.integration.update({ where: { id: B.integ }, data: { config: {} } });
    await expect(sync.sync(B.org, B.integ)).rejects.toBeInstanceOf(BadRequestException);
    expect(graph.calls).toHaveLength(0);
    await prisma.integration.update({
      where: { id: B.integ },
      data: { config: { whatsappBusinessAccountId: B.waba } },
    });
  });

  // -------------------------------------------------------------------
  // Durable background path
  // -------------------------------------------------------------------

  it('offers a durable background sync and lists only connections it can sync', async () => {
    const queued = await sync.schedule(principal(A.org), A.integ);
    expect(queued.queued).toBe(true);

    const job = await prisma.jobTask.findFirstOrThrow({ where: { id: queued.jobId } });
    expect(job.kind).toBe(TEMPLATE_SYNC_JOB);
    expect(job.organisationId).toBe(A.org);
    // The same request within the hour collapses onto the same job.
    const again = await sync.schedule(principal(A.org), A.integ);
    expect(again.jobId).toBe(queued.jobId);
    expect(again.deduplicated).toBe(true);

    const syncable = await sync.syncableIntegrations();
    expect(syncable.map((s) => s.id)).toEqual(expect.arrayContaining([A.integ, B.integ]));

    // A disabled connection is not swept.
    await prisma.integration.update({ where: { id: B.integ }, data: { status: 'disabled' } });
    const afterDisable = await sync.syncableIntegrations();
    expect(afterDisable.map((s) => s.id)).not.toContain(B.integ);
    await prisma.integration.update({ where: { id: B.integ }, data: { status: 'connected' } });
  });

  // -------------------------------------------------------------------
  // What it means for sending
  // -------------------------------------------------------------------

  describe('sending', () => {
    let conversationId: string;

    beforeAll(async () => {
      const party = await prisma.party.create({
        data: { organisationId: A.org, storeId: A.store, name: 'Template Customer', types: ['customer'], phone: '919811110000' },
      });
      conversationId = (
        await prisma.conversation.create({
          data: {
            organisationId: A.org, storeId: A.store, partyId: party.id,
            channel: 'whatsapp', externalThreadId: '919811110000',
          },
        })
      ).id;
    });

    const send = (templateAssetId: string) =>
      omnichannel.queue(principal(A.org), conversationId, {
        purpose: 'service',
        templateAssetId,
        body: 'Your order is ready.',
      });

    it('refuses to send a template nobody has verified with the provider', async () => {
      const asset = await localTemplate(A, 'never_synced', 'en_US');
      await expect(send(asset.id)).rejects.toThrow(/never been confirmed with the provider/i);
    });

    it('refuses to send even when an operator recorded it as approved locally', async () => {
      const asset = await prisma.integrationAsset.create({
        data: {
          organisationId: A.org, integrationId: A.integ, kind: 'message_template',
          externalId: 'locally_approved', name: 'locally_approved', isActive: true,
          // Exactly the row the old code would have sent on.
          metadata: {
            channel: 'whatsapp', languageCode: 'en_US', category: 'utility',
            approvalStatus: 'approved', variables: [], recordedAt: '2026-09-01T00:00:00.000Z',
          },
        },
      });
      await expect(send(asset.id)).rejects.toThrow(/never been confirmed with the provider/i);
    });

    it('refuses to send an approval that has gone stale', async () => {
      const asset = await localTemplate(A, 'stale_one', 'en_US', {
        providerStatus: 'APPROVED',
        syncedAt: new Date(Date.now() - TEMPLATE_VERDICT_MAX_AGE_MS - 60_000),
      });
      await expect(send(asset.id)).rejects.toThrow(/out of date/i);
    });

    it('sends a template the provider approved, recently', async () => {
      await localTemplate(A, 'order_update', 'en_US');
      graph.pages = [{ data: [tpl('order_update', 'en_US', 'APPROVED')] }];
      await sync.sync(A.org, A.integ);
      const asset = await prisma.integrationAsset.findFirstOrThrow({ where: { externalId: 'order_update:en_US' } });

      const queued = await send(asset.id);
      expect(queued).toMatchObject({ message: { status: 'queued' }, policy: { mode: 'template' } });
    });
  });

  // -------------------------------------------------------------------
  // The local control plane
  // -------------------------------------------------------------------

  it('cannot raise the provider verdict by recording the template again', async () => {
    await localTemplate(A, 'order_update', 'en_US');
    graph.pages = [{ data: [tpl('order_update', 'en_US', 'APPROVED')] }];
    await sync.sync(A.org, A.integ);

    await omnichannel.upsertTemplate(principal(A.org), A.integ, {
      name: 'order_update',
      channel: 'whatsapp',
      languageCode: 'en_US',
      category: 'utility',
      status: 'pending',
      variables: [],
    } as never);

    const row = await prisma.integrationAsset.findFirstOrThrow({ where: { externalId: 'order_update:en_US' } });
    const metadata = row.metadata as Record<string, unknown>;
    // The provider verdict survived a local edit rather than being reset or raised.
    expect(metadata.providerStatus).toBe('APPROVED');
    expect(metadata.approvalStatus).toBe('pending');
  });
});

async function teardown(prisma: PrismaService) {
  for (const t of [A, B]) {
    await prisma.message.deleteMany({ where: { organisationId: t.org } }).catch(() => undefined);
    await prisma.conversation.deleteMany({ where: { organisationId: t.org } }).catch(() => undefined);
    await prisma.activityEvent.deleteMany({ where: { organisationId: t.org } }).catch(() => undefined);
    await prisma.contactPoint.deleteMany({ where: { organisationId: t.org } }).catch(() => undefined);
    await prisma.party.deleteMany({ where: { organisationId: t.org } }).catch(() => undefined);
    await prisma.jobTask.deleteMany({ where: { organisationId: t.org } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { organisationId: t.org } }).catch(() => undefined);
    await prisma.integrationAsset.deleteMany({ where: { organisationId: t.org } }).catch(() => undefined);
    await prisma.integration.deleteMany({ where: { organisationId: t.org } }).catch(() => undefined);
    await prisma.userStore.deleteMany({ where: { store: { organisationId: t.org } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { organisationId: t.org } }).catch(() => undefined);
    await prisma.store.deleteMany({ where: { organisationId: t.org } }).catch(() => undefined);
    await prisma.organisation.deleteMany({ where: { id: t.org } }).catch(() => undefined);
  }
}
