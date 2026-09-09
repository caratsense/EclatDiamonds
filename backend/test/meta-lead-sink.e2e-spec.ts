import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { MetaLeadAdapter } from '../src/integrations/meta-lead.adapter';
import { MetaLeadAdsService } from '../src/integrations/meta-lead-ads.service';
import type { MetaLeadRecord } from '../src/integrations/meta-contracts';

/**
 * INT-02 / INT-03 — a verified Meta lead becomes CRM records exactly once.
 *
 * Before this, `MetaLeadAdsService` fetched the lead and handed it to a sink
 * nobody had registered, so every Lead Ads job threw "sink is not registered"
 * and dead-lettered after five attempts: no customer, no lead, no attribution.
 *
 * The tests below are database-backed and cover the guarantees that actually
 * matter once leads start arriving: the lead is filed under an honest source,
 * replay is idempotent under the unique index rather than under a lookup, a
 * store is never guessed, unknown form answers cannot mass-assign columns, and
 * one tenant's lead can never land in another tenant.
 */

const A = { org: 'org_meta_lead_a', slug: 'meta-lead-a', store: 'store_meta_lead_a', integ: 'int_meta_lead_a' };
const B = { org: 'org_meta_lead_b', slug: 'meta-lead-b', s1: 'store_meta_lead_b1', s2: 'store_meta_lead_b2', integ: 'int_meta_lead_b' };

function record(over: Partial<MetaLeadRecord> = {}): MetaLeadRecord {
  return {
    organisationId: A.org,
    integrationId: A.integ,
    leadgenId: 'lg_1001',
    pageId: '55501',
    formId: 'form_9',
    createdAt: new Date('2026-09-09T09:00:00.000Z'),
    adId: 'ad_1',
    adSetId: 'adset_1',
    campaignId: 'camp_1',
    adName: 'Spring ad',
    adSetName: 'Spring set',
    campaignName: 'Spring',
    fullName: 'Priya Menon',
    phone: '+919812345601',
    email: 'priya@example.com',
    fields: [
      { name: 'full_name', values: ['Priya Menon'] },
      { name: 'phone_number', values: ['+919812345601'] },
      { name: 'what_is_your_budget', values: ['under 50k'] },
    ],
    ...over,
  };
}

