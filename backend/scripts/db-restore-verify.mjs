#!/usr/bin/env node
/**
 * Restore a custom-format dump into an explicitly disposable database and
 * verify tenant anchor counts. The target must already exist and its resolved
 * database name must end in `_test` or `_rehearsal`.
 */
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';

const databaseUrl = process.env.RESTORE_DATABASE_URL;
const backupFile = process.env.BACKUP_FILE;
if (!databaseUrl) throw new Error('RESTORE_DATABASE_URL is required.');
if (!backupFile || !isAbsolute(backupFile) || !existsSync(backupFile)) {
  throw new Error('BACKUP_FILE must be an absolute path to an existing dump.');
}

const parsed = new URL(databaseUrl);
const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
const never = new Set(['eclat_dev', 'eclat_preview', 'postgres', 'template0', 'template1']);
if (never.has(databaseName) || !['_test', '_rehearsal'].some((suffix) => databaseName.endsWith(suffix))) {
  throw new Error(`Refusing to restore into non-disposable database "${databaseName}".`);
}
parsed.searchParams.delete('schema');

const manifestPath = `${backupFile}.json`;
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const actual = await sha256File(backupFile);
  if (manifest.sha256 !== actual) throw new Error('Backup checksum does not match its manifest.');
}

const started = Date.now();
execFileSync(
  resolvePostgresTool('pg_restore'),
  [
    '--clean',
    '--if-exists',
    '--exit-on-error',
    '--no-owner',
    '--no-privileges',
    `--dbname=${parsed.toString()}`,
    backupFile,
  ],
  { stdio: ['ignore', 'inherit', 'inherit'] },
);

const sql = [
  'SELECT',
  '  (SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL),',
  '  (SELECT COUNT(*) FROM "Organisation"),',
  '  (SELECT COUNT(*) FROM "User"),',
  '  (SELECT COUNT(*) FROM "Store"),',
  '  (SELECT COUNT(*) FROM "Sale"),',
  '  (SELECT COUNT(*) FROM "Payment"),',
  '  (SELECT COUNT(*) FROM "StockItem"),',
  '  (SELECT COUNT(*) FROM "AuditLog");',
].join(' ');
const raw = execFileSync(
  resolvePostgresTool('psql'),
  [parsed.toString(), '-q', '-A', '-t', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-c', sql],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
).trim();
const [migrations, organisations, users, stores, sales, payments, stockItems, auditLogs] = raw
  .split('|')
  .map(Number);
if (!migrations || !organisations || !users || !stores) {
  throw new Error('Restore verification failed: migration or tenant anchor rows are missing.');
}
console.log(
  JSON.stringify({
    databaseName,
    restoreSeconds: Number(((Date.now() - started) / 1000).toFixed(2)),
    counts: { migrations, organisations, users, stores, sales, payments, stockItems, auditLogs },
    checksumVerified: existsSync(manifestPath),
  }),
);

function resolvePostgresTool(name) {
  const explicit = process.env[`${name.toUpperCase()}_PATH`];
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`${name.toUpperCase()}_PATH does not exist.`);
    return explicit;
  }
  if (process.platform !== 'win32') return name;
  const root = join(process.env.ProgramFiles || 'C:\\Program Files', 'PostgreSQL');
  if (!existsSync(root)) return name;
  const versions = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    const path = join(root, version, 'bin', `${name}.exe`);
    if (existsSync(path)) return path;
  }
  return name;
}

function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}
