#!/usr/bin/env node
/**
 * Create a PostgreSQL custom-format backup plus a SHA-256 manifest.
 *
 * Required:
 *   BACKUP_DATABASE_URL (falls back to DATABASE_URL)
 *   BACKUP_OUTPUT_DIR   (absolute path on encrypted/off-site storage)
 *
 * This script deliberately does not rotate or upload files. Retention and
 * off-site replication belong to the storage provider, where deletion can be
 * versioned and audited rather than hidden in an application cron.
 */
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';

const databaseUrl = process.env.BACKUP_DATABASE_URL || process.env.DATABASE_URL;
const outputDir = process.env.BACKUP_OUTPUT_DIR;
if (!databaseUrl) throw new Error('BACKUP_DATABASE_URL or DATABASE_URL is required.');
if (!outputDir || !isAbsolute(outputDir)) {
  throw new Error('BACKUP_OUTPUT_DIR must be an absolute path on the backup destination.');
}

const parsed = new URL(databaseUrl);
const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
if (!databaseName) throw new Error('The backup database URL has no database name.');
parsed.searchParams.delete('schema'); // Prisma-only; libpq rejects this parameter.

mkdirSync(outputDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const safeName = databaseName.replace(/[^a-zA-Z0-9_-]/g, '_');
const finalPath = join(outputDir, `${safeName}-${stamp}.dump`);
const partialPath = `${finalPath}.partial`;
const pgDump = resolvePostgresTool('pg_dump');

try {
  execFileSync(
    pgDump,
    [
      `--dbname=${parsed.toString()}`,
      '--format=custom',
      '--compress=9',
      '--no-owner',
      '--no-privileges',
      `--file=${partialPath}`,
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  renameSync(partialPath, finalPath);
} catch (error) {
  rmSync(partialPath, { force: true });
  throw error;
}

const manifest = {
  format: 'postgres-custom',
  databaseName,
  createdAt: new Date().toISOString(),
  bytes: statSync(finalPath).size,
  sha256: await sha256File(finalPath),
  pgDumpVersion: execFileSync(pgDump, ['--version'], { encoding: 'utf8' }).trim(),
};
writeFileSync(`${finalPath}.json`, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ backupFile: finalPath, manifestFile: `${finalPath}.json`, ...manifest }));

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
