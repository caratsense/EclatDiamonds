/**
 * Import the client's master customer sheet.
 *
 * DRY RUN BY DEFAULT. Pass --apply to write.
 *
 *   SHEET_PATH=<xlsx> railway run --service Postgres -- \
 *     node scripts/import-master-customers.mjs [--apply]
 *
 * Source: "Customers from Master sheet.xlsx", two sheets —
 *   "From Master sheet"  835 rows: Date, Customer Name, Contact No (Lead),
 *                                  Lead Source 1, Store Name
 *   "From website"       427 rows: Registered On, First/Last Name, Phone, City
 *
 * Creates CUSTOMERS (Party) only. The master sheet also carries a date, a
 * source and a branch per row, which would support opening a lead for each —
 * that is a separate decision and deliberately not done here, because a lead
 * enters the sales pipeline and someone owns it.
 *
 * Phone handling
 * --------------
 * Excel hands numbers back as floats, so `String(v)` on 8888155700 can give
 * "8888155700.0" and match nothing. Every value is rounded to an integer
 * first. A 10-digit number starting 91 is a normal Indian mobile, NOT a
 * country code, so the prefix is only honoured at 12 digits.
 *
 * Nothing is overwritten. A phone already present in production is skipped
 * rather than merged, because the existing row may carry a Gati legacyId,
 * conversation history or a lead, and none of that should be rewritten from a
 * spreadsheet.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');
const ORG = process.env.AUDIT_ORG_ID ?? 'org_eclat';
/**
 * The rows, already flattened out of the workbook by
 * scripts/sheet-to-json.mjs. Kept separate because SheetJS lives in the
 * frontend's dependencies and Prisma in the backend's; one step per package
 * beats teaching either to reach into the other.
 */
const ROWS = process.env.ROWS_PATH;
const REPORT = process.env.REPORT_PATH;
if (!ROWS) throw new Error('ROWS_PATH is required');

/** Branch names as the client writes them -> the store ids in CaratSpace. */
const STORES = {
  'Udaipur': 'udaipur',
  'Pashim Vihar': 'DELHI PASCHIM VIHAR',          // resolved by name below
  'Hyderabad Broadway': 'BANJARA HILLS HYD',      // confirmed by the client
  'Rohini': 'delhi',
  'Kala Ghoda': 'mumbai-kala-ghoda',
  'Bandra Broadway': 'MUMBAI BANDRA BROADWAY',
  'Borivali': 'mumbai-borivali',
  'Bandra': 'mumbai-bandra',
  'Pune': 'PUNE AMANORA MALL',
};

/** The sheet's words -> the LeadSource the CRM filters on. */
const SOURCES = {
  'Meta Ads': 'meta_ads',
  'Walk-in': 'walk_in',
  'Store Personal Callings': 'phone',
  'ig': 'instagram',
  'fb': 'meta_ads',
  'Website': 'website',
};

export function normPhone(v) {
  if (v === null || v === undefined || v === '') return null;
  const raw = typeof v === 'number' ? String(Math.round(v)) : String(v);
  const d = raw.replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) return d;
  if (d.length === 10) return '91' + d; // includes mobiles that begin 91
  if (d.length === 11 && d.startsWith('0')) return '91' + d.slice(1);
  return null;
}

/*
 * Railway hands services an internal hostname that only resolves inside its
 * network, so a run from a laptop needs the public proxy instead. Opt-in via
 * DATABASE_PUBLIC_URL rather than rewritten unconditionally, so this behaves
 * normally when it runs inside Railway.
 */
if (process.env.DATABASE_PUBLIC_URL && /\.railway\.internal/.test(process.env.DATABASE_URL ?? '')) {
  const u = process.env.DATABASE_PUBLIC_URL;
  process.env.DATABASE_URL = u + (u.includes('?') ? '&' : '?') + 'sslmode=require&connect_timeout=30';
}

