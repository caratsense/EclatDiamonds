#!/usr/bin/env node
/**
 * Fixtures for the browser verification of the connection-administration screens.
 *
 * LOCAL ONLY. It refuses any database whose name is not disposable, for the same
 * reason scripts/test-db.mjs does: this writes integration rows, message rows and
 * spend rows, and none of that belongs anywhere a person could mistake for real.
 *
 * It creates the states the screens exist to distinguish, because a screenshot of
 * an empty table proves nothing:
 *
 *   - an asset registered but never verified, beside one the provider confirmed;
 *   - a template the provider approved, one it paused, one it no longer lists,
 *     and one nobody has ever synchronised;
 *   - outbound messages queued, failed and delivered;
 *   - a lead-fetch job that has given up;
 *   - spend with a day missing from the window, and a row in a second currency;
 *   - consent granted for service and withdrawn for marketing.
 *
 * A second, non-jewellery tenant is created so the universal screens can be seen
 * for a generic business as well as for Eclat.
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const url = process.env.DATABASE_URL ?? '';
const name = decodeURIComponent((url.split('/').pop() ?? '').split('?')[0]);
if (!/_test$|_rehearsal$/.test(name)) {
  console.error(`Refusing to write fixtures into "${name}". Use a _test or _rehearsal database.`);
  process.exit(2);
}

const prisma = new PrismaClient();
const PASSWORD = 'password123';

const ECLAT = { integ: 'ui_int_meta', wa: 'ui_int_wa' };
const GENERIC = {
  org: 'ui_org_generic',
  slug: 'northwind-clinic',
  store: 'ui_store_generic',
  integ: 'ui_int_generic_meta',
  ho: 'head.office@northwind.test',
};

const day = (iso) => new Date(`${iso}T00:00:00.000Z`);
const ago = (days) => new Date(Date.now() - days * 86_400_000);

async function main() {
  const eclat = await prisma.organisation.findFirst({ where: { slug: 'eclat' } });
  if (!eclat) throw new Error('Seed the demo tenant first (node prisma/seed.mjs).');
  const stores = await prisma.store.findMany({
    where: { organisationId: eclat.id, isAggregate: false },
    take: 2,
  });

  // ---------------------------------------------------------------- Eclat
  await prisma.integration.upsert({
    where: { organisationId_providerCode_name: { organisationId: eclat.id, providerCode: 'meta_ads', name: 'Meta Ads' } },
    create: { id: ECLAT.integ, organisationId: eclat.id, providerCode: 'meta_ads', name: 'Meta Ads', status: 'needs_attention', lastError: '1 of 3 assets could not be verified.', lastHealthAt: ago(0.02) },
    update: { status: 'needs_attention', lastError: '1 of 3 assets could not be verified.', lastHealthAt: ago(0.02) },
  });
  await prisma.integration.upsert({
    where: { organisationId_providerCode_name: { organisationId: eclat.id, providerCode: 'whatsapp_cloud', name: 'WhatsApp Business' } },
    create: {
      id: ECLAT.wa, organisationId: eclat.id, providerCode: 'whatsapp_cloud', name: 'WhatsApp Business',
      status: 'connected', lastSyncAt: ago(0.01), config: { whatsappBusinessAccountId: '110022003300' },
    },
    update: { status: 'connected', lastSyncAt: ago(0.01), config: { whatsappBusinessAccountId: '110022003300' } },
  });

  // A stored credential, so the screens show "stored, encrypted" without the
  // encryption key having to be configured for this rehearsal.
  for (const integrationId of [ECLAT.integ, ECLAT.wa]) {
    await prisma.integrationCredential.upsert({
      where: { integrationId_kind: { integrationId, kind: 'access_token' } },
      create: {
        organisationId: eclat.id, integrationId, kind: 'access_token',
        ciphertext: 'aad1:FIXTURE-NOT-A-REAL-TOKEN', iv: 'aXY=', authTag: 'dGFn', lastUsedAt: ago(0.5),
      },
      update: { lastUsedAt: ago(0.5) },
    });
  }

  const assets = [
    { kind: 'page', externalId: '102938475610293', name: 'Eclat Diamonds', verified: true, error: null },
    { kind: 'ad_account', externalId: '556677889900', name: 'Eclat Ads', verified: true, error: null },
    { kind: 'form', externalId: '778899001122', name: 'Bridal enquiry form', verified: false, error: 'Meta Graph HTTP 404: Object does not exist or is not accessible with this token.' },
  ];
  for (const a of assets) {
    await prisma.integrationAsset.upsert({
      where: { integrationId_kind_externalId: { integrationId: ECLAT.integ, kind: a.kind, externalId: a.externalId } },
      create: {
        organisationId: eclat.id, integrationId: ECLAT.integ, kind: a.kind, externalId: a.externalId,
        name: a.name, isActive: true, providerOwnershipVerified: a.verified,
        lastVerifiedAt: ago(0.02), lastError: a.error,
        // An ad account needs its own currency and timezone before spend can be
        // read for it; without them the report refuses rather than assuming.
        metadata: a.kind === 'ad_account'
          ? { accountCurrency: 'INR', accountTimezone: 'Asia/Kolkata' }
          : {},
      },
      update: {
        providerOwnershipVerified: a.verified, lastVerifiedAt: ago(0.02), lastError: a.error,
        metadata: a.kind === 'ad_account'
          ? { accountCurrency: 'INR', accountTimezone: 'Asia/Kolkata' }
          : {},
      },
    });
  }
  const adAccount = await prisma.integrationAsset.findFirstOrThrow({
    where: { integrationId: ECLAT.integ, kind: 'ad_account' },
  });

  const templates = [
    { name: 'order_ready', lang: 'en_US', status: 'APPROVED', syncedAt: ago(0.01), error: null },
    { name: 'seasonal_offer', lang: 'en_US', status: 'PAUSED', syncedAt: ago(0.01), error: 'Provider reports this template as PAUSED.' },
    { name: 'old_reminder', lang: 'en_US', status: 'REMOVED', syncedAt: ago(0.01), error: 'Provider reports this template as REMOVED.' },
    { name: 'appointment_note', lang: 'hi', status: null, syncedAt: null, error: null },
  ];
  for (const t of templates) {
    await prisma.integrationAsset.upsert({
      where: { integrationId_kind_externalId: { integrationId: ECLAT.wa, kind: 'message_template', externalId: t.name } },
      create: {
        organisationId: eclat.id, integrationId: ECLAT.wa, kind: 'message_template',
        externalId: t.name, name: t.name, isActive: true,
        providerOwnershipVerified: t.status === 'APPROVED',
        lastVerifiedAt: t.syncedAt, lastError: t.error,
        metadata: {
          channel: 'whatsapp', languageCode: t.lang, category: 'utility',
          approvalStatus: 'pending', variables: [], recordedAt: ago(20).toISOString(),
          ...(t.status ? { providerStatus: t.status, providerSyncedAt: t.syncedAt.toISOString() } : {}),
        },
      },
      update: {
        providerOwnershipVerified: t.status === 'APPROVED',
        lastVerifiedAt: t.syncedAt, lastError: t.error,
      },
    });
  }

  // Spend: a five-day window with the middle day never fetched, plus one row in
  // a second currency so the mismatch banner has something true to report.
  await prisma.adSpendDaily.deleteMany({ where: { organisationId: eclat.id } });
  await prisma.adSpendCoverage.deleteMany({ where: { organisationId: eclat.id } });
  const dates = ['2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08'];
  const campaigns = [
    { id: '120210000000001', label: 'Always-on enquiries', spend: ['4200.00', '3980.50', '4310.00', '4025.75', '3890.20'] },
    { id: '120210000000002', label: 'Weekend push', spend: ['1500.00', '1620.00', '1480.00', '1710.00', '1550.00'] },
  ];
  for (const [i, date] of dates.entries()) {
    for (const c of campaigns) {
      await prisma.adSpendDaily.create({
        data: {
          organisationId: eclat.id, integrationId: ECLAT.integ, adAccountAssetId: adAccount.id,
          externalAccountId: adAccount.externalId, externalCampaignId: c.id, campaignName: c.label,
          date: day(date), timezone: 'Asia/Kolkata', currency: 'INR', spend: c.spend[i],
          impressions: BigInt(48_000 + i * 1_100), clicks: BigInt(900 + i * 30),
          fetchedAt: ago(1), jobId: 'fixture',
        },
      });
    }
    // The middle day is deliberately never marked covered.
    if (date !== '2026-09-06') {
      await prisma.adSpendCoverage.create({
        data: {
          organisationId: eclat.id, integrationId: ECLAT.integ, adAccountAssetId: adAccount.id,
          externalAccountId: adAccount.externalId, date: day(date), timezone: 'Asia/Kolkata',
          currency: 'INR', completedAt: ago(1), jobId: 'fixture',
        },
      });
    }
  }
  await prisma.adSpendDaily.create({
    data: {
      organisationId: eclat.id, integrationId: ECLAT.integ, adAccountAssetId: adAccount.id,
      externalAccountId: adAccount.externalId, externalCampaignId: '120210000000003',
      campaignName: 'Overseas test', date: day('2026-09-05'), timezone: 'Asia/Kolkata',
      currency: 'USD', spend: '48.00', impressions: 900n, clicks: 12n, fetchedAt: ago(1), jobId: 'fixture-usd',
    },
  });

  // Outbox: one of each state that matters, plus a dead delivery job.
  const party = await prisma.party.findFirst({ where: { organisationId: eclat.id, types: { has: 'customer' } } });
  if (party && stores.length) {
    const conversation = await prisma.conversation.upsert({
      where: { organisationId_channel_externalThreadId: { organisationId: eclat.id, channel: 'whatsapp', externalThreadId: 'ui-verify-thread' } },
      create: { organisationId: eclat.id, storeId: stores[0].id, partyId: party.id, channel: 'whatsapp', externalThreadId: 'ui-verify-thread' },
      update: {},
    }).catch(async () => prisma.conversation.findFirstOrThrow({ where: { organisationId: eclat.id, externalThreadId: 'ui-verify-thread' } }));

    await prisma.message.deleteMany({ where: { conversationId: conversation.id } });
    const outbound = [
      { status: 'delivered', body: 'Your order is ready for collection.', error: null },
      { status: 'queued', body: 'Thank you for visiting us today.', error: null },
      { status: 'failed', body: 'A quick note about your enquiry.', error: 'No messaging integration is connected for this channel.' },
    ];
    for (const m of outbound) {
      await prisma.message.create({
        data: {
          organisationId: eclat.id, conversationId: conversation.id, direction: 'outbound',
          authorType: 'agent', body: m.body, status: m.status, error: m.error,
          payload: { omnichannel: { purpose: 'service', queuedAt: ago(0.1).toISOString() } },
        },
      });
    }

    await prisma.activityEvent.deleteMany({
      where: { organisationId: eclat.id, type: { in: ['consent.granted', 'consent.revoked'] }, partyId: party.id },
    });
    for (const c of [
      { type: 'consent.granted', purpose: 'service', when: ago(30) },
      { type: 'consent.granted', purpose: 'marketing', when: ago(20) },
      { type: 'consent.revoked', purpose: 'marketing', when: ago(3) },
    ]) {
      await prisma.activityEvent.create({
        data: {
          organisationId: eclat.id, storeId: stores[0].id, partyId: party.id,
          type: c.type, summary: `whatsapp ${c.purpose} consent ${c.type.split('.')[1]}`,
          entityType: 'Party', entityId: party.id, channel: 'whatsapp',
          occurredAt: c.when, metadata: { purpose: c.purpose, source: 'staff' },
        },
      });
    }
  }

  await prisma.jobTask.deleteMany({ where: { organisationId: eclat.id, kind: { startsWith: 'meta' } } });
  await prisma.jobTask.createMany({
    data: [
      {
        organisationId: eclat.id, kind: 'meta.lead_ads.fetch', status: 'dead', attempts: 5, maxAttempts: 5,
        runAt: ago(1), idempotencyKey: 'fixture:lead:dead:1',
        payload: { leadgenId: 'lg_fixture_1' },
        lastError: 'No ad-set routing rule matched and the organisation has more than one store to file the lead against.',
      },
      {
        organisationId: eclat.id, kind: 'meta.lead_ads.fetch', status: 'failed', attempts: 2, maxAttempts: 5,
        runAt: ago(0.02), idempotencyKey: 'fixture:lead:failed:1',
        payload: { leadgenId: 'lg_fixture_2' },
        lastError: 'Meta Graph HTTP 190: Error validating access token: Session has expired.',
      },
      {
        organisationId: eclat.id, kind: 'meta.lead_ads.fetch', status: 'succeeded', attempts: 1, maxAttempts: 5,
        runAt: ago(2), idempotencyKey: 'fixture:lead:ok:1', payload: { leadgenId: 'lg_fixture_3' },
      },
    ],
  });

  // -------------------------------------------------------------- Generic
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await prisma.organisation.upsert({
    where: { id: GENERIC.org },
    create: {
      id: GENERIC.org, name: 'Northwind Clinic', slug: GENERIC.slug,
      industryPackCode: 'healthcare', country: 'IN', currency: 'INR', timezone: 'Asia/Kolkata',
    },
    update: {},
  });
  await prisma.store.upsert({
    where: { id: GENERIC.store },
    create: { id: GENERIC.store, name: 'Northwind — Central', city: 'Pune', timezone: 'Asia/Kolkata', organisationId: GENERIC.org },
    update: {},
  });
  await prisma.user.upsert({
    where: { email: GENERIC.ho },
    create: {
      email: GENERIC.ho, name: 'Northwind Head Office', role: 'head_office', passwordHash,
      isActive: true, approvalStatus: 'approved', organisationId: GENERIC.org,
      userStores: { create: { storeId: GENERIC.store, isPrimary: true } },
    },
    update: { passwordHash, isActive: true, approvalStatus: 'approved' },
  });
  await prisma.integration.upsert({
    where: { organisationId_providerCode_name: { organisationId: GENERIC.org, providerCode: 'meta_ads', name: 'Meta Ads' } },
    create: { id: GENERIC.integ, organisationId: GENERIC.org, providerCode: 'meta_ads', name: 'Meta Ads', status: 'not_configured' },
    update: { status: 'not_configured' },
  });

  // The welcome tour is server-side state. Retire it for the verification
  // accounts so it does not sit on top of every screenshot.
  await prisma.user.updateMany({
    where: { organisationId: { in: [eclat.id, GENERIC.org] } },
    data: { tourDoneAt: new Date() },
  });

  console.log('UI verification fixtures written.');
  console.log(`  Eclat head office : head.office@caratsense.in / ${PASSWORD}`);
  console.log(`  Generic tenant    : ${GENERIC.ho} / ${PASSWORD}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
