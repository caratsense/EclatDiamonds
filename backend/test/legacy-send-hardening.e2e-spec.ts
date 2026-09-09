import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Role } from '@prisma/client';

import { AppModule } from '../src/app.module';
import type { AuthUser } from '../src/common/auth-user';
import { AdvancedCrmService } from '../src/crm/advanced-crm.service';
import { JobAlertsService } from '../src/jobs/job-alerts.service';
import { JobsService } from '../src/jobs/jobs.service';
import { OmnichannelService } from '../src/omnichannel/omnichannel.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { WhatsAppService } from '../src/integrations/whatsapp.service';

/**
 * The legacy WhatsApp send endpoint, made to obey the same rules as everything
 * else — plus the three smaller safety defects fixed alongside it.
 *
 * `POST /integrations/whatsapp/send` predates the omnichannel module and called
 * the provider directly. No consent check, no opt-out check, no 24-hour window,
 * no provider-approved template, no outbox row, no delivery job, no audit. Any
 * store manager could message any number in the tenant, including one that had
 * answered STOP, and nothing recorded that it happened.
 *
 * Every test below is an assertion about a message that must NOT leave, or
 * about a record that must exist afterwards.
 */

const A = { org: 'org_send_a', slug: 'send-a', store: 'store_send_a', integ: 'int_send_a' };
const B = { org: 'org_send_b', slug: 'send-b', store: 'store_send_b', integ: 'int_send_b' };
const OTHER_STORE = 'store_send_a2';

const CUSTOMER = '919812300001';
const STRANGER = '919812300009';

/** Records every call the provider layer was asked to make. */
class FakeWhatsApp {
  sends: Array<{ to: string; payload: unknown }> = [];
  nextResult: { delivered: boolean; dryRun: boolean; messageId?: string; error?: string } = {
    delivered: true,
    dryRun: false,
    messageId: 'wamid.fake1',
  };

  async sendText(_org: string, to: string, body: string) {
    this.sends.push({ to, payload: { body } });
    return { ...this.nextResult, to };
  }

  async sendTemplate(_org: string, to: string, name: string, languageCode?: string) {
    this.sends.push({ to, payload: { name, languageCode } });
    return { ...this.nextResult, to };
  }

  async enabledFor() {
    return true;
  }
}