async function main() {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  console.log(APPLY ? '=== APPLY ===' : '=== DRY RUN (pass --apply to write) ===');

  // Resolve every configured branch to a real store id, by id or by name.
  const stores = await prisma.store.findMany({
    where: { organisationId: ORG },
    select: { id: true, name: true },
  });
  const storeId = (label) => {
    const want = STORES[label];
    if (!want) return null;
    const hit = stores.find((s) => s.id === want) ?? stores.find((s) => s.name === want);
    return hit?.id ?? null;
  };
  const unresolved = Object.keys(STORES).filter((k) => !storeId(k));
  if (unresolved.length) {
    console.log('ABORT: these branches do not resolve to a store:', unresolved.join(', '));
    return prisma.$disconnect();
  }

  const rows = JSON.parse(readFileSync(ROWS, 'utf8')).map((r) => ({
    ...r,
    phone: normPhone(r.rawPhone),
    source: r.sheet === 'website' ? 'website' : (SOURCES[r.sourceLabel] ?? null),
    at: r.at ? new Date(r.at) : null,
  }));

  const rejected = rows.filter((r) => !r.phone || !r.name);
  const usable = rows.filter((r) => r.phone && r.name);

  // First occurrence wins; the sheet repeats a number when somebody enquired twice.
  const unique = new Map();
  for (const r of usable) if (!unique.has(r.phone)) unique.set(r.phone, r);

  // Skip anything production already knows, by phone or WhatsApp number.
  const existing = await prisma.party.findMany({
    where: { organisationId: ORG },
    select: { phone: true, whatsapp: true },
  });
  const known = new Set();
  for (const e of existing) for (const v of [e.phone, e.whatsapp]) {
    const n = normPhone(v);
    if (n) known.add(n);
  }

  const toCreate = [...unique.values()].filter((r) => !known.has(r.phone));
  const skipped = [...unique.values()].filter((r) => known.has(r.phone));

  const tally = (list, key) => {
    const m = {};
    for (const r of list) m[r[key] ?? '(none)'] = (m[r[key] ?? '(none)'] ?? 0) + 1;
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  };

  console.log('\nFILE');
  console.log(`  rows                    ${rows.length}`);
  console.log(`  unusable (phone/name)   ${rejected.length}`);
  console.log(`  repeated within file    ${usable.length - unique.size}`);
  console.log('\nAGAINST PRODUCTION');
  console.log(`  already present         ${skipped.length}  (skipped, never overwritten)`);
  console.log(`  to create               ${toCreate.length}`);
  console.log('\nTO CREATE, by branch:');
  for (const [k, n] of tally(toCreate, 'storeLabel')) console.log(`   ${String(n).padStart(5)}  ${k}`);
  console.log('\nTO CREATE, by source:');
  for (const [k, n] of tally(toCreate, 'source')) console.log(`   ${String(n).padStart(5)}  ${k}`);

  if (rejected.length) {
    console.log('\nUNUSABLE — needs a human (digit counts only, no numbers printed):');
    for (const r of rejected) {
      const d = String(r.rawPhone ?? '').replace(/\D/g, '').length;
      console.log(`   ${r.sheet.padEnd(8)} name=${r.name ? 'yes' : 'MISSING'}  phoneDigits=${d}`);
    }
  }

  if (REPORT) {
    writeFileSync(REPORT, JSON.stringify({ toCreate, skipped, rejected }, null, 1));
    console.log(`\nfull report written: ${REPORT}`);
  }

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written.');
    return prisma.$disconnect();
  }

  let made = 0;
  for (let i = 0; i < toCreate.length; i += 200) {
    const batch = toCreate.slice(i, i + 200);
    const res = await prisma.party.createMany({
      data: batch.map((r) => ({
        organisationId: ORG,
        name: r.name,
        phone: r.phone,
        whatsapp: r.phone,
        city: r.city,
        storeId: r.storeLabel ? storeId(r.storeLabel) : null,
        // `source` is a Lead field, not a Party one. It is kept in the report
        // and belongs on the lead when one is opened for this customer.
        ...(r.at ? { createdAt: r.at } : {}),
      })),
      skipDuplicates: true,
    });
    made += res.count;
    process.stdout.write(`  created ${made}/${toCreate.length}\r`);
  }
  console.log(`\n\nCREATED ${made} customers.`);
  console.log(`customers now: ${await prisma.party.count({ where: { organisationId: ORG } })}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
