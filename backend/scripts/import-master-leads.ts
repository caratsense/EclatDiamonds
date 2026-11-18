/**
 * Open a lead for each customer imported from the client's master sheet, with
 * the ten-step SOP follow-up schedule behind it.
 *
 * DRY RUN BY DEFAULT. Pass --apply to write.
 *
 *   ROWS_PATH=<json> railway run --service Postgres -- \
 *     node scripts/import-master-leads.mjs [--apply]
 *
 * Runs after import-master-customers.mjs, which created the Party rows. This
 * only ever opens a lead for a customer that already exists and does not have
 * one, so re-running it adds nothing.
 *
 * Decisions this encodes, all taken with the client (18 Nov):
 *   - every imported contact becomes a lead, so managers get reminders;
 *   - the branch comes from the sheet's Store Name, and the 393 website
 *     registrations with no branch go to HEAD OFFICE;
 *   - ten follow-ups each, at 1/3/7/14/30/45/60/90/120/150 days.
 *
 * THE CLOCK STARTS TODAY, not at the original enquiry date. 95% of these
 * enquiries are over a month old and 580 are from August. Counted from the
 * enquiry, almost every one of the ~11,600 follow-ups would be overdue the
 * moment it was written, and a manager who opens the app to 1,800 late tasks
 * stops opening the app. The enquiry date is preserved on the customer record
 * and in the lead's note, where it belongs.
 */
import { readFileSync } from 'node:fs';

import { PrismaClient } from '@prisma/client';

import { MAX_SOP_FOLLOW_UPS, sopFollowUps } from '../src/common/follow-up-cadence';

if (process.env.DATABASE_PUBLIC_URL && /\.railway\.internal/.test(process.env.DATABASE_URL ?? '')) {
  const u = process.env.DATABASE_PUBLIC_URL;
  process.env.DATABASE_URL = u + (u.includes('?') ? '&' : '?') + 'sslmode=require&connect_timeout=30';
}

const APPLY = process.argv.includes('--apply');
const ORG = process.env.AUDIT_ORG_ID ?? 'org_eclat';
const ROWS = process.env.ROWS_PATH;
if (!ROWS) throw new Error('ROWS_PATH is required');

/** Where a contact with no branch of its own goes — the client's choice. */
const FALLBACK_STORE_NAME = 'HEAD OFFICE';

const STORES: Record<string, string> = {
  'Udaipur': 'UDAIPUR ASHOK NAGAR',
  'Pashim Vihar': 'DELHI PASCHIM VIHAR',
  'Hyderabad Broadway': 'BANJARA HILLS HYD',
  'Rohini': 'DELHI ROHINI',
  'Kala Ghoda': 'MUMBAI KALAGHODA',
  'Bandra Broadway': 'MUMBAI BANDRA BROADWAY',
  'Borivali': 'MUMBAI BORIVALI',
  'Bandra': 'MUMBAI BANDRA',
  'Pune': 'PUNE AMANORA MALL',
};

const SOURCES: Record<string, string> = {
  'Meta Ads': 'meta_ads',
  'Walk-in': 'walk_in',
  'Store Personal Callings': 'phone',
  'ig': 'instagram',
  'fb': 'meta_ads',
  'Website': 'website',
};

function normPhone(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const raw = typeof v === 'number' ? String(Math.round(v)) : String(v);
  const d = raw.replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) return d;
  if (d.length === 10) return '91' + d;
  if (d.length === 11 && d.startsWith('0')) return '91' + d.slice(1);
  return null;
}

/** Today at UTC midnight — the day the follow-up clock starts. */
function todayUtc(): Date {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}