describe('legacy WhatsApp send + Phase 6 hardening (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let omnichannel: OmnichannelService;
  let jobs: JobsService;
  let alerts: JobAlertsService;
  let crm: AdvancedCrmService;
  const whatsapp = new FakeWhatsApp();
  const userIds: Record<string, string> = {};
  let partyId = '';
  let otherStorePartyId = '';

  const headOffice = (org: string): AuthUser => ({
    id: userIds[org],
    name: 'Head Office',
    email: `ho@${org}.local`,
    role: Role.head_office,
    organisationId: org,
    storeIds: [org === A.org ? A.store : B.store],
    allStores: true,
  });

  const storeManager: AuthUser = {
    id: '',
    name: 'Store Manager',
    email: 'sm@send-a.local',
    role: Role.store_manager,
    organisationId: A.org,
    storeIds: [A.store],
    allStores: false,
  };

  /** A template row exactly as upsert/sync writes it: keyed by name AND language. */
  async function template(
    name: string,
    language: string,
    providerStatus: string,
    syncedAt: Date | null = new Date(),
  ) {
    return prisma.integrationAsset.create({
      data: {
        organisationId: A.org,
        integrationId: A.integ,
        kind: 'message_template',
        externalId: `${name}:${language}`,
        name,
        isActive: true,
        providerOwnershipVerified: providerStatus === 'APPROVED',
        lastVerifiedAt: syncedAt,
        metadata: {
          channel: 'whatsapp',
          languageCode: language,
          category: 'utility',
          approvalStatus: 'pending',
          variables: [],
          recordedAt: '2026-09-01T00:00:00.000Z',
          providerStatus,
          providerSyncedAt: (syncedAt ?? new Date()).toISOString(),
        },
      },
    });
  }

  /**
   * Make the thread exist so `setWindow` has a row to move. Creating it here
   * rather than through a send keeps the window fixture independent of whatever
   * the policy would have said about that first message.
   */
  async function openThread() {
    await prisma.conversation.upsert({
      where: {
        organisationId_channel_externalThreadId: {
          organisationId: A.org, channel: 'whatsapp', externalThreadId: CUSTOMER,
        },
      },
      create: {
        organisationId: A.org, channel: 'whatsapp', externalThreadId: CUSTOMER,
        partyId, storeId: A.store, handling: 'human',
      },
      update: {},
    });
  }

  /** Move the thread's last inbound message so the 24-hour window opens/closes. */
  async function setWindow(hoursAgo: number | null) {
    await prisma.conversation.updateMany({
      where: { organisationId: A.org, externalThreadId: CUSTOMER },
      data: { lastInboundAt: hoursAgo === null ? null : new Date(Date.now() - hoursAgo * 3_600_000) },
    });
  }

  async function consent(status: 'granted' | 'revoked', purpose: 'service' | 'marketing' | 'all') {
    await omnichannel.recordConsent(headOffice(A.org), {
      partyId,
      channel: 'whatsapp',
      purpose,
      status,
      source: 'verbal',
    } as never);
  }

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WhatsAppService)
      .useValue(whatsapp)
      .compile();
    app = mod.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    omnichannel = app.get(OmnichannelService);
    jobs = app.get(JobsService);
    alerts = app.get(JobAlertsService);
    crm = app.get(AdvancedCrmService);

    await teardown(prisma);
    for (const t of [A, B]) {
      await prisma.organisation.create({
        data: { id: t.org, name: t.slug, slug: t.slug, industryPackCode: 'retail', country: 'IN' },
      });
      await prisma.store.create({
        data: { id: t.store, name: 'Main', city: 'Delhi', timezone: 'Asia/Kolkata', organisationId: t.org },
      });
      await prisma.integration.create({
        data: {
          id: t.integ,
          organisationId: t.org,
          providerCode: 'whatsapp_cloud',
          name: 'WhatsApp',
          status: 'connected',
          config: { whatsappBusinessAccountId: '110022003300' },
        },
      });
      userIds[t.org] = (
        await prisma.user.create({
          data: {
            email: `ho@${t.slug}.local`,
            name: 'Head Office',
            role: 'head_office',
            passwordHash: 'x',
            isActive: true,
            approvalStatus: 'approved',
            organisationId: t.org,
            userStores: { create: { storeId: t.store, isPrimary: true } },
          },
        })
      ).id;
    }
    // A second store in tenant A, so "another store's customer" is testable.
    await prisma.store.create({
      data: { id: OTHER_STORE, name: 'Second', city: 'Mumbai', timezone: 'Asia/Kolkata', organisationId: A.org },
    });
    storeManager.id = (
      await prisma.user.create({
        data: {
          email: 'sm@send-a.local',
          name: 'Store Manager',
          role: 'store_manager',
          passwordHash: 'x',
          isActive: true,
          approvalStatus: 'approved',
          organisationId: A.org,
          userStores: { create: { storeId: A.store, isPrimary: true } },
        },
      })
    ).id;

    partyId = (
      await prisma.party.create({
        data: {
          organisationId: A.org,
          storeId: A.store,
          name: 'Test Customer',
          phone: CUSTOMER,
          contactPoints: {
            create: { organisationId: A.org, kind: 'whatsapp', value: CUSTOMER, valueNormalized: CUSTOMER, isPrimary: true },
          },
        },
      })
    ).id;
    otherStorePartyId = (
      await prisma.party.create({
        data: {
          organisationId: A.org,
          storeId: OTHER_STORE,
          name: 'Other Store Customer',
          phone: STRANGER,
          contactPoints: {
            create: { organisationId: A.org, kind: 'whatsapp', value: STRANGER, valueNormalized: STRANGER, isPrimary: true },
          },
        },
      })
    ).id;
  }, 180_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  beforeEach(async () => {
    whatsapp.sends = [];
    whatsapp.nextResult = { delivered: true, dryRun: false, messageId: 'wamid.fake1' };
    await prisma.message.deleteMany({ where: { organisationId: A.org } });
    await prisma.jobTask.deleteMany({ where: { organisationId: A.org } });
    await prisma.integrationAsset.deleteMany({ where: { organisationId: A.org, kind: 'message_template' } });
    await prisma.activityEvent.deleteMany({ where: { organisationId: A.org } });
    await prisma.auditLog.deleteMany({ where: { organisationId: A.org } });
  });

  // ------------------------------------------------------------------ P1
  describe('consent and the 24-hour window', () => {
    it('sends free text to a consenting customer inside the window', async () => {
      await consent('granted', 'all');
      await openThread();
      await setWindow(2);
      const queued = await omnichannel.queueToContact(headOffice(A.org), {
        to: CUSTOMER,
        purpose: 'service',
        body: 'Your ring is ready.',
      });
      expect(queued.message.status).toBe('queued');
      expect(queued.policy.mode).toBe('free_text');
    });

    it('refuses after an unambiguous opt-out, even with an approved template', async () => {
      await consent('revoked', 'all');
      const asset = await template('order_update', 'en_US', 'APPROVED');
      await setWindow(1);
      await expect(
        omnichannel.queueToContact(headOffice(A.org), {
          to: CUSTOMER,
          purpose: 'service',
          templateName: 'order_update',
          languageCode: 'en_US',
        }),
      ).rejects.toThrow(/opted out/i);
      expect(asset.id).toBeTruthy();
      expect(whatsapp.sends).toHaveLength(0);
    });

    it('refuses marketing with no recorded consent', async () => {
      await setWindow(1);
      await expect(
        omnichannel.queueToContact(headOffice(A.org), {
          to: CUSTOMER,
          purpose: 'marketing',
          body: 'Diwali offer',
        }),
      ).rejects.toThrow(/consent/i);
      expect(whatsapp.sends).toHaveLength(0);
    });

    it('refuses free text outside the window when no template is given', async () => {
      await consent('granted', 'all');
      await openThread();
      await setWindow(48);
      await expect(
        omnichannel.queueToContact(headOffice(A.org), { to: CUSTOMER, purpose: 'service', body: 'Hello again' }),
      ).rejects.toThrow(/template is required/i);
      expect(whatsapp.sends).toHaveLength(0);
    });

    it('allows an approved template outside the window', async () => {
      await consent('granted', 'all');
      await template('order_update', 'en_US', 'APPROVED');
      await openThread();
      await setWindow(48);
      const queued = await omnichannel.queueToContact(headOffice(A.org), {
        to: CUSTOMER,
        purpose: 'service',
        templateName: 'order_update',
        languageCode: 'en_US',
      });
      expect(queued.policy.mode).toBe('template');
    });

    it('refuses a template the provider paused', async () => {
      await consent('granted', 'all');
      await template('order_update', 'en_US', 'PAUSED');
      await setWindow(48);
      await expect(
        omnichannel.queueToContact(headOffice(A.org), {
          to: CUSTOMER,
          purpose: 'service',
          templateName: 'order_update',
          languageCode: 'en_US',
        }),
      ).rejects.toThrow(/PAUSED|not approved/i);
    });

    it('refuses a template whose approval nobody has re-checked recently', async () => {
      await consent('granted', 'all');
      const stale = new Date(Date.now() - 40 * 3_600_000);
      await template('order_update', 'en_US', 'APPROVED', stale);
      await setWindow(48);
      await expect(
        omnichannel.queueToContact(headOffice(A.org), {
          to: CUSTOMER,
          purpose: 'service',
          templateName: 'order_update',
          languageCode: 'en_US',
        }),
      ).rejects.toThrow(/out of date/i);
    });
  });

  describe('authorisation', () => {
    it('refuses a customer belonging to another store', async () => {
      expect(otherStorePartyId).toBeTruthy();
      await expect(
        omnichannel.queueToContact(storeManager, { to: STRANGER, purpose: 'service', body: 'hi' }),
      ).rejects.toThrow(/not found/i);
      expect(whatsapp.sends).toHaveLength(0);
    });

    it('never reaches a customer in another tenant', async () => {
      // Tenant B holds the same number; A's send must not resolve to B's party.
      await prisma.party.create({
        data: {
          organisationId: B.org,
          storeId: B.store,
          name: 'Their Customer',
          phone: CUSTOMER,
          contactPoints: {
            create: { organisationId: B.org, kind: 'whatsapp', value: CUSTOMER, valueNormalized: CUSTOMER, isPrimary: true },
          },
        },
      });
      await consent('granted', 'all');
      await setWindow(1);
      const queued = await omnichannel.queueToContact(headOffice(A.org), {
        to: CUSTOMER,
        purpose: 'service',
        body: 'tenant A only',
      });
      const conversation = await prisma.conversation.findUniqueOrThrow({
        where: { id: queued.message.conversationId },
      });
      expect(conversation.organisationId).toBe(A.org);
      expect(conversation.partyId).toBe(partyId);
      await prisma.contactPoint.deleteMany({ where: { organisationId: B.org } });
      await prisma.party.deleteMany({ where: { organisationId: B.org } });
    });

    it('refuses a template name this tenant does not hold in that language', async () => {
      await consent('granted', 'all');
      await template('order_update', 'en_US', 'APPROVED');
      await setWindow(48);
      await expect(
        omnichannel.queueToContact(headOffice(A.org), {
          to: CUSTOMER,
          purpose: 'service',
          templateName: 'order_update',
          languageCode: 'hi',
        }),
      ).rejects.toThrow(/not registered/i);
    });
  });

  describe('durability', () => {
    it('does not report the message as sent before the provider accepts it', async () => {
      await consent('granted', 'all');
      await setWindow(1);
      const queued = await omnichannel.queueToContact(headOffice(A.org), {
        to: CUSTOMER,
        purpose: 'service',
        body: 'not yet sent',
      });
      expect(queued.message.status).toBe('queued');
      // No provider message id, because no provider has seen it yet.
      expect(queued.message.externalId).toBeNull();
      expect(queued.job?.id).toBeTruthy();
      // Nothing reached the provider on the request thread.
      expect(whatsapp.sends).toHaveLength(0);
    });

    it('marks the message sent only after the delivery job runs', async () => {
      await consent('granted', 'all');
      await setWindow(1);
      const queued = await omnichannel.queueToContact(headOffice(A.org), {
        to: CUSTOMER,
        purpose: 'service',
        body: 'deliver me',
      });
      await jobs.drain(10);
      const after = await prisma.message.findUniqueOrThrow({ where: { id: queued.message.id } });
      expect(after.status).toBe('sent');
      expect(after.externalId).toBe('wamid.fake1');
      expect(whatsapp.sends).toHaveLength(1);
    });

    it('keeps the message unsent when the provider refuses', async () => {
      await consent('granted', 'all');
      await setWindow(1);
      whatsapp.nextResult = { delivered: false, dryRun: false, error: 'provider said no' };
      const queued = await omnichannel.queueToContact(headOffice(A.org), {
        to: CUSTOMER,
        purpose: 'service',
        body: 'will fail',
      });
      await jobs.drain(10);
      const after = await prisma.message.findUniqueOrThrow({ where: { id: queued.message.id } });
      expect(['queued', 'failed']).toContain(after.status);
      expect(after.externalId).toBeNull();
    });

    it('resolves a replayed request to the same message', async () => {
      await consent('granted', 'all');
      await setWindow(1);
      const key = 'legacy-send-replay-1';
      const first = await omnichannel.queueToContact(headOffice(A.org), {
        to: CUSTOMER, purpose: 'service', body: 'once', idempotencyKey: key,
      });
      const second = await omnichannel.queueToContact(headOffice(A.org), {
        to: CUSTOMER, purpose: 'service', body: 'once', idempotencyKey: key,
      });
      expect(second.message.id).toBe(first.message.id);
      expect(second.deduplicated).toBe(true);
      expect(
        await prisma.message.count({ where: { organisationId: A.org, direction: 'outbound' } }),
      ).toBe(1);
    });

    it('reuses one thread per number instead of forking a new one', async () => {
      await consent('granted', 'all');
      await setWindow(1);
      await omnichannel.queueToContact(headOffice(A.org), { to: CUSTOMER, purpose: 'service', body: 'one' });
      await omnichannel.queueToContact(headOffice(A.org), { to: CUSTOMER, purpose: 'service', body: 'two' });
      expect(
        await prisma.conversation.count({ where: { organisationId: A.org, externalThreadId: CUSTOMER } }),
      ).toBe(1);
    });

    it('records the queued message on the customer timeline', async () => {
      await consent('granted', 'all');
      await setWindow(1);
      const queued = await omnichannel.queueToContact(headOffice(A.org), {
        to: CUSTOMER, purpose: 'service', body: 'audit me',
      });
      const event = await prisma.activityEvent.findFirstOrThrow({
        where: { organisationId: A.org, type: 'message.queued', entityId: queued.message.id },
      });
      expect(event.partyId).toBe(partyId);
      expect(event.actorUserId).toBe(userIds[A.org]);
      // The trail carries the decision, never the message text or the number.
      expect(JSON.stringify(event.metadata ?? {})).not.toContain(CUSTOMER);
      expect(JSON.stringify(event.metadata ?? {})).not.toContain('audit me');
    });
  });

  // ------------------------------------------------------- multilingual P2
  describe('one template, two languages', () => {
    it('holds both languages at once and judges each on its own verdict', async () => {
      await consent('granted', 'all');
      await template('order_update', 'en_US', 'APPROVED');
      await template('order_update', 'hi', 'REJECTED');
      await setWindow(48);

      const english = await omnichannel.queueToContact(headOffice(A.org), {
        to: CUSTOMER, purpose: 'service', templateName: 'order_update', languageCode: 'en_US',
      });
      expect(english.policy.mode).toBe('template');

      await expect(
        omnichannel.queueToContact(headOffice(A.org), {
          to: CUSTOMER, purpose: 'service', templateName: 'order_update', languageCode: 'hi',
        }),
      ).rejects.toThrow(/REJECTED|not approved/i);
    });

    it('sends the provider the bare template name, not the local composite key', async () => {
      await consent('granted', 'all');
      await template('order_update', 'en_US', 'APPROVED');
      await setWindow(48);
      await omnichannel.queueToContact(headOffice(A.org), {
        to: CUSTOMER, purpose: 'service', templateName: 'order_update', languageCode: 'en_US',
      });
      await jobs.drain(10);
      expect(whatsapp.sends[0]?.payload).toMatchObject({ name: 'order_update', languageCode: 'en_US' });
    });

    it('records two languages of one template as two rows', async () => {
      const first = await omnichannel.upsertTemplate(headOffice(A.org), A.integ, {
        name: 'welcome', channel: 'whatsapp', languageCode: 'en_US',
        category: 'utility', status: 'pending', variables: [],
      } as never);
      const second = await omnichannel.upsertTemplate(headOffice(A.org), A.integ, {
        name: 'welcome', channel: 'whatsapp', languageCode: 'hi',
        category: 'utility', status: 'pending', variables: [],
      } as never);
      expect(first.id).not.toBe(second.id);
      expect(first.externalId).toBe('welcome:en_US');
      expect(second.externalId).toBe('welcome:hi');
      expect(
        await prisma.integrationAsset.count({
          where: { organisationId: A.org, kind: 'message_template', name: 'welcome' },
        }),
      ).toBe(2);
    });
  });

  // --------------------------------------------------------- QR secret P2
  describe('CRM QR signing secret', () => {
    const original = process.env.NODE_ENV;
    const originalSecret = process.env.CRM_QR_SECRET;

    afterEach(() => {
      process.env.NODE_ENV = original;
      if (originalSecret === undefined) delete process.env.CRM_QR_SECRET;
      else process.env.CRM_QR_SECRET = originalSecret;
    });

    it('fails closed in production when the secret is missing', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.CRM_QR_SECRET;
      await expect(
        crm.issueLeadQr(headOffice(A.org), { storeId: A.store } as never),
      ).rejects.toThrow(/CRM_QR_SECRET/);
    });

    it('never falls back to the session signing key', () => {
      // The fallback is gone from the source, which is the only place it could
      // have lived. A grep is the honest test for the absence of a line.
      const source = require('node:fs').readFileSync(
        require('node:path').join(__dirname, '..', 'src', 'crm', 'advanced-crm.service.ts'),
        'utf8',
      ) as string;
      expect(source).not.toMatch(/CRM_QR_SECRET'\)\s*\?\?\s*this\.config\.get<string>\('JWT_SECRET/);
    });
  });

  // ------------------------------------------------------ dead-job alerts
  describe('dead-job alerting', () => {
    beforeEach(async () => {
      await prisma.organisation.update({ where: { id: A.org }, data: { settings: {} } });
      await prisma.jobTask.deleteMany({ where: { organisationId: A.org } });
    });

    async function deadJob(kind: string) {
      return prisma.jobTask.create({
        data: {
          organisationId: A.org,
          kind,
          status: 'dead',
          payload: {},
          attempts: 5,
          maxAttempts: 5,
          runAt: new Date(),
        },
      });
    }

    it('raises an alert the first time a lead-capture job dies', async () => {
      await deadJob('meta.lead_ads.fetch');
      const raised = await alerts.sweep(A.org);
      expect(raised).toHaveLength(1);
      expect(raised[0]).toMatchObject({ key: 'lead_capture', state: 'firing', count: 1 });
    });

    it('does not page again while the same condition persists', async () => {
      await deadJob('meta.lead_ads.fetch');
      expect(await alerts.sweep(A.org)).toHaveLength(1);
      await deadJob('meta.lead_ads.fetch');
      expect(await alerts.sweep(A.org)).toHaveLength(0);
    });

    it('says so when the condition clears', async () => {
      const job = await deadJob('meta.lead_ads.fetch');
      await alerts.sweep(A.org);
      await prisma.jobTask.delete({ where: { id: job.id } });
      const recovered = await alerts.sweep(A.org);
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({ state: 'recovered' });
    });

    it('carries no customer data in the alert', async () => {
      await deadJob('meta.lead_ads.fetch');
      const [alert] = await alerts.sweep(A.org);
      const serialised = JSON.stringify(alert);
      expect(serialised).not.toContain(CUSTOMER);
      expect(serialised).not.toContain('Test Customer');
      expect(Object.keys(alert).sort()).toEqual(
        ['count', 'key', 'label', 'oldestAt', 'organisationId', 'state', 'status', 'threshold'],
      );
    });

    it("leaves another tenant's counters alone", async () => {
      await deadJob('meta.lead_ads.fetch');
      await alerts.sweep(A.org);
      expect(await alerts.sweep(B.org)).toHaveLength(0);
    });
  });

  // ------------------------------------------------ staging recipient door
  describe('staging recipient allowlist', () => {
    /**
     * Built directly rather than through the module, because the point is that
     * the door sits at the single outbound chokepoint — below every policy,
     * queue and retry — and refuses before any credential is even resolved.
     */
    function serviceWith(allowlist: string | undefined) {
      const config = {
        get: (key: string) => (key === 'MESSAGING_RECIPIENT_ALLOWLIST' ? allowlist : undefined),
      };
      const credentials = {
        senderFor: async () => {
          throw new Error('credentials must not be consulted for a refused recipient');
        },
      };
      return new WhatsAppService(config as never, credentials as never);
    }

    it('lets a listed number through to the credential resolver', async () => {
      const service = serviceWith('919812300001');
      // Reaching the resolver is the pass condition; it throws by design here.
      await expect(service.sendText('org', CUSTOMER, 'hello')).rejects.toThrow(/credentials/);
    });

    it('refuses a number that is not listed, without consulting credentials', async () => {
      const service = serviceWith('919812300001');
      const result = await service.sendText('org', STRANGER, 'hello');
      expect(result).toMatchObject({ delivered: false, dryRun: true });
      expect(result.reason).toMatch(/test recipients/i);
    });

    it('reads an allowlist that parsed to nothing as nobody, not everybody', async () => {
      const service = serviceWith('   ,  , ');
      const result = await service.sendText('org', CUSTOMER, 'hello');
      expect(result.delivered).toBe(false);
      expect(result.dryRun).toBe(true);
    });

    it('is inert when the variable is unset, so production is unaffected', async () => {
      const service = serviceWith(undefined);
      await expect(service.sendText('org', STRANGER, 'hello')).rejects.toThrow(/credentials/);
    });

    it('normalises both sides, so 10-digit and country-coded forms match', async () => {
      const service = serviceWith('9812300001');
      await expect(service.sendText('org', CUSTOMER, 'hello')).rejects.toThrow(/credentials/);
    });
  });
});

async function teardown(prisma: PrismaService) {
  for (const org of [A.org, B.org]) {
    await prisma.message.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.conversation.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.activityEvent.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.contactPoint.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.lead.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.party.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.jobTask.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.integrationAsset.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.integration.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.userStore.deleteMany({ where: { store: { organisationId: org } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.store.deleteMany({ where: { organisationId: org } }).catch(() => undefined);
    await prisma.organisation.deleteMany({ where: { id: org } }).catch(() => undefined);
  }
}
