#!/usr/bin/env node
/**
 * Refuse to run a local verification against anything but a loopback API.
 *
 * ## The incident this exists to prevent
 *
 * On 8 September 2026 a browser verification run sent three failed sign-in
 * attempts to the PRODUCTION Railway backend. Nobody typed a production URL.
 * The chain was:
 *
 *   next.config.ts   BACKEND_ORIGIN ?? "https://backend-production-….up.railway.app"
 *   next build       resolves rewrites() and BAKES that destination into
 *                    .next/routes-manifest.json
 *   next start       reads the manifest — the env var set at start time is
 *                    never consulted
 *
 * So `BACKEND_ORIGIN=http://localhost:4100 next start` looks local, reports
 * nothing wrong, and proxies every /_api call to production. Checking the shell
 * variable would have caught nothing; only the built artefact tells the truth.
 * This script therefore reads the BUILT MANIFEST, not just the environment.
 *
 * ## What counts as safe
 *
 * Exactly three hosts: localhost, 127.0.0.1, ::1. Nothing else, and no clever
 * equivalents — 127.1 and 0.0.0.0 are rejected even though 127.1 does resolve to
 * loopback, because an allowlist that reasons about addresses is an allowlist
 * that can be argued with. A relative target ("/_api") is safe by construction:
 * it resolves against the origin the page was already served from.
 *
 * A MISSING target is a failure, not a pass. That is the whole lesson: an unset
 * BACKEND_ORIGIN does not mean "no backend", it means "the production default in
 * next.config.ts".
 *
 * ## Scope
 *
 * This guards local verification only. It is not wired into `build` or `start`,
 * so the real deployment path is untouched — production is supposed to point at
 * production.
 *
 *   node scripts/assert-local-api.mjs            # env + built manifest if present
 *   node scripts/assert-local-api.mjs --built    # manifest REQUIRED (before browsing)
 *   node scripts/assert-local-api.mjs --pre-build # env only (before building)
 *
 * ## Verifying against a named remote (staging)
 *
 *   node scripts/assert-local-api.mjs --built --allow https://backend-staging-x.up.railway.app
 *
 * Loopback is the default because it needs no argument and cannot be wrong. A
 * staging verification genuinely has to reach a remote host, so `--allow` widens
 * the set by exactly one origin that the operator names on the command line.
 *
 * What `--allow` can never do is admit a production host: those are refused
 * unconditionally, below, whatever is passed. The point of this script is that
 * a verification run cannot touch production, and an escape hatch that could be
 * pointed at production would not be a guard at all.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The only hosts a local verification may talk to without --allow. */
export const LOOPBACK_HOSTS = Object.freeze(['localhost', '127.0.0.1', '::1']);

/**
 * Hosts no verification run may EVER reach, regardless of --allow.
 *
 * Matched on the whole hostname and on any subdomain of it. This is the line
 * that makes --allow safe to have.
 */
export const FORBIDDEN_HOSTS = Object.freeze([
  'backend-production-89dd.up.railway.app',
  'eclat-diamonds-pi.vercel.app',
]);

function isForbidden(host) {
  return FORBIDDEN_HOSTS.some((bad) => host === bad || host.endsWith(`.${bad}`));
}

/** Env keys that decide where API traffic ends up. */
export const TARGET_KEYS = Object.freeze(['BACKEND_ORIGIN', 'NEXT_PUBLIC_API_URL']);

/**
 * Classify one target string.
 *
 * Returns `{ ok, kind, host?, reason? }`. `kind` is one of:
 *   'relative' — same-origin path, safe by construction
 *   'loopback' — an absolute URL on an allowed host
 *   'reject'   — anything else, with a reason fit to print
 */
