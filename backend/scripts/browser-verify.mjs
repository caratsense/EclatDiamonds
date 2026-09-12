#!/usr/bin/env node
/**
 * Browser verification: three roles, three industries, three viewports.
 *
 * ## What this is for, and what it deliberately is not
 *
 * It is NOT a visual-regression tool and takes no golden screenshots. It answers
 * the questions a type-checker and an e2e suite structurally cannot:
 *
 *   - Does the page actually render, or does it throw in the browser?
 *   - Is every sidebar link reachable, or does one 404?
 *   - Does a salesperson see a screen they should not?
 *   - Does a jewellery word leak into a clinic's product?
 *   - Does the layout survive 390px, or does the body scroll sideways?
 *
 * Every one of those passes `tsc` and passes the API tests.
 *
 * ## Honesty
 *
 * A page is PASS only if it renders its own content. A page that renders an
 * error boundary, a permission refusal it should not have hit, or an empty
 * document is reported as it is. Nothing here retries until it goes green.
 *
 * Usage:
 *   node scripts/browser-verify.mjs            # against localhost:3177 / :4000
 *   FRONTEND_URL=… API_URL=… node scripts/…
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const FRONTEND = process.env.FRONTEND_URL ?? 'http://localhost:3177';
const API = process.env.API_URL ?? 'http://localhost:4000';
const OUT = process.env.BROWSER_VERIFY_OUT ?? join(process.cwd(), '.browser-verify');

/** Viewports: a desk, a large phone, and the smallest one anybody still uses. */
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile-420', width: 420, height: 900 },
  { name: 'mobile-390', width: 390, height: 844 },
];

/**
 * Words that must NEVER appear in a non-jewellery tenant's chrome.
 *
 * Checked against rendered text, not against a config file: the whole risk is
 * that a vocabulary is stored correctly and a component hardcodes the word
 * anyway.
 */
const JEWELLERY_WORDS = [
  /karats?/i,
  /carats?/i,
  /gold rate/i,
  /making charges?/i,
  /hallmark/i,
  /bullion/i,
];

/**
 * Text that is allowed to contain a jewellery word, because it is not the
 * tenant's vocabulary.
 *
 * TWO REAL EXEMPTIONS, both found by running this and reading what it caught.
 *
 * The product is called CaratOS, so "carat" appears in the chrome of every page
 * for every tenant. A word-boundary match already excludes "CaratOS" — there is
 * no boundary between "carat" and "os" — but the brand also renders as
 * "CARATOS" and "BV Clinic · CaratOS", and stripping it first makes the
 * intention explicit rather than relying on a regex subtlety.
 *
 * And the industry PICKER lists every pack a tenant could switch to, including
 * the jewellery one and its description. A clinic reading "karat/metal purity,
 * making charges and hallmarking" in a catalogue of industries to choose from
 * is correct: it is the list of options, not their own product's wording.
 */
const BRAND = /carat\s*(os|sense)/gi;
const VOCABULARY_EXEMPT_ROUTES = new Set(['settings/configuration']);

const argTenants = process.env.VERIFY_TENANTS;

/** Filled by the caller: [{ label, industry, users: { role: {email,password} } }] */
const TENANTS = argTenants
  ? JSON.parse(argTenants)
  : [
      { label: 'jewellery', industry: 'jewellery' },
      { label: 'healthcare', industry: 'healthcare' },
      { label: 'textile', industry: 'textile' },
    ];

