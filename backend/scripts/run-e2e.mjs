#!/usr/bin/env node
/**
 * Run the e2e suite against the disposable test database.
 *
 * Reuses scripts/test-db.mjs for BOTH the URL and its safety guard, so there is
 * exactly one place that decides which database may be created and dropped.
 *
 * Cleanup is deliberately opt-in via KEEP_TEST_DB=1: after a failure the
 * database is usually the most useful thing you have.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TEST_DB = join(HERE, 'test-db.mjs');

const run = (args, env) =>
  execFileSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });

// Create + migrate from zero. Throws (and stops) if the name is not disposable.
run([TEST_DB, 'setup']);

const url = execFileSync(process.execPath, [TEST_DB, 'url'], { cwd: ROOT }).toString().trim();

// Most legacy suites authenticate with the deterministic Eclat demo accounts,
// so an isolated full regression must seed after migrating from zero. Set
// SEED=0 only for a suite that deliberately creates every tenant and user it
// needs itself.
if (process.env.SEED !== '0') {
  run([join(ROOT, 'prisma/seed.mjs')], { DATABASE_URL: url });
} else {
  console.log('SEED=0 — skipping demo seed for this isolated run.');
}

let failed = false;
try {
  // No --forceExit: the suite has to close Nest and Prisma cleanly on its own.
  // Hiding a leaked handle behind a flag hides the bug that caused it.
  const pattern = process.env.TEST_PATTERN;
  run(
    [
      join(ROOT, 'node_modules/jest/bin/jest.js'),
      '--config', './test/jest-e2e.json',
      '--runInBand',
      ...(pattern ? ['--testPathPattern', pattern] : []),
    ],
    { DATABASE_URL: url },
  );
} catch {
  failed = true;
}

if (process.env.KEEP_TEST_DB === '1') {
  console.log('KEEP_TEST_DB=1 — leaving the test database in place for inspection.');
} else {
  run([TEST_DB, 'drop']);
}

process.exit(failed ? 1 : 0);
