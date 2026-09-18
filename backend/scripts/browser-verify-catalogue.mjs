#!/usr/bin/env node
// Callbacks passed to page.evaluate run in the browser, not in Node.
/* global document, localStorage, sessionStorage, getComputedStyle, innerHeight */
/**
 * Browser check: catalogue visual-similarity results → product detail.
 *
 * Proves, at 1280, 420 and 390 px, against the REAL app and backend:
 *   - a photo upload runs ONE search request (all views, each ≤1 MB JPEG);
 *   - results render, and any result opens the detail (card click, "View
 *     details", keyboard Tab + Enter), while a rating chip does NOT open it;
 *   - the detail shows the design (name, identifiers, pieces), opens on the
 *     MATCHED photo, and the CAD image stays badged Primary;
 *   - prev/next steps through results; Escape closes back to the same results
 *     and scroll position WITHOUT a new search request;
 *   - a deleted/foreign design shows a safe not-found;
 *   - 429 shows a Retry-After retry; CATALOGUE_INDEX_BUILD_REQUIRED shows
 *     coverage, not a spinner (desktop only);
 *   - the document never scrolls sideways.
 *
 * What is intercepted, and why: the similarity-search POST (so the check does
 * not depend on the inference service), the feedback POST (no fake rows in the
 * DB), and GET /products/:id/full is passed
 * through to the real backend and only AUGMENTED when the real data cannot
 * show the case under test (a second, non-primary photo; a CAD primary). The
 * run prints which. Every other request goes to the real backend. Any request
 * to a non-loopback host is aborted and fails the run.
 *
 * Usage (backend on :4000, frontend on :3000):
 *   node scripts/browser-verify-catalogue.mjs
 *   FRONTEND_URL=… API_URL=… VERIFY_EMAIL=… VERIFY_PASSWORD=… OUT=… node scripts/…
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';

const FRONTEND = process.env.FRONTEND_URL ?? 'http://localhost:3000';
const API = process.env.API_URL ?? 'http://localhost:4000';
const EMAIL = process.env.VERIFY_EMAIL ?? 'head.office@caratsense.in';
const PASSWORD = process.env.VERIFY_PASSWORD ?? 'password123';
const OUT = process.env.OUT ?? join(tmpdir(), 'eclat-browser-verify-catalogue');
const VIEWPORTS = [
  { name: 'desktop-1280', width: 1280, height: 900 },
  { name: 'mobile-420', width: 420, height: 900 },
  { name: 'mobile-390', width: 390, height: 844 },
];

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
for (const u of [FRONTEND, API]) {
  if (!LOOPBACK.has(new URL(u).hostname)) throw new Error(`Refusing non-loopback target ${u}`);
}
mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------ real data
/** A dev backend in watch mode restarts on every edit: wait it out (60s), don't fail on it. */
async function api(path, token, init = {}) {
  for (let i = 0; ; i++) {
    try {
      return await fetch(`${API}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-store-id': 'all', ...(init.headers ?? {}) },
      });
    } catch (e) {
      if (i >= 30) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
const login = await api('/auth/login', null, { method: 'POST', body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
if (!login.ok) throw new Error(`login ${EMAIL}: HTTP ${login.status}`);
const { token } = await login.json();

const list = await (await api('/products?page=1&pageSize=40', token)).json();
const withPhotos = list.items.filter((p) => p.imageUrl);
if (withPhotos.length < 3) throw new Error('Need at least 3 catalogue designs with a photo in the local DB.');
const picks = withPhotos.slice(0, 3);
const photoBytes = Buffer.from(await (await api(picks[0].imageUrl, null)).arrayBuffer());
const MISSING_ID = 'e2e-deleted-design-does-not-exist';

/** Real images of a design, via /full when the API has it, else /images. */
async function realImages(id) {
  const full = await api(`/products/${id}/full`, token);
  if (full.ok) return { mode: 'full', images: (await full.json()).images ?? [] };
  return { mode: 'legacy', images: await (await api(`/products/${id}/images`, token)).json() };
}
const imagesById = new Map();
let fullMode = 'unknown';
for (const p of picks) {
  const r = await realImages(p.id);
  fullMode = r.mode;
  imagesById.set(p.id, r.images);
}

/**
 * The gallery each design is shown with: real rows, plus — only if the real
 * data lacks it — one extra non-primary "website" photo (a real image file of
 * another design) so "opens on the matched photo" is testable, and the primary
 * marked gati_cad so "CAD stays Primary" is.
 */
const augmented = [];
function galleryFor(p, i) {
  const imgs = (imagesById.get(p.id) ?? []).map((x) => ({ ...x }));
  let primary = imgs.find((x) => x.isPrimary) ?? imgs[0];
  if (!primary) {
    primary = { id: `e2e-cover-${p.id}`, url: p.imageUrl, isPrimary: true, sortOrder: 0 };
    imgs.push(primary);
    augmented.push(`${p.id}: cover row`);
  }
  if (primary.source !== 'gati_cad') {
    primary.source = 'gati_cad';
    augmented.push(`${p.id}: primary marked gati_cad`);
  }
  let matched = imgs.find((x) => !x.isPrimary);
  if (!matched) {
    matched = {
      id: `e2e-website-${p.id}`,
      url: picks[(i + 1) % picks.length].imageUrl,
      source: 'website',
      colour: 'rose',
      angle: 'side',
      isPrimary: false,
      sortOrder: 1,
    };
    imgs.push(matched);
    augmented.push(`${p.id}: + website photo`);
  }
  return { imgs, primary, matched };
}
const galleries = new Map(picks.map((p, i) => [p.id, galleryFor(p, i)]));

const hits = [
  ...picks.map((p, i) => {
    const g = galleries.get(p.id);
    return {
      productId: p.id,
      productName: p.displayName || p.name,
      sku: p.styleNumber || p.sku,
      imageUrl: p.imageUrl,
      rank: i + 1,
      closenessScore: 92 - i * 7,
      matchLevel: i === 0 ? 'VERY_CLOSE' : 'CLOSE',
      matchedImageId: g.matched.id,
      matchedImageUrl: g.matched.url,
      matchedImageSource: g.matched.source ?? 'website',
      matchedColour: g.matched.colour ?? null,
      matchedAngle: g.matched.angle ?? null,
      heroImageUrl: g.primary.url,
    };
  }),
  { productId: MISSING_ID, productName: 'Removed design', sku: 'GONE-1', rank: 4, closenessScore: 60, matchLevel: 'SIMILAR' },
];
const MATCHES = { queryId: 'e2e-query', available: true, status: 'MATCHES_FOUND', matchLevel: 'VERY_CLOSE', closenessScore: 92, results: hits };

/** Screenshots are for looking at: wait for the pictures on screen to decode. */
async function imagesLoaded(page) {
  await page
    .waitForFunction(
      () => [...document.images].filter((i) => i.getBoundingClientRect().top < innerHeight && i.getBoundingClientRect().bottom > 0).every((i) => i.complete),
      null,
      { timeout: 10_000 },
    )
    .catch(() => {});
}

// ------------------------------------------------------------ run
const results = [];
const check = (vp, name, ok, detail = '') => {
  results.push({ vp, name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${vp} ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({ headless: true });
try {
  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const offHost = [];
    await context.route((url) => !LOOPBACK.has(url.hostname), (route) => {
      offHost.push(route.request().url());
      return route.abort();
    });

    // --- search interception: count, inspect, answer
    const searches = [];
    let nextSearch = () => ({ status: 200, body: MATCHES });
    await context.route('**/products/jewelry/similarity-search**', async (route) => {
      const req = route.request();
      const body = req.postDataBuffer() ?? Buffer.alloc(0);
      const ctype = req.headers()['content-type'] ?? '';
      const boundary = /boundary=(.+)$/.exec(ctype)?.[1];
      const parts = boundary ? body.toString('latin1').split(`--${boundary}`).filter((s) => /name="files"/.test(s)) : [];
      searches.push({
        files: parts.length,
        sizes: parts.map((s) => s.length),
        jpeg: parts.every((s) => /Content-Type: image\/jpeg/i.test(s)),
      });
      const r = nextSearch();
      await route.fulfill({ status: r.status, headers: { 'content-type': 'application/json', ...(r.headers ?? {}) }, body: JSON.stringify(r.body) });
    });

    // A rating would store a feedback row for a query that never happened.
    await context.route('**/products/jewelry/similarity-feedback', (route) =>
      route.fulfill({ status: 201, contentType: 'application/json', body: '{"stored":false}' }),
    );

    // --- detail: real backend, augmented only where the data cannot show the case
    await context.route(/\/products\/[^/]+\/full(\?|$)/, async (route) => {
      const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2));
      const g = galleries.get(id);
      if (!g) return route.continue(); // e.g. the deleted design: real 404
      const real = await route.fetch();
      let body;
      if (real.ok()) {
        body = await real.json();
      } else {
        // API without /full: the app's own fallback shape, from real endpoints.
        const product = await (await api(`/products/${id}`, token)).json();
        const pieces = await (await api(`/products/${id}/pieces`, token)).json();
        body = { ...product, pieces, legacy: true };
      }
      body.images = g.imgs;
      body.legacy = false;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });

    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
    try {

    await page.goto(`${FRONTEND}/login`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((t) => {
      localStorage.setItem('eclat.token', t);
      localStorage.setItem('eclat.storeId', 'all');
      sessionStorage.setItem('eclat.attendanceHandled', '1');
    }, token);
    // A watch-mode backend restarting mid-load answers 401/refused and the app
    // (correctly) sends the user to /login; that is the dev server, not the page.
    for (let attempt = 0; ; attempt++) {
      await page.goto(`${FRONTEND}/catalogue`, { waitUntil: 'domcontentloaded' });
      const ok = await page
        .getByRole('heading', { name: 'AI image search' })
        .waitFor({ timeout: 30_000 })
        .then(() => true, () => false);
      if (ok) break;
      if (attempt >= 2) throw new Error(`catalogue did not load (at ${page.url()})`);
      await (await api('/health', null)).text();
      await page.evaluate((t) => localStorage.setItem('eclat.token', t), token);
    }
    // Anything the welcome guide puts on screen is closed the way a user would.
    await page.keyboard.press('Escape').catch(() => {});

    // 1. upload → one search
    await page.setInputFiles('[data-testid="image-search-input"]', { name: 'piece.jpg', mimeType: 'image/jpeg', buffer: photoBytes });
    const cards = page.getByTestId('similarity-result');
    await cards.first().waitFor({ timeout: 30_000 });
    check(vp.name, 'search completes, results render', (await cards.count()) === hits.length, `${await cards.count()} cards`);
    const s0 = searches[0];
    check(vp.name, 'one request, all views, JPEG ≤1 MB', searches.length === 1 && s0.files === 1 && s0.jpeg && s0.sizes.every((n) => n <= 1_000_000 + 400), JSON.stringify(s0));
    await cards.nth(1).scrollIntoViewIfNeeded();
    await imagesLoaded(page);
    await page.screenshot({ path: join(OUT, `${vp.name}-1-results.png`) });

    // 2. rating chip must not open the detail
    await cards.nth(2).getByRole('button', { name: 'Relevant', exact: true }).click();
    await page.waitForTimeout(300);
    check(vp.name, 'rating chip does not open detail', !(await page.getByTestId('product-detail').isVisible()));

    // 3. card click opens detail over the results
    await cards.nth(1).scrollIntoViewIfNeeded();
    const scrollBefore = await page.evaluate(() => document.querySelector('main')?.scrollTop ?? 0);
    await cards.nth(1).click({ position: { x: 20, y: 20 } });
    const dialog = page.getByTestId('product-detail');
    await dialog.waitFor({ timeout: 15_000 });
    const hit = hits[1];
    const g = galleries.get(hit.productId);
    const selected = dialog.getByTestId('gallery-selected');
    await selected.waitFor({ timeout: 15_000 });
    check(vp.name, 'detail shows the design', (await dialog.getByRole('heading').first().innerText()).includes(hit.productName.slice(0, 12)), hit.productName);
    const missing = [];
    for (const text of ['Pieces on hand', 'SKU', 'Available at']) {
      const seen = await dialog.getByText(text, { exact: true }).first().waitFor({ timeout: 10_000 }).then(() => true, () => false);
      if (!seen) missing.push(text);
    }
    check(vp.name, 'full details visible', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : '');
    check(vp.name, 'matched photo selected', (await selected.getAttribute('data-image-id')) === g.matched.id && (await dialog.getByTestId('badge-matched').isVisible()));
    const primaryThumb = dialog.locator('[data-testid="gallery-thumb"][data-primary="true"]');
    check(
      vp.name,
      'CAD image marked Primary',
      (await primaryThumb.getAttribute('data-source')) === 'gati_cad' && /Primary photo: CAD/.test(await dialog.getByTestId('primary-note').innerText()),
    );
    await imagesLoaded(page);
    await page.screenshot({ path: join(OUT, `${vp.name}-2-detail.png`) });
    await dialog.getByRole('button', { name: 'Show', exact: false }).first().scrollIntoViewIfNeeded();

    // 4. prev / next through results
    await dialog.getByRole('button', { name: 'Next' }).click();
    await dialog.getByText(`Match 3 of ${hits.length}`).waitFor();
    await dialog.getByRole('heading', { name: hits[2].productName.slice(0, 12), exact: false }).first().waitFor({ timeout: 15_000 });
    await dialog.getByRole('button', { name: 'Previous' }).click();
    await dialog.getByText(`Match 2 of ${hits.length}`).waitFor();
    check(vp.name, 'prev/next steps through results', true);

    // 5. Escape closes back to the same results, no new search
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    const scrollAfter = await page.evaluate(() => document.querySelector('main')?.scrollTop ?? 0);
    check(
      vp.name,
      'close restores results, no new search',
      searches.length === 1 && (await cards.count()) === hits.length && Math.abs(scrollAfter - scrollBefore) <= 2,
      `searches=${searches.length} scroll ${scrollBefore}→${scrollAfter}`,
    );
    await page.screenshot({ path: join(OUT, `${vp.name}-3-closed.png`) });

    // 6. keyboard: Tab to a card, visible focus, Enter opens, Escape closes
    await page.getByRole('button', { name: 'Clear' }).focus();
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      return { label: el?.getAttribute('aria-label') ?? '', ring: el ? getComputedStyle(el).boxShadow : 'none' };
    });
    check(vp.name, 'Tab reaches a card with a visible focus ring', focused.label.startsWith('Open ') && focused.ring !== 'none', focused.label);
    await page.screenshot({ path: join(OUT, `${vp.name}-4-focus.png`) });
    await page.keyboard.press('Enter');
    await dialog.waitFor({ timeout: 15_000 });
    await dialog.getByTestId('gallery-selected').waitFor({ timeout: 15_000 });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    const back = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '');
    check(vp.name, 'Enter opens, Escape closes, focus returns', back === focused.label && searches.length === 1, back || '(focus lost)');

    // 7. "View details" on another card
    await cards.nth(2).getByRole('button', { name: 'View details' }).click();
    await dialog.getByTestId('gallery-selected').waitFor({ timeout: 15_000 });
    check(vp.name, '"View details" opens the detail', true);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });

    // 8. deleted / foreign design → safe not-found (real backend 404)
    await cards.nth(3).click({ position: { x: 20, y: 20 } });
    const nf = dialog.getByTestId('detail-not-found');
    await nf.waitFor({ timeout: 20_000 }).catch(() => {});
    check(vp.name, 'deleted design shows not-found', await nf.isVisible());
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });

    // 9. 429 → Retry-After retry
    nextSearch = () => ({ status: 429, headers: { 'retry-after': '2' }, body: { statusCode: 429, message: 'busy' } });
    await page.setInputFiles('[data-testid="image-search-input"]', { name: 'side.jpg', mimeType: 'image/jpeg', buffer: photoBytes });
    await page.getByRole('button', { name: /Search with 2 views/ }).click();
    const busy = page.getByTestId('search-busy');
    await busy.waitFor({ timeout: 15_000 });
    check(vp.name, '429 shows retry with Retry-After', /Try again in \d+s/.test(await busy.innerText()));
    const s1 = searches.at(-1);
    check(vp.name, 'two views go in ONE request', s1.files === 2 && s1.jpeg, JSON.stringify(s1));
    nextSearch = () => ({ status: 200, body: MATCHES });
    await busy.getByRole('button', { name: 'Try again' }).click({ timeout: 10_000 });
    await busy.waitFor({ state: 'hidden', timeout: 15_000 });
    await cards.first().waitFor();

    // 10. index-build state (desktop only — layout is the same component)
    if (vp.name.startsWith('desktop')) {
      nextSearch = () => ({ status: 200, body: { status: 'CATALOGUE_INDEX_BUILD_REQUIRED', coverage: { indexed: 0, total: 240, queued: 180, failed: 3 } } });
      await page.getByRole('button', { name: 'Clear' }).click();
      await page.setInputFiles('[data-testid="image-search-input"]', { name: 'piece.jpg', mimeType: 'image/jpeg', buffer: photoBytes });
      const building = page.getByTestId('index-building');
      await building.waitFor({ timeout: 15_000 });
      check(vp.name, 'index-build shows coverage, not a spinner', (await building.getByRole('progressbar').count()) === 1 && /0 of 240/.test(await building.innerText()));
      await building.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(OUT, `${vp.name}-5-index-building.png`) });
    }

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(vp.name, 'no sideways scroll', overflow <= 2, `${overflow}px`);
    check(vp.name, 'no browser errors', errors.length === 0, errors[0] ?? '');
    check(vp.name, 'no off-host requests', offHost.length === 0, offHost[0] ?? '');
    } catch (e) {
      check(vp.name, 'flow completed', false, String(e.message).split(/\r?\n/)[0]);
      await page.screenshot({ path: join(OUT, `${vp.name}-error.png`) }).catch(() => {});
    }
    await context.close();
  }
} finally {
  await browser.close();
}

console.log(`\n/full: ${fullMode === 'full' ? 'real endpoint' : 'API has no /full — app fallback shape from real endpoints'}`);
console.log(`augmented: ${augmented.length ? [...new Set(augmented)].join('; ') : 'nothing'}`);
console.log(`screenshots: ${OUT}`);
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