async function main() {
  const prisma = new PrismaClient();
  console.log(APPLY ? '=== APPLY ===' : '=== DRY RUN (pass --apply to write) ===');

  const stores = await prisma.store.findMany({
    where: { organisationId: ORG },
    select: { id: true, name: true },
  });
  const byName = Object.fromEntries(stores.map((s) => [s.name, s.id]));
  const fallbackId = byName[FALLBACK_STORE_NAME];
  if (!fallbackId) {
    console.log(`ABORT: no store named "${FALLBACK_STORE_NAME}" to hold branchless contacts.`);
    return prisma.$disconnect();
  }
  const missing = Object.values(STORES).filter((n) => !byName[n]);
  if (missing.length) {
    console.log('ABORT: these branches do not exist:', missing.join(', '));
    return prisma.$disconnect();
  }

  // Sheet rows, keyed by the phone they were imported under.
  const wanted = new Map<string, any>();
  for (const r of JSON.parse(readFileSync(ROWS, 'utf8'))) {
    const phone = normPhone(r.rawPhone);
    if (!phone || !r.name) continue;
    if (wanted.has(phone)) continue; // first occurrence wins, as on the customer import
    wanted.set(phone, {
      phone,
      name: r.name,
      storeId: r.storeLabel ? byName[STORES[r.storeLabel]] : fallbackId,
      branchless: !r.storeLabel,
      source: SOURCES[r.sourceLabel] ?? 'walk_in',
      enquiredAt: r.at ? String(r.at).slice(0, 10) : null,
    });
  }

  // Only customers that exist and have no lead yet.
  const parties = await prisma.party.findMany({
    where: { organisationId: ORG, phone: { in: [...wanted.keys()] } },
    select: { id: true, phone: true, name: true, _count: { select: { leads: true } } },
  });
  const candidates: any[] = [];
  for (const p of parties) {
    const row = wanted.get(p.phone);
    if (!row) continue;
    if (p._count.leads > 0) continue; // already has a lead; never duplicated
    candidates.push({ ...row, partyId: p.id, customerName: p.name ?? row.name });
  }

  const tally: Record<string, number> = {};
  for (const c of candidates) {
    const label = stores.find((s) => s.id === c.storeId)?.name ?? c.storeId;
    tally[label] = (tally[label] ?? 0) + 1;
  }

  console.log(`\ncustomers matched from the sheet   ${parties.length}`);
  console.log(`already have a lead (skipped)      ${parties.length - candidates.length}`);
  console.log(`leads to open                      ${candidates.length}`);
  console.log(`follow-ups to schedule             ${candidates.length * MAX_SOP_FOLLOW_UPS}`);
  console.log('\nby branch:');
  for (const [k, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(n).padStart(5)}  ${k}`);
  }
  const bySource: Record<string, number> = {};
  for (const c of candidates) bySource[c.source] = (bySource[c.source] ?? 0) + 1;
  console.log('\nby source:');
  for (const [k, n] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(n).padStart(5)}  ${k}`);
  }

  const start = todayUtc();
  const sample = sopFollowUps('x', 'y', start);
  console.log(`\nfollow-up schedule, starting ${start.toISOString().slice(0, 10)}:`);
  console.log('   ' + sample.map((f) => f.dueDate.toISOString().slice(5, 10)).join('  '));

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written.');
    return prisma.$disconnect();
  }

  /*
   * Batched, not one transaction per lead. 1,162 sequential transactions over
   * the public proxy exhausted the pool and failed with P2028 before anything
   * useful happened; this is three round trips per 200 leads instead of one
   * per lead.
   *
   * The whole block of refs is reserved in a single atomic step, so the LD-
   * series stays unbroken even though the inserts are batched.
   */
  const reserved = await prisma.$queryRaw<{ next: number }[]>`
    INSERT INTO "DocSequence" ("scope", "next", "updatedAt")
    VALUES ('LD:global', ${candidates.length + 1}, CURRENT_TIMESTAMP)
    ON CONFLICT ("scope") DO UPDATE
      SET "next" = "DocSequence"."next" + ${candidates.length},
          "updatedAt" = CURRENT_TIMESTAMP
    RETURNING "DocSequence"."next" - ${candidates.length} AS "next"
  `;
  const firstRef = Number(reserved[0]?.next ?? 1);
  console.log(`reserved refs LD-${5000 + firstRef} .. LD-${5000 + firstRef + candidates.length - 1}`);

  let leads = 0;
  let followUps = 0;
  const BATCH = 200;
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    const made = await prisma.lead.createManyAndReturn({
      data: batch.map((c, j) => ({
        organisationId: ORG,
        ref: `LD-${5000 + firstRef + i + j}`,
        storeId: c.storeId,
        partyId: c.partyId,
        customerName: c.customerName,
        phone: c.phone,
        source: c.source,
        interest: c.enquiredAt
          ? `Imported from master sheet — enquired ${c.enquiredAt}`
          : 'Imported from master sheet',
      })),
      select: { id: true, storeId: true },
    });
    const fu = made.flatMap((l) =>
      sopFollowUps(l.id, l.storeId, start, 'Imported contact follow-up'),
    );
    await prisma.leadFollowUp.createMany({ data: fu });
    leads += made.length;
    followUps += fu.length;
    process.stdout.write(`  ${leads}/${candidates.length} leads, ${followUps} follow-ups`);
  }
  console.log(`

OPENED ${leads} leads with ${followUps} follow-ups.`);
  console.log(`leads now: ${await prisma.lead.count({ where: { organisationId: ORG } })}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
