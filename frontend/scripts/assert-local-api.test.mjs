/**
 * Tests for the local-API preflight (MM4 item 0).
 *
 * Zero dependencies: `node --test`. The point of this file is the REJECT cases
 * — an allowlist is only as good as the things it refuses, and the deceptive
 * hostnames below are the ones a careless implementation lets through.
 *
 *   node --test scripts/assert-local-api.test.mjs
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import {
  LOOPBACK_HOSTS,
  auditTargets,
  classifyTarget,
  collectTargets,
  manifestDestinations,
  parseAllowFlags,
  parseEnvFile,
  resolveEnvValue,
} from './assert-local-api.mjs';

describe('classifyTarget — allow', () => {
  const allowed = [
    ['http://localhost:4100', 'localhost'],
    ['http://localhost:4100/:path*', 'localhost'],
    ['https://localhost:4100', 'localhost'],
    ['http://127.0.0.1:4100', '127.0.0.1'],
    ['http://[::1]:4100', '::1'],
    ['http://LOCALHOST:4100', 'localhost'],
    ['  http://localhost:4100  ', 'localhost'],
  ];
  for (const [value, host] of allowed) {
    test(`accepts ${value.trim()}`, () => {
      const v = classifyTarget(value);
      assert.equal(v.ok, true, v.reason);
      assert.equal(v.kind, 'loopback');
      assert.equal(v.host, host);
    });
  }

  test('accepts a same-origin relative target', () => {
    for (const value of ['/_api', '/_api/:path*', '/api']) {
      const v = classifyTarget(value);
      assert.equal(v.ok, true);
      assert.equal(v.kind, 'relative');
    }
  });

  /**
   * WHATWG URL canonicalises every IPv4 shorthand before we ever see it, so the
   * three-host allowlist covers forms it never literally lists. Pinned because
   * it is the parser doing the work, not this file — if the runtime ever stopped
   * normalising, an allowlist of exact strings would start rejecting real
   * loopback addresses and this test would say so.
   */
  test('accepts IPv4 shorthands, which the URL parser canonicalises to 127.0.0.1', () => {
    for (const value of [
      'http://127.1:4100',
      'http://2130706433:4100',
      'http://0x7f000001:4100',
      'http://0177.0.0.1:4100',
    ]) {
      const v = classifyTarget(value);
      assert.equal(v.ok, true, `${value} is loopback and must be accepted`);
      assert.equal(v.host, '127.0.0.1');
    }
  });

  test('the same canonicalisation does not launder a REMOTE decimal IP', () => {
    // 3221225985 is 192.0.2.1 — canonicalised, then rejected on the allowlist.
    const v = classifyTarget('http://3221225985:4100');
    assert.equal(v.ok, false);
    assert.equal(v.host, '192.0.2.1');
  });
});

describe('classifyTarget — reject public hosts', () => {
  const rejected = [
    'https://backend-production-89dd.up.railway.app',
    'https://backend-production-89dd.up.railway.app/:path*',
    'https://eclat-diamonds-pi.vercel.app',
    'https://api.eclatdiamonds.in',
    'http://203.0.113.10:4100',
    'http://10.0.0.5:4100',
  ];
  for (const value of rejected) {
    test(`rejects ${value}`, () => {
      const v = classifyTarget(value);
      assert.equal(v.ok, false);
      // A production host is refused for being production; everything else for
      // not being loopback. Both are rejections; the reason differs on purpose,
      // because only one of them can never be widened by --allow.
      assert.match(v.reason, /not loopback|production origin/);
    });
  }

  test('rejects the exact production default baked into next.config.ts', () => {
    // The literal that caused the 8 September incident. If this ever passes,
    // the preflight has stopped doing the one job it was written for.
    const v = classifyTarget('https://backend-production-89dd.up.railway.app/:path*');
    assert.equal(v.ok, false);
    assert.equal(v.host, 'backend-production-89dd.up.railway.app');
  });
});

describe('classifyTarget — reject deceptive hostnames', () => {
  const deceptive = [
    ['http://localhost.evil.com', 'a subdomain that merely starts with localhost'],
    ['http://evil-localhost.com', 'localhost as a substring'],
    ['http://127.0.0.1.evil.com', 'the loopback IP as a label'],
    ['http://evil.com/localhost', 'loopback in the path'],
    ['http://evil.com#http://localhost', 'loopback in the fragment'],
    ['http://evil.com?to=http://localhost', 'loopback in the query'],
    ['http://localhost@evil.com', 'loopback as userinfo — the host is evil.com'],
    ['//localhost:4100', 'protocol-relative, resolves to a remote host'],
    ['http://0.0.0.0:4100', 'the unspecified address is not loopback'],
    ['http://[::ffff:127.0.0.1]:4100', 'IPv4-mapped IPv6 canonicalises to ::ffff:7f00:1, off the allowlist'],
  ];
  for (const [value, why] of deceptive) {
    test(`rejects ${value} — ${why}`, () => {
      assert.equal(classifyTarget(value).ok, false);
    });
  }

  test('userinfo trick resolves to the real host, not the decoy', () => {
    assert.equal(classifyTarget('http://localhost@evil.com').host, 'evil.com');
  });
});

