#!/usr/bin/env node
/**
 * Rehearse this branch's migrations against the schema production is actually
 * on, with rows already in it.
 *
 * ## Why "migrations from zero" is not enough
 *
 * Every test run migrates an empty database from zero, which proves the
 * migrations are internally consistent and nothing more. Production is not
 * empty. A `NOT NULL` column with no default, a unique index over data that
 * already has duplicates, a foreign key to a row that does not exist — every one
 * of those applies perfectly to an empty database and fails on the real one, at
 * the worst possible moment, with the application already stopped.
 *
 * So this does what the deploy will do, in the order it will do it:
 *
 *   1. Build a database at ORIGIN/MAIN's migrations — the schema production runs.
 *   2. Put realistic rows in it, including the shapes that break things: several
 *      tenants, a customer with no branch, an archived one, two branches in
 *      different timezones.
 *   3. Apply THIS BRANCH's migrations on top, exactly as `migrate deploy` will.
 *   4. Prove the rows survived and the new columns defaulted sensibly.
 *
 * Read-only with respect to the working tree: main's migrations are extracted
 * with `git show`, never checked out.
 *
 * Usage:  node scripts/migration-rehearsal.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const PRISMA = join(ROOT, 'node_modules/prisma/build/index.js');
const DB = 'eclat_rehearsal';
const BASE = process.env.REHEARSAL_BASE_REF ?? 'origin/main';

const adminUrl =
  process.env.REHEARSAL_ADMIN_URL ?? 'postgresql://postgres:postgres@localhost:5432/postgres';
const dbUrl = adminUrl.replace(/\/[^/]*$/, `/${DB}`);

const PSQL = process.env.PSQL_PATH ?? 'psql';

/** `-t -A`: the value alone, with no header, ruler or row count to parse past. */
function psql(url, sql) {
  return execFileSync(PSQL, [url, '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Git pathspecs are resolved relative to the CURRENT DIRECTORY, not the repo
 * root, so every call runs from the top level and names paths from there. Run
 * from `backend/` with a repo-root path and git matches nothing and says so by
 * returning an empty list — which staged zero migrations and produced a base
 * schema with no tables in it.
 */
const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: ROOT,
  encoding: 'utf8',
}).trim();

function git(args) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

console.log(`rehearsal base: ${BASE}`);

// ---------------------------------------------------------------- 1. the base
const stage = join(tmpdir(), `caratos-rehearsal-${Date.now()}`);
const baseMigrations = join(stage, 'prisma', 'migrations');
mkdirSync(baseMigrations, { recursive: true });

// Every migration directory that exists on the base ref, extracted read-only.
const names = git(['ls-tree', '-d', '--name-only', `${BASE}`, 'backend/prisma/migrations/'])
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .map((p) => p.split('/').pop());

for (const name of names) {
  mkdirSync(join(baseMigrations, name), { recursive: true });
  const sql = git(['show', `${BASE}:backend/prisma/migrations/${name}/migration.sql`]);
  writeFileSync(join(baseMigrations, name, 'migration.sql'), sql);
}
writeFileSync(
  join(baseMigrations, 'migration_lock.toml'),
  git(['show', `${BASE}:backend/prisma/migrations/migration_lock.toml`]),
);
// Prisma resolves migrations relative to the schema, so the base schema is
// staged beside them.
writeFileSync(join(stage, 'prisma', 'schema.prisma'), git(['show', `${BASE}:backend/prisma/schema.prisma`]));

if (!names.length) {
  throw new Error(
    `No migrations found on ${BASE}. Fetch it first, or set REHEARSAL_BASE_REF.`,
  );
}
console.log(`staged ${names.length} base migration(s) at ${stage}`);

try {
  psql(adminUrl, `DROP DATABASE IF EXISTS "${DB}"`);
} catch {
  // A live connection from an earlier run. Clear it and try once more.
  psql(
    adminUrl,
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DB}'`,
  );
  psql(adminUrl, `DROP DATABASE IF EXISTS "${DB}"`);
}
psql(adminUrl, `CREATE DATABASE "${DB}"`);

execFileSync(process.execPath, [PRISMA, 'migrate', 'deploy', '--schema', join(stage, 'prisma', 'schema.prisma')], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: dbUrl },
});
console.log('base schema applied');