export function classifyTarget(raw, allowedHosts = []) {
  if (raw === undefined || raw === null) {
    return { ok: false, kind: 'reject', reason: 'not set (next.config.ts would fall back to its production default)' };
  }
  if (typeof raw !== 'string') {
    return { ok: false, kind: 'reject', reason: `not a string (${typeof raw})` };
  }

  const value = raw.trim();
  if (!value) {
    return { ok: false, kind: 'reject', reason: 'empty' };
  }

  // Same-origin. "/_api/:path*" is the production shape and is always safe:
  // whatever host served the page serves the API too.
  if (value.startsWith('/') && !value.startsWith('//')) {
    return { ok: true, kind: 'relative', host: '(same origin)' };
  }

  // "//host/path" is protocol-relative and reaches a real host. Not same-origin.
  if (value.startsWith('//')) {
    return { ok: false, kind: 'reject', reason: 'protocol-relative URL reaches a remote host' };
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, kind: 'reject', reason: 'not a parseable absolute URL' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, kind: 'reject', reason: `protocol ${url.protocol} is not http/https` };
  }

  // URL keeps IPv6 hosts in brackets; compare on the bare address.
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (isForbidden(host)) {
    return {
      ok: false,
      kind: 'reject',
      host,
      reason: `host "${host}" is a production origin and can never be a verification target`,
    };
  }

  if (allowedHosts.includes(host)) {
    return { ok: true, kind: 'allowed', host };
  }

  if (!LOOPBACK_HOSTS.includes(host)) {
    return {
      ok: false,
      kind: 'reject',
      host,
      reason: `host "${host}" is not loopback (allowed: ${LOOPBACK_HOSTS.join(', ')}${
        allowedHosts.length ? `, plus --allow ${allowedHosts.join(', ')}` : ''
      })`,
    };
  }

  return { ok: true, kind: 'loopback', host };
}

/** Parse a dotenv file into a plain object. Values may be quoted. */
export function parseEnvFile(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    // Strip one matching pair of surrounding quotes, and any trailing comment
    // on an unquoted value.
    if ((value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
        (value.startsWith("'") && value.endsWith("'") && value.length > 1)) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    out[match[1]] = value;
  }
  return out;
}

/**
 * Next's own precedence for a production build, highest first. Whichever file
 * defines a key first wins, and `process.env` beats every file.
 */
const ENV_FILES = [
  '.env.production.local',
  '.env.development.local',
  '.env.local',
  '.env.production',
  '.env.development',
  '.env',
];

/** Where a key's value came from, following Next's precedence. */
export function resolveEnvValue(key, { dir, env, readFile }) {
  if (env && Object.prototype.hasOwnProperty.call(env, key) && env[key] !== undefined) {
    return { value: env[key], source: 'process.env' };
  }
  for (const file of ENV_FILES) {
    const text = readFile(join(dir, file));
    if (text === null) continue;
    const parsed = parseEnvFile(text);
    if (Object.prototype.hasOwnProperty.call(parsed, key)) {
      return { value: parsed[key], source: file };
    }
  }
  return { value: undefined, source: '(unset)' };
}

/**
 * Every rewrite destination recorded in a built routes-manifest.
 *
 * This is the authoritative answer to "where will `next start` actually send
 * /_api?", because it is what the running server reads.
 */
export function manifestDestinations(manifest) {
  const rewrites = manifest && manifest.rewrites;
  if (!rewrites) return [];
  const groups = Array.isArray(rewrites)
    ? [rewrites]
    : [rewrites.beforeFiles, rewrites.afterFiles, rewrites.fallback];
  const out = [];
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const rule of group) {
      if (rule && typeof rule.destination === 'string') {
        out.push({ source: rule.source, destination: rule.destination });
      }
    }
  }
  return out;
}

/**
 * Every built manifest a local run could actually read.
 *
 * There are three, and each belongs to a different way of running this app:
 *
 *   .next/routes-manifest.json                    `next start`
 *   .next/standalone/.next/routes-manifest.json   `node .next/standalone/server.js`
 *   .next/dev/routes-manifest.json                `next dev`
 *
 * They come from one config and would normally agree, but "normally" is exactly
 * the assumption that produced the incident above — and it does not hold here.
 * When this list was widened, the first two on this machine pointed at
 * localhost:4100 while the third still pointed at the production Railway host,
 * left behind by an earlier `next dev` run with no BACKEND_ORIGIN set. A stale
 * artefact naming production is a real finding, not noise: it is a target
 * sitting in the tree waiting for the next command that reads it.
 */
export const MANIFEST_PATHS = Object.freeze([
  ['.next', 'routes-manifest.json'],
  ['.next', 'standalone', '.next', 'routes-manifest.json'],
  ['.next', 'dev', 'routes-manifest.json'],
]);

/**
 * Collect every API target that applies, from the environment and the build.
 *
 * `mode` is 'built' (a manifest is required), 'pre-build' (env only) or 'auto'
 * (manifests checked when present).
 */