describe('classifyTarget — reject malformed and missing', () => {
  test('rejects a missing target, because unset means the production default', () => {
    const v = classifyTarget(undefined);
    assert.equal(v.ok, false);
    assert.match(v.reason, /not set/);
  });

  for (const [value, label] of [
    [null, 'null'],
    ['', 'empty string'],
    ['   ', 'whitespace'],
    ['not a url', 'free text'],
    ['http://', 'scheme only'],
    ['ftp://localhost', 'wrong protocol'],
    ['file:///etc/passwd', 'file protocol'],
    ['javascript:alert(1)', 'javascript protocol'],
    [42, 'a number'],
  ]) {
    test(`rejects ${label}`, () => {
      assert.equal(classifyTarget(value).ok, false);
    });
  }
});

describe('parseEnvFile', () => {
  test('reads plain, quoted and commented values', () => {
    const parsed = parseEnvFile(
      [
        '# a comment',
        'BACKEND_ORIGIN=http://localhost:4100',
        'NEXT_PUBLIC_API_URL="/_api"',
        "OTHER='single'",
        'WITH_COMMENT=http://localhost:4100   # trailing',
        'not a line',
      ].join('\n'),
    );
    assert.equal(parsed.BACKEND_ORIGIN, 'http://localhost:4100');
    assert.equal(parsed.NEXT_PUBLIC_API_URL, '/_api');
    assert.equal(parsed.OTHER, 'single');
    assert.equal(parsed.WITH_COMMENT, 'http://localhost:4100');
  });
});

describe('resolveEnvValue precedence', () => {
  const files = {
    'd/.env.local': 'BACKEND_ORIGIN=http://localhost:1111',
    'd/.env.production': 'BACKEND_ORIGIN=https://backend-production-89dd.up.railway.app',
    'd/.env': 'BACKEND_ORIGIN=http://localhost:3333',
  };
  const readFile = (p) => files[p.replace(/\\/g, '/')] ?? null;

  test('process.env wins over every file', () => {
    const r = resolveEnvValue('BACKEND_ORIGIN', {
      dir: 'd',
      env: { BACKEND_ORIGIN: 'http://localhost:4100' },
      readFile,
    });
    assert.equal(r.value, 'http://localhost:4100');
    assert.equal(r.source, 'process.env');
  });

  test('.env.local beats .env.production and .env', () => {
    const r = resolveEnvValue('BACKEND_ORIGIN', { dir: 'd', env: {}, readFile });
    assert.equal(r.value, 'http://localhost:1111');
    assert.equal(r.source, '.env.local');
  });

  test('an absent key reports unset rather than guessing', () => {
    const r = resolveEnvValue('NOPE', { dir: 'd', env: {}, readFile });
    assert.equal(r.value, undefined);
    assert.equal(r.source, '(unset)');
  });
});

describe('manifestDestinations', () => {
  test('reads every rewrite group', () => {
    const found = manifestDestinations({
      rewrites: {
        beforeFiles: [{ source: '/a', destination: 'http://localhost:1/a' }],
        afterFiles: [{ source: '/_api/:path*', destination: 'http://localhost:4100/:path*' }],
        fallback: [],
      },
    });
    assert.equal(found.length, 2);
    assert.equal(found[1].destination, 'http://localhost:4100/:path*');
  });

  test('handles the legacy array shape and a manifest with no rewrites', () => {
    assert.equal(manifestDestinations({ rewrites: [{ source: '/x', destination: '/y' }] }).length, 1);
    assert.deepEqual(manifestDestinations({}), []);
    assert.deepEqual(manifestDestinations(null), []);
  });
});