describe('INT-02 Meta Lead Ads CRM sink (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sink: MetaLeadAdapter;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    sink = app.get(MetaLeadAdapter);

    await teardown(prisma);
    await prisma.organisation.create({ data: { id: A.org, name: 'Meta Lead A', slug: A.slug, industryPackCode: 'healthcare' } });
    await prisma.store.create({ data: { id: A.store, name: 'Only branch', city: 'Delhi', timezone: 'Asia/Kolkata', organisationId: A.org } });
    await prisma.integration.create({ data: { id: A.integ, organisationId: A.org, providerCode: 'meta_ads', name: 'Meta (test)', status: 'connected' } });

    // Tenant B deliberately has TWO stores, so there is no single obvious
    // branch and routing must decide.
    await prisma.organisation.create({ data: { id: B.org, name: 'Meta Lead B', slug: B.slug, industryPackCode: 'manufacturing' } });
    await prisma.store.createMany({ data: [
      { id: B.s1, name: 'North', city: 'Delhi', timezone: 'Asia/Kolkata', organisationId: B.org },
      { id: B.s2, name: 'South', city: 'Chennai', timezone: 'Asia/Kolkata', organisationId: B.org },
    ] });
    await prisma.integration.create({ data: { id: B.integ, organisationId: B.org, providerCode: 'meta_ads', name: 'Meta (test)', status: 'connected' } });
  }, 120_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  it('is registered with the Lead Ads service — the step that was missing', () => {
    // If this regresses, every Lead Ads job dead-letters again.
    expect(app.get(MetaLeadAdsService)).toBeDefined();
    expect(sink).toBeInstanceOf(MetaLeadAdapter);
    // Re-registering the same sink is a no-op; a DIFFERENT one is refused.
    expect(() => app.get(MetaLeadAdsService).registerSink(sink)).not.toThrow();
  });

  it('files the lead under the honest meta_ads source', async () => {
    const result = await sink.acceptMetaLead(record());
    expect(result.accepted).toBe(true);
    expect(result.duplicate).toBe(false);

    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: result.leadId! } });
    expect(lead.source).toBe('meta_ads');
    expect(lead.organisationId).toBe(A.org);
    expect(lead.storeId).toBe(A.store);
    expect(lead.originKey).toBe('meta_lead:lg_1001');
    expect(lead.customerName).toBe('Priya Menon');
    expect(lead.phone).toBe('+919812345601');
  }, 60_000);

  it('resolves the customer through the CRM identity contract', async () => {
    const lead = await prisma.lead.findFirstOrThrow({ where: { organisationId: A.org, originKey: 'meta_lead:lg_1001' } });
    expect(lead.partyId).toBeTruthy();
    const contacts = await prisma.contactPoint.findMany({ where: { organisationId: A.org, partyId: lead.partyId! } });
    // Phone and email both land on the party, not on the lead row.
    expect(contacts.map((c) => c.kind).sort()).toEqual(['email', 'phone']);
  }, 60_000);

  it('records measured attribution with only the ids Meta actually returned', async () => {
    const lead = await prisma.lead.findFirstOrThrow({ where: { organisationId: A.org, originKey: 'meta_lead:lg_1001' } });
    const touch = await prisma.attributionTouch.findFirstOrThrow({ where: { organisationId: A.org, leadId: lead.id } });
    expect(touch.source).toBe('meta_ads');
    expect(touch.evidence).toBe('measured');
    expect(touch.externalCampaignId).toBe('camp_1');
    expect(touch.externalAdSetId).toBe('adset_1');
  }, 60_000);

  it('leaves absent provider identifiers NULL rather than inventing them', async () => {
    const result = await sink.acceptMetaLead(
      record({ leadgenId: 'lg_bare', campaignId: null, adSetId: null, adId: null, adSetName: null, campaignName: null, phone: '+919812345602', email: null }),
    );
    const touch = await prisma.attributionTouch.findFirstOrThrow({ where: { organisationId: A.org, leadId: result.leadId! } });
    expect(touch.externalCampaignId).toBeNull();
    expect(touch.externalAdSetId).toBeNull();
    expect(touch.externalAdId).toBeNull();
    // Never 'organic', never a placeholder id.
    expect(touch.source).toBe('meta_ads');
  }, 60_000);

  it('is idempotent on replay — one lead, one attribution touch', async () => {
    const before = await prisma.lead.count({ where: { organisationId: A.org } });
    const first = await sink.acceptMetaLead(record());
    const second = await sink.acceptMetaLead(record());
    expect(second.duplicate).toBe(true);
    expect(second.leadId).toBe(first.leadId);
    expect(await prisma.lead.count({ where: { organisationId: A.org } })).toBe(before);
    expect(
      await prisma.attributionTouch.count({ where: { organisationId: A.org, leadId: first.leadId! } }),
    ).toBe(1);
  }, 60_000);

  it('survives two concurrent deliveries of the same lead', async () => {
    // The unique index on (organisationId, originKey) is the real guard; the
    // lookup before it is only an optimisation, so both callers must still
    // converge on one lead.
    const [a, b] = await Promise.all([
      sink.acceptMetaLead(record({ leadgenId: 'lg_race', phone: '+919812345603' })),
      sink.acceptMetaLead(record({ leadgenId: 'lg_race', phone: '+919812345603' })),
    ]);
    expect(a.leadId).toBe(b.leadId);
    expect(await prisma.lead.count({ where: { organisationId: A.org, originKey: 'meta_lead:lg_race' } })).toBe(1);
  }, 60_000);

  it('keeps unknown form answers as bounded named data, not columns', async () => {
    const lead = await prisma.lead.findFirstOrThrow({ where: { organisationId: A.org, originKey: 'meta_lead:lg_1001' } });
    const attrs = lead.attributes as { metaLeadForm?: { name: string; values: string[] }[] } | null;
    expect(attrs?.metaLeadForm).toEqual([{ name: 'what_is_your_budget', values: ['under 50k'] }]);
    // Recognised questions are promoted to real columns and not stored twice.
    expect(attrs?.metaLeadForm?.some((f) => f.name === 'phone_number')).toBe(false);
  }, 60_000);

  it('cannot be made to mass-assign a column from a provider key', async () => {
    const result = await sink.acceptMetaLead(
      record({
        leadgenId: 'lg_evil',
        phone: '+919812345604',
        fields: [
          { name: 'organisationId', values: [B.org] },
          { name: 'ownerId', values: ['someone'] },
          { name: 'outcome', values: ['won'] },
        ],
      }),
    );
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: result.leadId! } });
    expect(lead.organisationId).toBe(A.org);
    expect(lead.ownerId).toBeNull();
    expect(lead.outcome).toBe('open');
  }, 60_000);

  it('bounds an abusive payload', async () => {
    const result = await sink.acceptMetaLead(
      record({
        leadgenId: 'lg_big',
        phone: '+919812345605',
        fields: Array.from({ length: 200 }, (_, i) => ({ name: `q_${i}`, values: ['x'.repeat(4000)] })),
      }),
    );
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: result.leadId! } });
    const attrs = lead.attributes as { metaLeadForm?: { values: string[] }[] } | null;
    expect(attrs?.metaLeadForm?.length).toBeLessThanOrEqual(40);
    expect(attrs?.metaLeadForm?.[0].values[0].length).toBeLessThanOrEqual(500);
  }, 60_000);

  it('refuses rather than guessing a branch when a tenant has several and no rule matches', async () => {
    const result = await sink.acceptMetaLead(
      record({ organisationId: B.org, integrationId: B.integ, leadgenId: 'lg_b1', phone: '+919812345610' }),
    );
    // Filing a Chennai enquiry against Delhi is worse than not filing it: Delhi
    // will not chase it and Chennai will never see it.
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/no store|routing rule/i);
    expect(await prisma.lead.count({ where: { organisationId: B.org } })).toBe(0);
  }, 60_000);

  it('never writes tenant A a lead in tenant B', async () => {
    const leaks = await prisma.lead.findMany({ where: { organisationId: B.org } });
    expect(leaks).toHaveLength(0);
    const aLeads = await prisma.lead.findMany({ where: { organisationId: A.org }, select: { storeId: true } });
    expect(aLeads.every((l) => l.storeId === A.store)).toBe(true);
  }, 60_000);

  it('logs no customer contact detail in the activity summary', async () => {
    const events = await prisma.activityEvent.findMany({ where: { organisationId: A.org, type: 'lead.created' } });
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.summary).not.toMatch(/9812345|priya|@example\.com/i);
    }
  }, 60_000);
});

async function teardown(prisma: PrismaService) {
  for (const organisationId of [A.org, B.org]) {
    await prisma.attributionTouch.deleteMany({ where: { organisationId } }).catch(() => undefined);
    await prisma.activityEvent.deleteMany({ where: { organisationId } }).catch(() => undefined);
    await prisma.lead.deleteMany({ where: { organisationId } }).catch(() => undefined);
    await prisma.contactPoint.deleteMany({ where: { organisationId } }).catch(() => undefined);
    await prisma.party.deleteMany({ where: { organisationId } }).catch(() => undefined);
    await prisma.integrationAsset.deleteMany({ where: { organisationId } }).catch(() => undefined);
    await prisma.integration.deleteMany({ where: { organisationId } }).catch(() => undefined);
    await prisma.store.deleteMany({ where: { organisationId } }).catch(() => undefined);
    await prisma.organisation.deleteMany({ where: { id: organisationId } }).catch(() => undefined);
  }
}
