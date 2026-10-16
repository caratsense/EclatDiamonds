import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Role } from '@prisma/client';

import { AppModule } from '../src/app.module';
import { ROLES_KEY } from '../src/auth/roles.decorator';
import type { AuthUser } from '../src/common/auth-user';
import { CrmQualificationController } from '../src/crm/crm-ai.controller';
import { MetaAdsListService } from '../src/crm/meta-ads-list.service';
import { MetaGraphClient, MetaGraphError } from '../src/integrations/meta-graph.client';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * The campaign editor's Meta picker (client, 13 Oct): head office chooses from
 * the account's RUNNING campaigns and ads instead of retyping a name or pasting
 * a link. These tests drive MetaAdsListService against a FAKE Graph — no real
 * Meta app, no network — and pin what makes the picker trustworthy: it is
 * tenant-scoped, it lists running things only, it degrades to
 * `available: false` with a reason rather than failing, and it does not hammer
 * Graph on every dialog open.
 */

const A = { org: 'org_meta_ads_picker_a', slug: 'meta-ads-picker-a' };
const B = { org: 'org_meta_ads_picker_b', slug: 'meta-ads-picker-b' };

/** A stand-in for Graph. Records every call so a test can prove what was asked. */
class FakeGraph {
  readonly calls: Array<{
    organisationId: string;
    integrationId: string;
    path: string;
    query: Record<string, string>;
  }> = [];
  private handler: (() => unknown) | null = null;

  reply(handler: () => unknown) {
    this.handler = handler;
  }

  reset() {
    this.calls.length = 0;
    this.handler = null;
  }

  async getForIntegration<T>(
    organisationId: string,
    integrationId: string,
    path: string,
    query: Record<string, string>,
  ): Promise<T> {
    this.calls.push({ organisationId, integrationId, path, query });
    if (!this.handler) throw new MetaGraphError(`Unsupported get request for path: ${path}`, 400);
    return this.handler() as T;
  }
}

function principal(organisationId: string, role: Role = Role.store_manager): AuthUser {
  return {
    id: `user-${organisationId}`,
    name: 'Store manager',
    email: `sm@${organisationId}.example.com`,
    role,
    organisationId,
    storeIds: [],
    allStores: role === Role.head_office,
  };
}

const WA = 'WHATSAPP_MESSAGE';

/**
 * A plausible Graph page off the ADS edge -- which is what the service reads,
 * because campaigns-with-nested-ads overflowed the client's parse limit on a
 * real account. Two live WhatsApp creatives in one campaign, one paused ad,
 * and a running ad that opens a website instead.
 */
function graphPage() {
  return {
    data: [
      {
        id: '120210000000000001',
        name: 'Solitaire ring — Know the price',
        status: 'ACTIVE',
        campaign: { id: '23850000000000001', name: 'Diwali Solitaire', status: 'ACTIVE' },
        creative: {
          call_to_action_type: WA,
          effective_object_story_id: '260523660468952_122315315798218003',
          effective_instagram_media_id: '17879849562629585',
        },
      },
      {
        id: '120210000000000003',
        name: 'Solitaire pendant — festive',
        status: 'ACTIVE',
        campaign: { id: '23850000000000001', name: 'Diwali Solitaire', status: 'ACTIVE' },
        creative: { call_to_action_type: WA },
      },
      // Paused: returned anyway, must not be offered.
      {
        id: '120210000000000002',
        name: 'Old creative',
        status: 'PAUSED',
        campaign: { id: '23850000000000001', name: 'Diwali Solitaire', status: 'ACTIVE' },
        creative: { call_to_action_type: WA },
      },
      // Running, but it opens a website: a script on it could never fire.
      {
        id: '120210000000000004',
        name: 'Shop the collection',
        status: 'ACTIVE',
        campaign: { id: '23850000000000003', name: 'Website sales — retargeting', status: 'ACTIVE' },
        creative: { call_to_action_type: 'SHOP_NOW' },
      },
    ],
  };
}