describe('collectTargets + auditTargets — the incident, reproduced', () => {
  /**
   * The exact 8 September shape: the shell says localhost, the BUILD says
   * production. Checking the environment alone reports everything fine.
   */
  const builtProduction = JSON.stringify({
    rewrites: {
      afterFiles: [
        {
          source: '/_api/:path*',
          destination: 'https://backend-production-89dd.up.railway.app/:path*',
        },
      ],
    },
  });

  /** Serve `content` only at the plain .next manifest, never the standalone copy. */
  const onlyPlainManifest = (content) => (p) => {
    const path = p.replace(/\\/g, '/');
    if (path.includes('standalone')) return null;
    return path.endsWith('.next/routes-manifest.json') ? content : null;
  };

  test('a loopback shell over a production build FAILS', () => {
    const readFile = onlyPlainManifest(builtProduction);
    const targets = collectTargets({
      dir: 'app',
      env: { BACKEND_ORIGIN: 'http://localhost:4100', NEXT_PUBLIC_API_URL: '/_api' },
      mode: 'built',
      readFile,
    });
    const { ok, rows } = auditTargets(targets);
    assert.equal(ok, false, 'the built manifest must override a reassuring shell variable');

    const envRows = rows.filter((r) => r.label === 'BACKEND_ORIGIN');
    assert.equal(envRows[0].verdict.ok, true, 'the env var alone would have looked fine');

    const failed = rows.filter((r) => !r.verdict.ok);
    assert.equal(failed.length, 1);
    assert.match(failed[0].label, /built rewrite/);
  });

  test('a fully local build PASSES', () => {
    const local = JSON.stringify({
      rewrites: {
        afterFiles: [
          { source: '/_api/:path*', destination: 'http://localhost:4100/:path*' },
        ],
      },
    });
    const { ok } = auditTargets(
      collectTargets({
        dir: 'app',
        env: { BACKEND_ORIGIN: 'http://localhost:4100', NEXT_PUBLIC_API_URL: '/_api' },
        mode: 'built',
        readFile: onlyPlainManifest(local),
      }),
    );
    assert.equal(ok, true);
  });

  test('an unset BACKEND_ORIGIN fails, because unset means production', () => {
    const { ok, rows } = auditTargets(
      collectTargets({ dir: 'app', env: {}, mode: 'pre-build', readFile: () => null }),
    );
    assert.equal(ok, false);
    const backend = rows.find((r) => r.label === 'BACKEND_ORIGIN');
    assert.match(backend.verdict.reason, /not set/);
  });

  test('the STANDALONE manifest is checked too, not just .next/', () => {
    // output: "standalone" emits a second manifest that `node
    // .next/standalone/server.js` reads instead of the first. A build that is
    // local in one and production in the other must fail.
    const local = JSON.stringify({
      rewrites: { afterFiles: [{ source: '/_api/:path*', destination: 'http://localhost:4100/:path*' }] },
    });
    const readFile = (p) => {
      const path = p.replace(/\\/g, '/');
      if (path.endsWith('.next/standalone/.next/routes-manifest.json')) return builtProduction;
      if (path.endsWith('.next/routes-manifest.json')) return local;
      return null;
    };
    const { ok, rows } = auditTargets(
      collectTargets({
        dir: 'app',
        env: { BACKEND_ORIGIN: 'http://localhost:4100', NEXT_PUBLIC_API_URL: '/_api' },
        mode: 'built',
        readFile,
      }),
    );
    assert.equal(ok, false, 'a production standalone manifest must fail the preflight');
    const failed = rows.filter((r) => !r.verdict.ok);
    assert.equal(failed.length, 1);
    assert.match(failed[0].origin, /standalone/);
  });

  test('a stale next-dev manifest naming production fails the whole run', () => {
    // Found on a real machine: `next start` and the standalone output both said
    // localhost while .next/dev/routes-manifest.json, left by an earlier
    // unguarded `next dev`, still said Railway. Any manifest in the tree that
    // names production is a target the next command could read.
    const local = JSON.stringify({
      rewrites: { afterFiles: [{ source: '/_api/:path*', destination: 'http://localhost:4100/:path*' }] },
    });
    const readFile = (p) => {
      const path = p.replace(/\\/g, '/');
      if (path.endsWith('.next/dev/routes-manifest.json')) return builtProduction;
      if (path.includes('standalone')) return local;
      if (path.endsWith('.next/routes-manifest.json')) return local;
      return null;
    };
    const { ok, rows } = auditTargets(
      collectTargets({
        dir: 'app',
        env: { BACKEND_ORIGIN: 'http://localhost:4100', NEXT_PUBLIC_API_URL: '/_api' },
        mode: 'built',
        readFile,
      }),
    );
    assert.equal(ok, false);
    const failed = rows.filter((r) => !r.verdict.ok);
    assert.equal(failed.length, 1);
    assert.match(failed[0].origin, /\.next\/dev/);
  });

  test('pre-build REPORTS a production manifest but does not block the rebuild', () => {
    // The chicken-and-egg: a previous production-targeted build must not stop
    // the build that would replace it. Shown as STALE, not counted.
    const readFile = onlyPlainManifest(builtProduction);
    const { ok, rows } = auditTargets(
      collectTargets({
        dir: 'app',
        env: { BACKEND_ORIGIN: 'http://localhost:4100', NEXT_PUBLIC_API_URL: '/_api' },
        mode: 'pre-build',
        readFile,
      }),
    );
    assert.equal(ok, true, 'a stale artefact must not block the fixing rebuild');
    const stale = rows.find((r) => r.advisory);
    assert.ok(stale, 'the production manifest is still surfaced');
    assert.equal(stale.verdict.ok, false);
  });

  test('the SAME manifest is fatal once the mode is --built', () => {
    const readFile = onlyPlainManifest(builtProduction);
    const { ok } = auditTargets(
      collectTargets({
        dir: 'app',
        env: { BACKEND_ORIGIN: 'http://localhost:4100', NEXT_PUBLIC_API_URL: '/_api' },
        mode: 'built',
        readFile,
      }),
    );
    assert.equal(ok, false, 'after building, the artefact is authoritative');
  });

  test('pre-build still fails on a bad ENVIRONMENT, which is what it is for', () => {
    const { ok } = auditTargets(
      collectTargets({
        dir: 'app',
        env: { BACKEND_ORIGIN: 'https://backend-production-89dd.up.railway.app' },
        mode: 'pre-build',
        readFile: onlyPlainManifest(
          JSON.stringify({
            rewrites: { afterFiles: [{ source: '/_api/:path*', destination: 'http://localhost:4100/:path*' }] },
          }),
        ),
      }),
    );
    assert.equal(ok, false);
  });

  test('the dev-mode env files are consulted too', () => {
    const files = { 'app/.env.development': 'BACKEND_ORIGIN=https://backend-production-89dd.up.railway.app' };
    const readFile = (p) => files[p.replace(/\\/g, '/')] ?? null;
    const { ok } = auditTargets(
      collectTargets({ dir: 'app', env: { NEXT_PUBLIC_API_URL: '/_api' }, mode: 'pre-build', readFile }),
    );
    assert.equal(ok, false, '.env.development is what `next dev` loads');
  });

  test('--built with no build at all fails rather than passing vacuously', () => {
    const { ok, rows } = auditTargets(
      collectTargets({
        dir: 'app',
        env: { BACKEND_ORIGIN: 'http://localhost:4100', NEXT_PUBLIC_API_URL: '/_api' },
        mode: 'built',
        readFile: () => null,
      }),
    );
    assert.equal(ok, false);
    assert.ok(rows.some((r) => /missing/.test(r.origin)));
  });

  test('an absolute production NEXT_PUBLIC_API_URL fails even with a local rewrite', () => {
    const local = JSON.stringify({
      rewrites: { afterFiles: [{ source: '/_api/:path*', destination: 'http://localhost:4100/:path*' }] },
    });
    const readFile = (p) =>
      p.replace(/\\/g, '/').endsWith('.next/routes-manifest.json') ? local : null;
    const { ok } = auditTargets(
      collectTargets({
        dir: 'app',
        env: {
          BACKEND_ORIGIN: 'http://localhost:4100',
          // The browser would bypass the rewrite entirely and go direct.
          NEXT_PUBLIC_API_URL: 'https://backend-production-89dd.up.railway.app',
        },
        mode: 'built',
        readFile,
      }),
    );
    assert.equal(ok, false);
  });
});