export function collectTargets({ dir, env, mode = 'auto', readFile }) {
  const targets = [];

  for (const key of TARGET_KEYS) {
    const { value, source } = resolveEnvValue(key, { dir, env, readFile });
    targets.push({ label: key, value, origin: source });
  }

  let manifestsFound = 0;

  for (const parts of MANIFEST_PATHS) {
    const rel = parts.join('/');
    const raw = readFile(join(dir, ...parts));
    if (raw === null) continue;
    manifestsFound++;

    let manifest;
    try {
      manifest = JSON.parse(raw);
    } catch {
      targets.push({
        label: `built rewrite (${rel})`,
        value: '<unparseable>',
        origin: rel,
        note: 'Manifest is not valid JSON.',
      });
      continue;
    }

    const destinations = manifestDestinations(manifest);
    if (!destinations.length && mode === 'built') {
      targets.push({
        label: `built rewrite (${rel})`,
        value: undefined,
        origin: `${rel} (no rewrites)`,
        note: 'This build records no rewrite. If the app relies on /_api, it cannot serve it.',
      });
    }
    for (const d of destinations) {
      targets.push({
        label: `built rewrite ${d.source}`,
        value: d.destination,
        origin: rel,
        /*
         * Before a build, an existing manifest describes the PREVIOUS build and
         * is about to be overwritten. Reporting it is useful — it is how a
         * production-targeted artefact gets noticed — but failing on it would
         * be a trap: the command that would fix the file is the one being
         * blocked. So it is shown and not counted. After the build, the same
         * row is authoritative and does count.
         */
        advisory: mode === 'pre-build',
      });
    }
  }

  if (manifestsFound === 0 && mode === 'built') {
    targets.push({
      label: 'built rewrite destination',
      value: undefined,
      origin: `${MANIFEST_PATHS.map((p) => p.join('/')).join(' and ')} (missing)`,
      note: 'No build to inspect. Run the local build first — an unbuilt tree cannot be proved local.',
    });
  }

  return targets;
}

/**
 * Classify every collected target. Pure: returns a report, prints nothing.
 *
 * A row marked `advisory` is printed but cannot fail the run — see the note on
 * pre-build manifests in `collectTargets`.
 */
export function auditTargets(targets, allowedHosts = []) {
  const rows = targets.map((t) => ({ ...t, verdict: classifyTarget(t.value, allowedHosts) }));
  return { rows, ok: rows.every((r) => r.advisory || r.verdict.ok) };
}

/** Hostnames from every `--allow <origin>` on the command line. */
export function parseAllowFlags(argv) {
  const hosts = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--allow') continue;
    const raw = argv[i + 1];
    if (!raw) throw new Error('--allow needs an origin, e.g. --allow https://backend-staging-x.up.railway.app');
    let host;
    try {
      host = new URL(raw).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    } catch {
      throw new Error(`--allow "${raw}" is not a parseable absolute URL`);
    }
    if (isForbidden(host)) {
      throw new Error(`--allow "${host}" is a production origin and is refused`);
    }
    hosts.push(host);
  }
  return hosts;
}

/* ────────────────────────────── CLI ────────────────────────────── */

function readFileOrNull(path) {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}

function main(argv) {
  const mode = argv.includes('--built')
    ? 'built'
    : argv.includes('--pre-build')
      ? 'pre-build'
      : 'auto';

  const dir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const allowedHosts = parseAllowFlags(argv);
  const targets = collectTargets({ dir, env: process.env, mode, readFile: readFileOrNull });
  const { rows, ok } = auditTargets(targets, allowedHosts);
  if (allowedHosts.length) {
    console.log(`Explicitly allowed for this run: ${allowedHosts.join(', ')}`);
  }

  const width = Math.max(...rows.map((r) => r.label.length), 10);
  console.log(`\nLocal API preflight — mode: ${mode}\n`);
  for (const r of rows) {
    const mark = r.verdict.ok ? 'OK  ' : r.advisory ? 'STALE' : 'FAIL';
    const shown = r.value === undefined ? '(not set)' : r.value;
    console.log(`  ${mark}  ${r.label.padEnd(width)}  ${shown}`);
    console.log(`        ${''.padEnd(width)}  from ${r.origin}`);
    if (!r.verdict.ok) {
      console.log(`        ${''.padEnd(width)}  -> ${r.verdict.reason}`);
      if (r.advisory) {
        console.log(
          `        ${''.padEnd(width)}  (from the PREVIOUS build; the build about to run replaces it)`,
        );
      }
    }
    if (r.note) console.log(`        ${''.padEnd(width)}  note: ${r.note}`);
  }

  if (!ok) {
    console.error(
      '\nREFUSING TO CONTINUE. At least one API target is not loopback.\n' +
        'A local verification must never reach a deployed environment.\n' +
        'Fix the target above, rebuild if it was baked into .next, and re-run.\n',
    );
    return 1;
  }

  console.log('\nAll API targets are loopback or same-origin. Safe to verify locally.\n');
  return 0;
}

// Run only when invoked directly, so the pure exports stay importable in tests.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
