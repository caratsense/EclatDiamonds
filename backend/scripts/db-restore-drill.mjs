#!/usr/bin/env node
/** End-to-end local DR drill: migrate + seed -> dump -> restore -> verify. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const baseUrl = process.env.DATABASE_URL || readEnvFile('.env').DATABASE_URL;
if (!baseUrl) throw new Error('DATABASE_URL is required to derive local rehearsal databases.');
const parsed = new URL(baseUrl);
if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
  throw new Error(
    'The automated drill runs only on localhost. Use the documented manual staging drill for remote databases.',
  );
}

const nonce = `${process.pid}_${Date.now()}`;
const sourceUrl = databaseUrl(baseUrl, `caratos_backup_${nonce}_rehearsal`);
const targetUrl = databaseUrl(baseUrl, `caratos_restore_${nonce}_rehearsal`);
const scratch = mkdtempSync(join(tmpdir(), 'caratos-drill-'));
let sourceCreated = false;
let targetCreated = false;

const run = (script, env = {}, ...args) =>
  execFileSync(process.execPath, [join(root, script), ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });

try {
  run('scripts/test-db.mjs', { TEST_DATABASE_URL: sourceUrl });
  sourceCreated = true;
  run('prisma/seed.mjs', { DATABASE_URL: sourceUrl });
  run('scripts/db-backup.mjs', {
    BACKUP_DATABASE_URL: sourceUrl,
    BACKUP_OUTPUT_DIR: scratch,
  });
  const dump = readdirSync(scratch)
    .filter((name) => name.endsWith('.dump'))
    .map((name) => join(scratch, name))[0];
  if (!dump || !existsSync(`${dump}.json`)) {
    throw new Error('Backup or checksum manifest was not created.');
  }

  run('scripts/test-db.mjs', { TEST_DATABASE_URL: targetUrl });
  targetCreated = true;
  run('scripts/db-restore-verify.mjs', {
    RESTORE_DATABASE_URL: targetUrl,
    BACKUP_FILE: dump,
  });
  console.log('Local backup and restore drill passed.');
} finally {
  if (targetCreated) run('scripts/test-db.mjs', { TEST_DATABASE_URL: targetUrl }, 'drop');
  if (sourceCreated) run('scripts/test-db.mjs', { TEST_DATABASE_URL: sourceUrl }, 'drop');
  // `scratch` came directly from mkdtemp under the OS temp directory and is not
  // supplied by a user or environment variable.
  rmSync(scratch, { recursive: true, force: true });
}

function databaseUrl(url, name) {
  const value = new URL(url);
  value.pathname = `/${name}`;
  return value.toString();
}

function readEnvFile(name) {
  const path = join(root, name);
  if (!existsSync(path)) return {};
  const result = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match) result[match[1]] = match[2].replace(/^"|"$/g, '');
  }
  return result;
}
