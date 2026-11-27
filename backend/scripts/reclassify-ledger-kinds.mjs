/**
 * Re-file ledger postings that were booked as profit and loss but are not.
 *
 * The sync's TranType map now treats branch-to-branch movements and stock
 * purchases as `asset` rather than income/expense (see `syncLedger`). New rows
 * land correctly from the next run, and rows the agent re-pushes are corrected
 * by the upsert — but the Journal is watermarked, so everything already pulled
 * is never pushed again and would keep its old classification forever.
 *
 * On 27 Nov that old classification was Finance's whole problem: ₹1.60 Cr of
 * branch transfers inside one month's "Operating Expense", and branch sales
 * inflating revenue beside them.
 *
 * The TranType is recoverable because the sync writes it into the narration in
 * brackets — "1.5% CGST (JWPH)", or just "(BJWPH)" where there was no remark.
 * Rows whose narration carries no readable type are LEFT ALONE and counted, not
 * guessed at: a posting re-filed on a guess is worse than one left where it is.
 *
 *   node scripts/reclassify-ledger-kinds.mjs
 *   node scripts/reclassify-ledger-kinds.mjs --apply
 */
/*
 * Railway hands services an internal hostname that only resolves inside its
 * network, so a run from a laptop needs the public proxy instead. Opt-in via
 * DATABASE_PUBLIC_URL rather than rewritten unconditionally, so this behaves
 * normally when it runs inside Railway. Same shape as the import scripts.
 */
if (process.env.DATABASE_PUBLIC_URL && /\.railway\.internal/.test(process.env.DATABASE_URL ?? '')) {
  const u = process.env.DATABASE_PUBLIC_URL;
  process.env.DATABASE_URL = u + (u.includes('?') ? '&' : '?') + 'sslmode=require&connect_timeout=30';
}

const { PrismaClient } = await import('@prisma/client');

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

/** Must stay identical to the KIND map in `SyncService.syncLedger`. */
const KIND = {
  JWSL: 'income',
  MSL: 'income',
  JWPH: 'asset',
  MPH: 'asset',
  BJWSL: 'asset',
  BMSL: 'asset',
  BJWPH: 'asset',
  BMPH: 'asset',
  VCH: 'asset',
  JWSR: 'expense',
  BDJOB: 'expense',
};

/*
 * Only rows the SYNC wrote. A ledger entry typed in by hand on the Finance
 * screen has no legacyId and no bracketed TranType, and its kind is somebody's
 * decision rather than a mapping — this must not overwrite it.
 */
const rows = await prisma.ledgerEntry.findMany({
  where: { legacyId: { not: null } },
  select: { id: true, kind: true, narration: true, amount: true },
});

const moves = new Map();
let unreadable = 0;
let alreadyRight = 0;
const toFix = [];

for (const r of rows) {
  const m = /\(([A-Z]+)\)\s*$/.exec(r.narration ?? '');
  const tranType = m?.[1];
  // An unmapped type fell to 'asset' in the sync and still does; that is not a
  // row to move, it is a row already where the map puts it.
  const want = tranType ? (KIND[tranType] ?? 'asset') : null;
  if (!want) {
    unreadable += 1;
    continue;
  }
  if (want === r.kind) {
    alreadyRight += 1;
    continue;
  }
  const key = `${tranType}: ${r.kind} -> ${want}`;
  const acc = moves.get(key) ?? { rows: 0, amount: 0 };
  acc.rows += 1;
  acc.amount += Number(r.amount);
  moves.set(key, acc);
  toFix.push({ id: r.id, kind: want });
}

const inr = (n) => `₹${Math.round(n).toLocaleString('en-IN')}`;
console.log(`${rows.length} synced ledger rows`);
console.log(`  already correct : ${alreadyRight}`);
console.log(`  no readable type: ${unreadable} (left alone)`);
console.log(`  to re-file      : ${toFix.length}`);
for (const [key, acc] of [...moves.entries()].sort()) {
  console.log(`    ${key.padEnd(28)} ${String(acc.rows).padStart(5)} rows  ${inr(acc.amount)}`);
}

if (!toFix.length) {
  console.log('\nNothing to do.');
} else if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply.');
} else {
  // Grouped by target kind so this is a handful of updateMany calls rather than
  // one round trip per posting.
  let written = 0;
  for (const kind of new Set(toFix.map((r) => r.kind))) {
    const ids = toFix.filter((r) => r.kind === kind).map((r) => r.id);
    for (let i = 0; i < ids.length; i += 1000) {
      const batch = ids.slice(i, i + 1000);
      const res = await prisma.ledgerEntry.updateMany({
        where: { id: { in: batch } },
        data: { kind },
      });
      written += res.count;
    }
  }
  console.log(`\nRe-filed ${written} postings.`);
}

await prisma.$disconnect();
