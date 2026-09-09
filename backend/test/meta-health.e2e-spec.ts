import { ForbiddenException, INestApplication, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Role } from '@prisma/client';

import { AppModule } from '../src/app.module';
import type { AuthUser } from '../src/common/auth-user';
import { MetaGraphClient, MetaGraphError } from '../src/integrations/meta-graph.client';
import { MetaHealthService } from '../src/integrations/meta-health.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * INT-07 - "connected" has to mean the provider answered.
 *
 * A stored token proves somebody pasted a string; a stored asset id proves
 * somebody typed a number. An administration screen that calls either of those
 * "connected" tells an operator to wait for leads that will never arrive.
 *
 * These tests drive MetaHealthService against a FAKE Graph provider - no real
 * Meta app, no network - and pin the four things that make the verdict
 * trustworthy: it is evidence-based, it is redacted, it is tenant-scoped, and it
 * does not overwrite a decision a human made.
 */

const A = { org: 'org_meta_health_a', slug: 'meta-health-a' };
const B = { org: 'org_meta_health_b', slug: 'meta-health-b' };

/**
 * A stand-in for Graph. Records every call so a test can prove which assets were
 * probed - and, just as importantly, which were not.
 */
class FakeGraph {
  readonly calls: Array<{ organisationId: string; integrationId: string; path: string }> = [];
  private readonly handlers = new Map<string, () => unknown>();

  reply(externalId: string, handler: () => unknown) {
    this.handlers.set(externalId, handler);
  }

  reset() {
    this.calls.length = 0;
    this.handlers.clear();
  }

  pathsFor(integrationId: string): string[] {
    return this.calls.filter((c) => c.integrationId === integrationId).map((c) => c.path);
  }

  async getForIntegration<T>(
    organisationId: string,
    integrationId: string,
    path: string,
    _query: Record<string, string>,
  ): Promise<T> {
    this.calls.push({ organisationId, integrationId, path });
    const handler = this.handlers.get(path);
    if (!handler) throw new MetaGraphError(`Unsupported get request for object at path: ${path}`, 400);
    return handler() as T;
  }
}

function principal(organisationId: string, role: Role = Role.head_office): AuthUser {
  return {
    id: `user-${organisationId}`,
    name: 'Head office',
    email: `ho@${organisationId}.example.com`,
    role,
    organisationId,
    storeIds: [],
    allStores: role === Role.head_office,
  };
}

