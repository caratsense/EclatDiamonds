#!/usr/bin/env node
/**
 * Create (or reuse) a disposable test database, migrate it from zero, and print
 * the URL for Jest to use.
 *
 * ## The guard, and why it is the whole point
 *
 * This script drops databases. The single most valuable thing it does is REFUSE
 * to drop one whose name does not end in an approved suffix. `eclat_dev`,
 * `eclat_preview` and anything in production cannot be named here, no matter
 * what is in the environment — the check is on the RESOLVED name, so an
 * unexpected `.env`, a stale shell variable or a typo all fail closed.
 *
 * ## Usage
 *
 *   node scripts/test-db.mjs setup     # create + migrate, prints the URL
 *   node scripts/test-db.mjs url       # print the URL only
 *   node scripts/test-db.mjs drop      # remove it
 *
 * Set TEST_DATABASE_URL to override the target. See .env.test.example.
 * No password is ever printed: only the database NAME is echoed.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/** A name must END with one of these to be droppable. Deliberately short. */
const APPROVED_SUFFIXES = ['_test', '_rehearsal'];

/** Never touchable, even if somebody adds a matching suffix by accident. */
const NEVER = ['eclat_dev', 'eclat_preview', 'postgres', 'template0', 'template1'];

function readEnvFile(name) {
  const p = join(ROOT, name);
  if (!existsSync(p)) return {};
  const out = {};
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  return out;
}

function resolveUrl() {
  const fromEnv = process.env.TEST_DATABASE_URL || readEnvFile('.env.test').TEST_DATABASE_URL;
  if (fromEnv) return fromEnv;

  // Derive from the dev URL by swapping ONLY the database name. Credentials and
  // host are reused; nothing about them is printed.
  const base = process.env.DATABASE_URL || readEnvFile('.env').DATABASE_URL;
  if (!base) {
    throw new Error('No TEST_DATABASE_URL and no DATABASE_URL to derive one from. See .env.test.example.');
  }
  return base.replace(/\/[^/?]+(\?.*)?$/, '/eclat_ci_test$1');
}

function dbNameOf(url) {
  const m = /\/([^/?]+)(\?.*)?$/.exec(url);
  if (!m) throw new Error('Could not read a database name from the URL.');
  return m[1];
}

function adminUrlOf(url) {
  return url.replace(/\/[^/?]+(\?.*)?$/, '/postgres');
}

function resolvePsql() {
  if (process.env.PSQL_PATH) {
    if (!existsSync(process.env.PSQL_PATH)) {
      throw new Error('PSQL_PATH is set but does not point to an existing file.');
    }
    return process.env.PSQL_PATH;
  }
  if (process.platform !== 'win32') return 'psql';

  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const postgresRoot = join(programFiles, 'PostgreSQL');
  if (!existsSync(postgresRoot)) return 'psql';
  const versions = readdirSync(postgresRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    const candidates = [
      join(postgresRoot, version, 'bin', 'psql.exe'),
      join(postgresRoot, version, 'pgAdmin 4', 'runtime', 'psql.exe'),
    ];
    const found = candidates.find((candidate) => existsSync(candidate));
    if (found) return found;
  }
  return 'psql';
}

/** The safety check. Throws unless this name is unambiguously disposable. */
function assertDisposable(name) {
  if (NEVER.includes(name)) {
    throw new Error(`Refusing to touch "${name}" — it is on the never-touch list.`);
  }
  if (!APPROVED_SUFFIXES.some((s) => name.endsWith(s))) {
    throw new Error(
      `Refusing to create or drop "${name}": a disposable database must end in ` +
        `${APPROVED_SUFFIXES.join(' or ')}. This guard is what stops a typo or a ` +
        `stale environment variable from resetting a real database.`,
    );
  }
}

function psql(url, sql) {
  execFileSync(resolvePsql(), [url.replace(/\?.*$/, ''), '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

const command = process.argv[2] || 'setup';
const url = resolveUrl();
const name = dbNameOf(url);

if (command === 'url') {
  process.stdout.write(url + '\n');
  process.exit(0);
}

assertDisposable(name);

if (command === 'drop') {
  psql(adminUrlOf(url), `DROP DATABASE IF EXISTS "${name}"`);
  console.log(`dropped disposable database: ${name}`);
  process.exit(0);
}

if (command !== 'setup') {
  console.error(`Unknown command "${command}". Use setup | url | drop.`);
  process.exit(1);
}

psql(adminUrlOf(url), `DROP DATABASE IF EXISTS "${name}"`);
psql(adminUrlOf(url), `CREATE DATABASE "${name}"`);
console.log(`created disposable database: ${name}`);

// Migrate from zero. `migrate deploy`, never `db push` — the point is to prove
// the committed migration chain builds this schema.
execFileSync(process.execPath, [join(ROOT, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'], {
  cwd: ROOT,
  env: { ...process.env, DATABASE_URL: url },
  stdio: 'inherit',
});

console.log(`migrated from zero: ${name}`);
console.log('Run the suite with:');
console.log('  npm run test:e2e:isolated');