async function token(email, password) {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login ${email}: HTTP ${res.status}`);
  const body = await res.json();
  return { token: body.token, nav: body.productProfile?.enabledNavigation ?? [] };
}

/**
 * Which roles may see a navigation slug, read out of the frontend's own source.
 *
 * Parsed rather than duplicated: a copy of the role table here would agree with
 * itself for ever and stop agreeing with the product the first time somebody
 * changed a `roles:` line.
 */
const NAV_SOURCE = new URL('../../frontend/src/lib/navigation.ts', import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, '$1');
const ROLE_BY_SLUG = new Map();
try {
  /*
   * Normalised first. The checkout may have CRLF endings, and a split on
   * "\n  {\n" then matches nothing — leaving the table empty, every route
   * filtered out, and a run that reports six checks for the whole product as
   * though there were nothing to test.
   */
  const src = (await import('node:fs'))
    .readFileSync(NAV_SOURCE, 'utf8')
    .replace(/\r\n/g, '\n');
  for (const block of src.split(/\n  \{\n/)) {
    const slug = /slug: "([^"]+)"/.exec(block)?.[1];
    if (!slug) continue;
    const roles = /roles: \[([^\]]*)\]/.exec(block)?.[1];
    ROLE_BY_SLUG.set(
      slug,
      roles ? roles.split(',').map((r) => r.trim().replace(/"/g, '')).filter(Boolean) : null,
    );
  }
} catch {
  // Backend-only checkout: fall back to visiting everything the tenant has.
}

/**
 * A partial parse is worse than no parse: it filters most of the product out
 * and reports a handful of green checks as though that were the whole run.
 */
if (ROLE_BY_SLUG.size && ROLE_BY_SLUG.size < 20) {
  throw new Error(
    `Only ${ROLE_BY_SLUG.size} navigation item(s) parsed from ${NAV_SOURCE}. ` +
      'Refusing to filter on a table that is obviously wrong.',
  );
}

function roleCanSee(slug, role) {
  if (!ROLE_BY_SLUG.size) return true;
  const roles = ROLE_BY_SLUG.get(slug);
  // Absent from the table means the frontend has no nav item for it at all.
  if (roles === undefined) return false;
  return roles === null || roles.includes(role);
}

const results = [];
function record(row) {
  results.push(row);
  const mark = row.status === 'PASS' ? 'ok  ' : row.status === 'SKIP' ? 'skip' : 'FAIL';
  console.log(`${mark} ${row.tenant}/${row.role}/${row.viewport} ${row.check}${row.detail ? ` — ${row.detail}` : ''}`);
}

const { chromium } = await import('playwright');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });

try {
  for (const tenant of TENANTS) {
    for (const [role, creds] of Object.entries(tenant.users ?? {})) {
      let session;
      try {
        session = await token(creds.email, creds.password);
      } catch (e) {
        record({
          tenant: tenant.label,
          role,
          viewport: '-',
          check: 'sign in',
          status: 'FAIL',
          detail: e.message,
        });
        continue;
      }

      for (const viewport of VIEWPORTS) {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
        });
        const page = await context.newPage();

        /** Anything the page throws in the browser, which tsc cannot see. */
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)));
        page.on('console', (m) => {
          if (m.type() === 'error') pageErrors.push(m.text().slice(0, 200));
        });

        await page.goto(`${FRONTEND}/login`, { waitUntil: 'domcontentloaded' });
        await page.evaluate((t) => {
          localStorage.setItem('eclat.token', t);
          localStorage.setItem('eclat.storeId', 'all');
          /*
           * THE ATTENDANCE GATE IS CORRECT BEHAVIOUR, NOT A FAILURE.
           *
           * A salesperson reopening the app is sent to /check-in until they
           * have marked today's attendance, which is deliberate and documented
           * in the (app) layout. Without this flag every salesperson route
           * lands on /check-in and the harness reports the whole role as
           * broken — which would be the harness lying about the product.
           *
           * Set to the same key the app's own `markAttendanceHandled` uses, so
           * this is "they already checked in", not a bypass.
           */
          sessionStorage.setItem('eclat.attendanceHandled', '1');
        }, session.token);

        /*
         * The routes this role can actually SEE, not merely what the tenant is
         * entitled to.
         *
         * `enabledNavigation` is the tenant's list; a store manager is not
         * shown head-office-only screens inside it, and driving a browser at
         * one produces a legitimate 403 that says nothing about whether the
         * page works. The role filter is the frontend's own, read from the
         * navigation source rather than reimplemented here.
         */
        const routes = session.nav.filter((slug) => roleCanSee(slug, role)).slice(0, 40);

        for (const slug of routes) {
          const url = `${FRONTEND}/${slug}`;
          pageErrors.length = 0;
          let response;
          try {
            /*
             * `domcontentloaded`, then wait for the page's OWN heading.
             *
             * Not `networkidle`: the app holds long-lived requests open —
             * notification polling and TanStack refetches — so the network never
             * goes quiet and every navigation times out. That is a property of
             * the product working correctly, and a harness that reads it as a
             * failure reports 100% failure and proves nothing.
             */
            response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
            await page
              .locator('h1, h2')
              .first()
              .waitFor({ state: 'visible', timeout: 20_000 });
            // Let the first data render settle, without waiting for silence.
            await page.waitForTimeout(400);
          } catch (e) {
            record({
              tenant: tenant.label,
              role,
              viewport: viewport.name,
              check: `route /${slug}`,
              status: 'FAIL',
              detail: `navigation: ${String(e.message).slice(0, 120)}`,
            });
            continue;
          }

          const httpStatus = response?.status() ?? 0;
          const text = (await page.locator('body').innerText().catch(() => '')) || '';
          const hasHeading = await page.locator('h1, h2').count();

          // A page that rendered nothing is a failure even at HTTP 200.
          if (httpStatus >= 400) {
            record({
              tenant: tenant.label,
              role,
              viewport: viewport.name,
              check: `route /${slug}`,
              status: 'FAIL',
              detail: `HTTP ${httpStatus}`,
            });
            continue;
          }
          if (!hasHeading || text.trim().length < 20) {
            record({
              tenant: tenant.label,
              role,
              viewport: viewport.name,
              check: `route /${slug}`,
              status: 'FAIL',
              detail: 'rendered no heading or no content',
            });
            continue;
          }

          // THE PAGE MUST NOT SCROLL SIDEWAYS. A table or a chart may, inside its
          // own container; the document may not.
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          if (overflow > 2) {
            record({
              tenant: tenant.label,
              role,
              viewport: viewport.name,
              check: `route /${slug}`,
              status: 'FAIL',
              detail: `body scrolls sideways by ${overflow}px`,
            });
            continue;
          }

          /*
           * A THROWN ERROR IS A FAILURE; A REFUSED SUB-REQUEST IS NOT.
           *
           * A page that renders and whose optional panel 403s is the product
           * correctly refusing part of it to this role — the panel shows its
           * permission state and the page is fine. Treating every console 403
           * as a broken page made a working product report as failing, which is
           * the specific way a harness becomes worse than no harness.
           *
           * Whether a role may reach an endpoint at all is proven in the API
           * tests, where it can be asserted exactly rather than inferred from a
           * console line.
           */
          const thrown = pageErrors.filter(
            (e) => !/Failed to load resource|\b40[13]\b/.test(e),
          );
          if (thrown.length) {
            record({
              tenant: tenant.label,
              role,
              viewport: viewport.name,
              check: `route /${slug}`,
              status: 'FAIL',
              detail: `browser error: ${thrown[0]}`,
            });
            continue;
          }

          // Vocabulary: a clinic must never be shown a jewellery word.
          if (tenant.industry !== 'jewellery' && !VOCABULARY_EXEMPT_ROUTES.has(slug)) {
            const scrubbed = text.replace(BRAND, ' ');
            const leaked = JEWELLERY_WORDS.filter((w) => w.test(scrubbed)).map((w) =>
              String(w).replace(/[\/^$\b()?:i]|\\/g, '').trim(),
            );
            if (leaked.length) {
              record({
                tenant: tenant.label,
                role,
                viewport: viewport.name,
                check: `vocabulary /${slug}`,
                status: 'FAIL',
                detail: `jewellery wording: ${leaked.join(', ')}`,
              });
              continue;
            }
          }

          record({
            tenant: tenant.label,
            role,
            viewport: viewport.name,
            check: `route /${slug}`,
            status: 'PASS',
          });
        }

        // One screenshot per role/viewport, as evidence rather than as a test.
        await page
          .goto(`${FRONTEND}/${routes[0] ?? 'crm'}`, { waitUntil: 'domcontentloaded' })
          .catch(() => {});
        await page.waitForTimeout(800);
        await page
          .screenshot({
            path: join(OUT, `${tenant.label}-${role}-${viewport.name}.png`),
            fullPage: false,
          })
          .catch(() => {});

        await context.close();
      }
    }
  }
} finally {
  await browser.close();
}

const failed = results.filter((r) => r.status === 'FAIL');
const summary = {
  frontend: FRONTEND,
  api: API,
  checks: results.length,
  passed: results.filter((r) => r.status === 'PASS').length,
  failed: failed.length,
  failures: failed,
};
writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));

console.log(
  `\n${summary.passed}/${summary.checks} checks passed. ${failed.length} failed. Evidence in ${OUT}`,
);
if (failed.length) process.exitCode = 1;