describe('the allowlist itself', () => {
  test('is exactly the three loopback forms, so it cannot quietly widen', () => {
    assert.deepEqual([...LOOPBACK_HOSTS], ['localhost', '127.0.0.1', '::1']);
  });
});


describe('--allow, and the line it may not cross', () => {
  const STAGING = 'https://backend-staging-e5cd.up.railway.app';

  test('a named staging origin is accepted only when allowed', () => {
    assert.equal(classifyTarget(STAGING).ok, false);
    assert.equal(classifyTarget(STAGING, ['backend-staging-e5cd.up.railway.app']).ok, true);
  });

  test('allowing one remote does not admit another', () => {
    const v = classifyTarget('https://backend-other.up.railway.app', ['backend-staging-e5cd.up.railway.app']);
    assert.equal(v.ok, false);
  });

  test('a production host stays refused even when named in --allow', () => {
    const v = classifyTarget('https://backend-production-89dd.up.railway.app', [
      'backend-production-89dd.up.railway.app',
    ]);
    assert.equal(v.ok, false);
    assert.match(v.reason, /production origin/);
  });

  test('parseAllowFlags refuses a production origin outright', () => {
    assert.throws(
      () => parseAllowFlags(['--allow', 'https://backend-production-89dd.up.railway.app']),
      /production origin/,
    );
  });

  test('parseAllowFlags reads the hostname from an origin', () => {
    assert.deepEqual(parseAllowFlags(['--allow', STAGING]), ['backend-staging-e5cd.up.railway.app']);
  });

  test('parseAllowFlags rejects a bare hostname', () => {
    assert.throws(() => parseAllowFlags(['--allow', 'backend-staging-e5cd.up.railway.app']), /parseable/);
  });
});