describe('INT-07 Meta connection health (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let health: MetaHealthService;
  const graph = new FakeGraph();

  /** Each scenario gets its own integration, so the 30s cooldown cannot bleed across tests. */
  let seq = 0;
  async function scenario(
    org: string,
    assets: Array<{ kind: string; externalId: string; isActive?: boolean }>,
    opts: { credential?: boolean; status?: string } = {},
  ) {
    seq += 1;
    const id = `int_meta_health_${seq}`;
    await prisma.integration.create({
      data: {
        id,
        organisationId: org,
        providerCode: 'meta_ads',
        name: `Meta (case ${seq})`,
        status: opts.status ?? 'not_configured',
      },
    });
    if (opts.credential !== false) {
      await prisma.integrationCredential.create({
        data: {
          organisationId: org,
          integrationId: id,
          kind: 'access_token',
          // A recognisable stand-in. No response may ever surface this string.
          ciphertext: 'CIPHERTEXT-MUST-NEVER-BE-RETURNED',
          iv: 'aXY=',
          authTag: 'dGFn',
        },
      });
    }
    for (const asset of assets) {
      await prisma.integrationAsset.create({
        data: {
          organisationId: org,
          integrationId: id,
          kind: asset.kind,
          externalId: asset.externalId,
          name: `${asset.kind} ${asset.externalId}`,
          isActive: asset.isActive ?? true,
        },
      });
    }
    return id;
  }

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MetaGraphClient)
      .useValue(graph)
      .compile();
    app = mod.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    health = app.get(MetaHealthService);

    await teardown(prisma);
    await prisma.organisation.create({
      data: { id: A.org, name: 'Health A', slug: A.slug, industryPackCode: 'healthcare' },
    });
    await prisma.organisation.create({
      data: { id: B.org, name: 'Health B', slug: B.slug, industryPackCode: 'education' },
    });
  }, 120_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  beforeEach(() => graph.reset());

  it('describes a fresh integration as not configured, and never returns the stored secret', async () => {
    const id = await scenario(A.org, [], { credential: false });
    const state = await health.describe(principal(A.org), id);

    expect(state).toMatchObject({
      integrationId: id,
      providerCode: 'meta_ads',
      state: 'not_configured',
      credentialPresent: false,
      lastHealthAt: null,
      assets: [],
    });
    // describe() must not contact the provider - it reports what is stored.
    expect(graph.calls).toHaveLength(0);
  });

  it('reports credential presence as a boolean and never as the ciphertext', async () => {
    const id = await scenario(A.org, [{ kind: 'page', externalId: '700000000001' }]);
    const state = await health.describe(principal(A.org), id);

    expect(state.credentialPresent).toBe(true);
    expect(JSON.stringify(state)).not.toContain('CIPHERTEXT-MUST-NEVER-BE-RETURNED');
    expect(JSON.stringify(state)).not.toContain('authTag');
  });

  it('refuses to check without a stored token, and does not call the provider', async () => {
    const id = await scenario(A.org, [{ kind: 'page', externalId: '700000000002' }], { credential: false });
    const state = await health.check(principal(A.org), id);

    expect(state.state).toBe('not_configured');
    expect(state.error).toContain('No access token');
    expect(graph.calls).toHaveLength(0);
    // A check that could not run must still record that it ran - otherwise a
    // screen cannot distinguish "never checked" from "checked and unusable".
    expect(state.lastHealthAt).toBeInstanceOf(Date);
  });

  it('marks connected only when every active asset was read back by id', async () => {
    const id = await scenario(A.org, [
      { kind: 'page', externalId: '700000000010' },
      { kind: 'ad_account', externalId: '700000000011' },
    ]);
    graph.reply('700000000010', () => ({ id: '700000000010', name: 'Main page' }));
    graph.reply('700000000011', () => ({ id: '700000000011', name: 'Ads', currency: 'INR' }));

    const state = await health.check(principal(A.org), id);

    expect(state.state).toBe('connected');
    expect(state.error).toBeNull();
    expect(state.assets).toHaveLength(2);
    for (const asset of state.assets) {
      expect(asset.verified).toBe(true);
      expect(asset.lastVerifiedAt).toBeInstanceOf(Date);
      expect(asset.error).toBeNull();
    }
    expect(graph.pathsFor(id).sort()).toEqual(['700000000010', '700000000011']);
  });

  it('treats a redirected id as unverified - reading something is not owning it', async () => {
    const id = await scenario(A.org, [{ kind: 'page', externalId: '700000000020' }]);
    // Graph can answer for a different node than the one asked about.
    graph.reply('700000000020', () => ({ id: '999999999999', name: 'Someone else' }));

    const state = await health.check(principal(A.org), id);

    expect(state.state).toBe('needs_attention');
    expect(state.assets[0].verified).toBe(false);
    expect(state.assets[0].error).toContain('different asset id');
  });

  it('is needs_attention when the token works but one asset of several does not', async () => {
    const id = await scenario(A.org, [
      { kind: 'page', externalId: '700000000030' },
      { kind: 'form', externalId: '700000000031' },
    ]);
    graph.reply('700000000030', () => ({ id: '700000000030' }));
    graph.reply('700000000031', () => {
      throw new MetaGraphError('Meta Graph HTTP 404: Object does not exist', 404, '803');
    });

    const state = await health.check(principal(A.org), id);

    expect(state.state).toBe('needs_attention');
    expect(state.error).toBe('1 of 2 assets could not be verified.');
    const byId = Object.fromEntries(state.assets.map((a) => [a.externalId, a]));
    expect(byId['700000000030'].verified).toBe(true);
    expect(byId['700000000031'].verified).toBe(false);
  });

  it('is failed - not needs_attention - when the credential itself was rejected', async () => {
    const id = await scenario(A.org, [{ kind: 'page', externalId: '700000000040' }]);
    graph.reply('700000000040', () => {
      throw new MetaGraphError('Meta Graph HTTP 190: Error validating access token: Session has expired', 190);
    });

    const state = await health.check(principal(A.org), id);

    // A rejected token is one job for one person; a missing asset is another.
    expect(state.state).toBe('failed');
    expect(state.error).toBe('The stored access token was rejected by the provider.');
    expect(state.assets[0].verified).toBe(false);
  });

  it('redacts token material out of a stored provider error and bounds its length', async () => {
    const id = await scenario(A.org, [{ kind: 'page', externalId: '700000000050' }]);
    const secret = 'EAAGxSuperSecretTokenValue1234567890';
    graph.reply('700000000050', () => {
      throw new MetaGraphError(
        `Request failed: access_token=${secret}&fields=id - Bearer ${secret} - ${'x'.repeat(600)}`,
        400,
      );
    });

    const state = await health.check(principal(A.org), id);
    const stored = state.assets[0].error ?? '';

    expect(stored).not.toContain(secret);
    expect(stored).toContain('access_token=[redacted]');
    expect(stored).toContain('Bearer [redacted]');
    expect(stored.length).toBeLessThanOrEqual(300);
  });

  it('says so when an asset kind has no ownership check, instead of passing it by omission', async () => {
    const id = await scenario(A.org, [{ kind: 'catalogue', externalId: '700000000060' }]);

    const state = await health.check(principal(A.org), id);

    expect(state.state).toBe('needs_attention');
    expect(state.assets[0].verified).toBe(false);
    expect(state.assets[0].error).toContain('No ownership check exists');
    // Never probed - the service knew it could not judge this kind.
    expect(graph.pathsFor(id)).toHaveLength(0);
  });

  it('is not_configured when a working token has nothing registered to read', async () => {
    const id = await scenario(A.org, []);

    const state = await health.check(principal(A.org), id);

    expect(state.state).toBe('not_configured');
    expect(state.error).toContain('No assets have been registered');
  });

  it('never probes an asset an operator deactivated', async () => {
    const id = await scenario(A.org, [
      { kind: 'page', externalId: '700000000070' },
      { kind: 'page', externalId: '700000000071', isActive: false },
    ]);
    graph.reply('700000000070', () => ({ id: '700000000070' }));

    const state = await health.check(principal(A.org), id);

    expect(state.state).toBe('connected');
    expect(graph.pathsFor(id)).toEqual(['700000000070']);
    // It still appears in the description, honestly unverified.
    expect(state.assets.map((a) => a.externalId).sort()).toEqual(['700000000070', '700000000071']);
  });

  it('leaves a deliberately disabled integration alone', async () => {
    const id = await scenario(A.org, [{ kind: 'page', externalId: '700000000080' }], { status: 'disabled' });
    graph.reply('700000000080', () => ({ id: '700000000080' }));

    const state = await health.check(principal(A.org), id);

    // Somebody switched this off on purpose. A sweep that flipped it back to
    // connected would undo that decision silently.
    expect(state.state).toBe('disabled');
    expect(graph.calls).toHaveLength(0);
  });

  it('rate-limits repeat checks instead of hammering the provider on every refresh', async () => {
    const id = await scenario(A.org, [{ kind: 'page', externalId: '700000000090' }]);
    graph.reply('700000000090', () => ({ id: '700000000090' }));

    const first = await health.check(principal(A.org), id);
    const second = await health.check(principal(A.org), id);

    expect(first.state).toBe('connected');
    expect(second.state).toBe('connected');
    expect(graph.pathsFor(id)).toEqual(['700000000090']);
    // The second call returns the stored verdict, and says when it was reached.
    expect(second.lastHealthAt).toEqual(first.lastHealthAt);
  });

  it('cannot be used to probe another tenant - by id, and by neighbouring assets', async () => {
    const foreign = await scenario(B.org, [{ kind: 'page', externalId: '700000000100' }]);
    graph.reply('700000000100', () => ({ id: '700000000100' }));

    await expect(health.describe(principal(A.org), foreign)).rejects.toBeInstanceOf(NotFoundException);
    await expect(health.check(principal(A.org), foreign)).rejects.toBeInstanceOf(NotFoundException);
    expect(graph.calls).toHaveLength(0);

    // And tenant A's own check must not sweep up B's asset even though both are
    // meta_ads pages in the same table.
    const own = await scenario(A.org, [{ kind: 'page', externalId: '700000000101' }]);
    graph.reply('700000000101', () => ({ id: '700000000101' }));
    await health.check(principal(A.org), own);

    expect(graph.calls.map((c) => c.path)).toEqual(['700000000101']);
    expect(graph.calls.every((c) => c.organisationId === A.org)).toBe(true);
    // B's asset is untouched: still unverified, still never checked.
    const bAsset = await prisma.integrationAsset.findFirst({ where: { externalId: '700000000100' } });
    expect(bAsset?.providerOwnershipVerified).toBe(false);
    expect(bAsset?.lastVerifiedAt).toBeNull();
  });

  it('is head-office only - a store manager cannot read or run a health check', async () => {
    const id = await scenario(A.org, [{ kind: 'page', externalId: '700000000110' }]);
    const manager = principal(A.org, Role.store_manager);

    await expect(health.describe(manager, id)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(health.check(manager, id)).rejects.toBeInstanceOf(ForbiddenException);
    expect(graph.calls).toHaveLength(0);
  });

  it('downgrades a previously connected integration when the evidence changes', async () => {
    const id = await scenario(A.org, [{ kind: 'page', externalId: '700000000120' }], { status: 'connected' });
    graph.reply('700000000120', () => {
      throw new MetaGraphError('Meta Graph HTTP 190: OAuth access token is invalid', 190);
    });

    const state = await health.check(principal(A.org), id);

    // "connected" is never sticky. It survives only as long as a check confirms it.
    expect(state.state).toBe('failed');
    const row = await prisma.integration.findUnique({ where: { id } });
    expect(row?.status).toBe('failed');
  });
});

async function teardown(prisma: PrismaService) {
  const orgs = [A.org, B.org];
  await prisma.integrationAsset.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.integrationCredential.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.integration.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.organisation.deleteMany({ where: { id: { in: orgs } } });
}