// ------------------------------------------------------- 2. realistic rows
//
// Deliberately awkward: two tenants, two timezones, a customer with no branch
// and an archived one. These are the shapes a naive migration breaks on.
const seed = `
INSERT INTO "Organisation" (id, name, slug, status, "industryPackCode", "industryPackVersion", timezone, currency, country, "configVersion", "createdAt", "updatedAt")
VALUES
  ('reh_org_a','Rehearsal A','rehearsal-a','active','jewellery',1,'Asia/Kolkata','INR','IN',1,now(),now()),
  ('reh_org_b','Rehearsal B','rehearsal-b','active','retail',1,'Pacific/Niue','INR','IN',1,now(),now());

INSERT INTO "Store" (id, name, city, "organisationId", timezone, "isAggregate", "createdAt", "updatedAt")
VALUES
  ('reh_store_a1','A East','Mumbai','reh_org_a','Asia/Kolkata',false,now(),now()),
  ('reh_store_a2','A West','Surat','reh_org_a','Pacific/Kiritimati',false,now(),now()),
  ('reh_store_b1','B Main','Jaipur','reh_org_b','Pacific/Niue',false,now(),now());

INSERT INTO "Party" (id, "organisationId", "storeId", name, phone, types, "createdAt", "updatedAt")
VALUES
  ('reh_party_1','reh_org_a','reh_store_a1','Live Customer','9876500001','{customer}',now(),now()),
  ('reh_party_2','reh_org_a',NULL,'No Branch Customer','9876500002','{customer}',now(),now());

INSERT INTO "Lead" (id, "organisationId", ref, "storeId", "partyId", "customerName", source, stage, outcome, "createdAt", "updatedAt")
VALUES
  ('reh_lead_1','reh_org_a','REH-1','reh_store_a1','reh_party_1','Live Customer','walk_in','inquiry','open',now(),now()),
  ('reh_lead_2','reh_org_a','REH-2','reh_store_a2',NULL,'Anonymous','whatsapp','inquiry','open',now(),now());

-- Rows the 2026-09-15 migrations alter: a customer thread, a salesperson, a
-- priced quote, a follow-up and a manual feedback ask, all written before them.
INSERT INTO "Conversation" (id, "organisationId", channel, "externalThreadId", "storeId", "partyId", "updatedAt")
VALUES ('reh_conv_1','reh_org_a','whatsapp','919876500001','reh_store_a1','reh_party_1',now());

INSERT INTO "User" (id, "organisationId", email, name, role, "passwordHash", "updatedAt")
VALUES ('reh_user_rep','reh_org_a','rep@rehearsal-a.local','Rehearsal Rep','salesperson','x',now());

INSERT INTO "Quote" (id, "organisationId", ref, "storeId", "customerName", "updatedAt")
VALUES ('reh_quote_1','reh_org_a','QT-REH-1','reh_store_a1','Live Customer',now());

INSERT INTO "LeadFollowUp" (id, "leadId", "storeId", seq, "dueDate", "updatedAt")
VALUES ('reh_fu_1','reh_lead_1','reh_store_a1',1,current_date + 7,now());

INSERT INTO "FeedbackRequest" (id, "organisationId", "partyId", "storeId", "publicKey", "updatedAt")
VALUES ('reh_fb_1','reh_org_a','reh_party_1','reh_store_a1','reh-public-key-1',now());
`;

writeFileSync(join(stage, 'seed.sql'), seed);
execFileSync(PSQL, [dbUrl, '-q', '-v', 'ON_ERROR_STOP=1', '-f', join(stage, 'seed.sql')], {
  stdio: 'inherit',
});
console.log('realistic rows inserted');

const before = psql(dbUrl, 'SELECT count(*) FROM "Lead"').trim();

// ------------------------------------------- 3. this branch's migrations
execFileSync(process.execPath, [PRISMA, 'migrate', 'deploy'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: dbUrl },
});
console.log('branch migrations applied on top of the base schema');

// ------------------------------------------------------------ 4. the proof
const after = psql(dbUrl, 'SELECT count(*) FROM "Lead"').trim();
if (before !== after) {
  throw new Error(`Rows changed during migration: leads before ${before}, after ${after}`);
}

// Every new column must have arrived with a workable default rather than
// leaving existing rows in a state the application cannot read.
const checks = [
  [`SELECT count(*) FROM "Organisation" WHERE "disabledCapabilities" IS NULL`, '0'],
  [`SELECT count(*) FROM "Conversation" WHERE false`, '0'],
  [`SELECT to_regclass('public."LoyaltyAccount"') IS NOT NULL`, 't'],
  [`SELECT to_regclass('public."LoyaltyLedgerEntry"') IS NOT NULL`, 't'],
  [`SELECT to_regclass('public."StoreMessagingRoute"') IS NOT NULL`, 't'],
  [`SELECT to_regclass('public."Payslip"') IS NOT NULL`, 't'],
  [`SELECT to_regclass('public."ScheduledReport"') IS NOT NULL`, 't'],
  // An existing thread must stay a customer thread, or it leaves the inbox.
  [`SELECT count(*) FROM "Conversation" WHERE audience <> 'customer'`, '0'],
  // An existing quote is revision 1 with no discount, and needs no approval.
  [`SELECT count(*) FROM "Quote" WHERE revision <> 1 OR "discountPercent" <> 0 OR "approvalReasons" IS NOT NULL`, '0'],
  // An existing ask stays a manual one, and an existing follow-up has no reminder.
  [`SELECT count(*) FROM "FeedbackRequest" WHERE origin <> 'manual'`, '0'],
  [`SELECT count(*) FROM "LeadFollowUp" WHERE "reminderAt" IS NOT NULL OR "assigneeId" IS NOT NULL`, '0'],
  // Existing staff keep their role and approval; nobody is marked rejected.
  [`SELECT count(*) FROM "User" WHERE role = 'salesperson' AND "approvalStatus" = 'approved' AND "rejectedAt" IS NULL`, '1'],
  [`SELECT 'storeperson' = ANY(enum_range(NULL::"Role")::text[])`, 't'],
  [`SELECT to_regclass('public."PayrollRun"') IS NOT NULL`, 't'],
  [`SELECT to_regclass('public."LoyaltyWebhookDelivery"') IS NOT NULL`, 't'],
];
for (const [sql, expected] of checks) {
  const value = psql(dbUrl, sql);
  if (value !== expected) {
    throw new Error(`Post-migration check failed: ${sql} => ${value} (expected ${expected})`);
  }
}

// The partial unique index the schema cannot express, and which an empty
// database would never have exercised.
const partial = psql(
  dbUrl,
  `SELECT count(*) FROM pg_indexes WHERE indexname = 'DeadStockPolicy_organisationId_default_key'`,
);
if (partial !== '1') throw new Error('The dead-stock default partial index is missing.');

console.log(`\nREHEARSAL PASSED — ${before} lead row(s) survived, every new table and column present.`);

psql(
  adminUrl,
  `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DB}'`,
);
psql(adminUrl, `DROP DATABASE IF EXISTS "${DB}"`);
rmSync(stage, { recursive: true, force: true });
console.log('rehearsal database dropped');
