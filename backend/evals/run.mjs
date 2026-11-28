/**
 * Run the data assertions against a live database and say what is true.
 *
 * READ ONLY. Every check is a query; nothing here writes, and nothing here
 * sends. It is safe to point at production, which is the only place most of
 * these have anything to say — the failures they exist to catch were all in
 * real data, not in seeded fixtures.
 *
 *   node evals/run.mjs                 # every organisation
 *   node evals/run.mjs --org org_eclat # one
 *   node evals/run.mjs --json          # for CI
 *
 * Against Railway from a laptop:
 *   railway run --service Postgres node evals/run.mjs
 *
 * Exit code is 1 when any check fails, so this can gate a deploy.
 */
if (process.env.DATABASE_PUBLIC_URL && /\.railway\.internal/.test(process.env.DATABASE_URL ?? '')) {
  const u = process.env.DATABASE_PUBLIC_URL;
  process.env.DATABASE_URL = u + (u.includes('?') ? '&' : '?') + 'sslmode=require&connect_timeout=30';
}

const { PrismaClient } = await import('@prisma/client');
const { CHECKS } = await import('./checks.mjs');

const prisma = new PrismaClient();
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
};
const ONLY_ORG = arg('org');
const AS_JSON = process.argv.includes('--json');

const orgs = await prisma.organisation.findMany({
  where: ONLY_ORG ? { id: ONLY_ORG } : {},
  select: { id: true, name: true, settings: true },
  orderBy: { name: 'asc' },
});

const results = [];
for (const org of orgs) {
  for (const check of CHECKS) {
    let outcome;
    try {
      outcome = await check.run(prisma, org);
    } catch (e) {
      /*
       * A check that throws is a failed check, not a crashed run. The whole
       * point is to finish and report everything — a suite that stops at the
       * first problem tells you about one problem.
       */
      outcome = { ok: false, detail: `check could not run: ${e.message}` };
    }
    results.push({ org: org.name, id: check.id, why: check.why, ...outcome });
  }
}

const failed = results.filter((r) => !r.ok);

if (AS_JSON) {
  console.log(JSON.stringify({ checked: results.length, failed: failed.length, results }, null, 2));
} else {
  let org = null;
  for (const r of results) {
    if (r.org !== org) {
      org = r.org;
      console.log(`\n${org}`);
    }
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.id.padEnd(38)} ${r.detail}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('\nWhat each failure is about:');
    for (const f of failed) {
      console.log(`\n  ${f.id}`);
      console.log(`    now : ${f.detail}`);
      console.log(`    why : ${f.why.replace(/\s+/g, ' ')}`);
    }
  }
}

await prisma.$disconnect();
process.exit(failed.length ? 1 : 0);