describe('Meta ads picker (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let listing: MetaAdsListService;
  const graph = new FakeGraph();

  /** Each scenario gets its own integration, so lookups cannot bleed across tests. */
  let seq = 0;
  async function scenario(
    org: string,
    opts: { adAccount?: string | null; accountActive?: boolean; credential?: boolean } = {},
  ) {
    seq += 1;
    const id = `int_meta_ads_picker_${seq}`;
    await prisma.integration.create({
      data: {
        id,
        organisationId: org,
        providerCode: 'meta_ads',
        name: `Meta (picker case ${seq})`,
        status: 'connected',
      },
    });
    // The picker only serves a connection that actually holds a token: an
    // abandoned connection with an ad account but no credential is skipped.
    if (opts.credential !== false) {
      await prisma.integrationCredential.create({
        data: {
          organisationId: org,
          integrationId: id,
          kind: 'access_token',
          // Presence is all the picker reads; nothing decrypts this.
          ciphertext: 'test-ciphertext',
          iv: 'test-iv',
          authTag: 'test-tag',
        },
      });
    }
    if (opts.adAccount !== null) {
      await prisma.integrationAsset.create({
        data: {
          organisationId: org,
          integrationId: id,
          kind: 'ad_account',
          externalId: opts.adAccount ?? 'act_700000000200',
          name: 'Ad account',
          isActive: opts.accountActive ?? true,
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
    listing = app.get(MetaAdsListService);

    await teardown(prisma);
    await prisma.organisation.create({
      data: { id: A.org, name: 'Picker A', slug: A.slug, industryPackCode: 'healthcare' },
    });
    await prisma.organisation.create({
      data: { id: B.org, name: 'Picker B', slug: B.slug, industryPackCode: 'education' },
    });
  }, 120_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  beforeEach(async () => {
    graph.reset();
    listing.clearCache();
    // Each test declares its own connection state from scratch.
    await prisma.integrationAsset.deleteMany({ where: { organisationId: { in: [A.org, B.org] } } });
    await prisma.integration.deleteMany({ where: { organisationId: { in: [A.org, B.org] } } });
  });

  it('is unavailable with a reason — not an error — when Meta Ads is not connected', async () => {
    const result = await listing.list(A.org);

    expect(result).toEqual({
      available: false,
      reason: 'Meta Ads is not connected for this organisation.',
      campaigns: [],
    });
    expect(graph.calls).toHaveLength(0);
  });

  it('is unavailable when the connection has no registered ad account', async () => {
    await scenario(A.org, { adAccount: null });

    const result = await listing.list(A.org);

    expect(result.available).toBe(false);
    expect(result.reason).toContain('No Meta ad account');
    expect(result.campaigns).toEqual([]);
    expect(graph.calls).toHaveLength(0);
  });

  it('lists running campaigns and their running ads, and nothing paused', async () => {
    await scenario(A.org);
    graph.reply(graphPage);

    const result = await listing.list(A.org);

    expect(result.available).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.campaigns).toEqual([
      {
        id: '23850000000000001',
        name: 'Diwali Solitaire',
        status: 'ACTIVE',
        ads: [
          {
            id: '120210000000000001',
            name: 'Solitaire ring — Know the price',
            status: 'ACTIVE',
            aliasIds: [
              '260523660468952_122315315798218003',
              '122315315798218003',
              '17879849562629585',
            ],
          },
          {
            id: '120210000000000003',
            name: 'Solitaire pendant — festive',
            status: 'ACTIVE',
            aliasIds: [],
          },
        ],
      },
    ]);
    // The account id is read with the act_ prefix normalised, and the request
    // asks Meta itself for running campaigns only.
    expect(graph.calls).toHaveLength(1);
    // The ADS edge, not campaigns-with-nested-ads: the nested form overflowed
    // the Graph client's parse limit on a real account.
    expect(graph.calls[0].path).toBe('act_700000000200/ads');
    expect(graph.calls[0].query.effective_status).toBe('["ACTIVE"]');
  });

  it('degrades to unavailable when Graph refuses, instead of throwing', async () => {
    await scenario(A.org);
    graph.reply(() => {
      throw new MetaGraphError('Meta Graph HTTP 190: Session has expired', 190);
    });

    const result = await listing.list(A.org);

    expect(result.available).toBe(false);
    // The provider's own sentence reaches the screen: a generic line here is
    // what made an expired token look like an outage.
    expect(result.reason).toContain('Session has expired');
    expect(result.campaigns).toEqual([]);
  });

  it('answers repeat requests from the cache rather than hammering Graph', async () => {
    await scenario(A.org);
    graph.reply(graphPage);

    const first = await listing.list(A.org);
    const second = await listing.list(A.org);

    expect(second).toEqual(first);
    expect(graph.calls).toHaveLength(1);

    // A deliberate clear (a launch that must show up now) refetches.
    listing.clearCache();
    await listing.list(A.org);
    expect(graph.calls).toHaveLength(2);
  });

  it('never reads one tenant through another tenant\'s connection', async () => {
    await scenario(B.org);
    graph.reply(graphPage);

    const result = await listing.list(A.org);

    // A has no connection of its own; B's must not answer for it.
    expect(result.available).toBe(false);
    expect(graph.calls).toHaveLength(0);

    const own = await listing.list(B.org);
    expect(own.available).toBe(true);
    expect(graph.calls.every((c) => c.organisationId === B.org)).toBe(true);
  });

  it('serves the listing through the qualification controller, manager and above', async () => {
    await scenario(A.org);
    graph.reply(graphPage);

    const controller = app.get(CrmQualificationController);
    const result = await controller.metaAds(principal(A.org));

    expect(result.available).toBe(true);
    expect(result.campaigns).toHaveLength(1);
    // Management information: store manager and above, never a salesperson —
    // the same rank as its neighbours (ai-settings, adset-rules, policy).
    expect(Reflect.getMetadata(ROLES_KEY, controller.metaAds)).toEqual([Role.store_manager]);
  });

  it('offers only what can actually start a conversation, and every ad under it', async () => {
    await scenario(A.org);
    graph.reply(() => graphPage());
    const res = await listing.list(A.org);

    expect(res.available).toBe(true);
    // The website campaign is running, and is still not offered.
    expect(res.campaigns.map((c) => c.name)).toEqual(['Diwali Solitaire']);
    // Both live creatives are offered, so each can carry its own conversation.
    expect(res.campaigns[0].ads.map((a) => a.name)).toEqual([
      'Solitaire ring — Know the price',
      'Solitaire pendant — festive',
    ]);
    expect(graph.calls.at(-1)?.query.fields).toContain('call_to_action_type');
  });

  it('says so plainly when nothing running sends people to WhatsApp', async () => {
    await scenario(A.org);
    graph.reply(() => ({
      data: [
        {
          id: '120210000000000009',
          name: 'Shop now',
          status: 'ACTIVE',
          campaign: { id: '23850000000000009', name: 'Website sales only', status: 'ACTIVE' },
          creative: { call_to_action_type: 'SHOP_NOW' },
        },
      ],
    }));
    const res = await listing.list(A.org);

    expect(res.available).toBe(false);
    expect(res.campaigns).toEqual([]);
    expect(res.reason).toMatch(/WhatsApp/i);
  });

});

async function teardown(prisma: PrismaService) {
  const orgs = [A.org, B.org];
  await prisma.integrationAsset.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.integration.deleteMany({ where: { organisationId: { in: orgs } } });
  await prisma.organisation.deleteMany({ where: { id: { in: orgs } } });
}
