import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A screen must be in the pack's CORE_NAVIGATION or it does not exist.
 *
 * That list is the entitlement AND the navigation, so a slug missing from it
 * means both "not in the sidebar" and "403 from the API". The file's own
 * comment records that several screens had already shipped, been tested and
 * been deployed this way — reachable only by typing the address.
 *
 * NPS then did it again: the slug was added to MODULES, to the frontend
 * navigation and to the frontend CORE_NAVIGATION, but the edit to this file
 * silently matched nothing. Everything passed, the page rendered on a typed
 * URL, and the sidebar never showed it.
 *
 * Read as TEXT rather than imported because the packs module pulls in the
 * Prisma client and a chain of services; this assertion needs neither, and a
 * test that cannot run is worth nothing.
 */
describe('CORE_NAVIGATION covers the screens that claim to be core', () => {
  /*
   * Comments are stripped BEFORE slugs are read. An apostrophe inside one —
   * "the bot's own wording" — otherwise opens a string the matcher never
   * closes, and the list silently reads as two entries instead of thirty.
   */
  const read = (rel: string) =>
    readFileSync(join(__dirname, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*/g, '');

  const slugsIn = (src: string, declaration: string): Set<string> => {
    const start = src.indexOf(declaration);
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf('];', start));
    return new Set(Array.from(block.matchAll(/'([^']+)'/g), (m) => m[1]));
  };

  const packSlugs = slugsIn(read('packs.ts'), 'const CORE_NAVIGATION');

  it.each([
    'crm',
    'conversations',
    'nps',
    'bot-script',
    'customers',
    'checkins',
    'feedback',
  ])('%s is entitled', (slug) => {
    expect(packSlugs.has(slug)).toBe(true);
  });

  /*
   * Entitlement has two sources, and conflating them is how this test first
   * reported a false positive: `universalNavigation()` is CORE alone, while
   * `eclatNavigation()` adds the multi-branch screens — `dashboards`,
   * `reporting`, the cross-store views — which a single-location tenant
   * deliberately does not get. A slug is reachable for this client if it is in
   * either.
   */
  const eclatSlugs = (() => {
    const src = read('packs.ts');
    const start = src.indexOf('function eclatNavigation');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf('\n}', start));
    return new Set([...packSlugs, ...Array.from(block.matchAll(/'([^']+)'/g), (m) => m[1])]);
  })();

  it('every CRM screen a store manager holds by default is reachable', () => {
    // The real guard: anything granted by role but entitled nowhere is a screen
    // somebody has been given and cannot open.
    const granted = [...slugsIn(read('../../auth/access.ts'), 'const STORE_MANAGER')];
    const crmish = granted.filter((s) =>
      ['feedback', 'nps', 'bot-script', 'dashboards', 'customers/archived'].includes(s),
    );
    expect(crmish.length).toBeGreaterThan(0);
    for (const slug of crmish) {
      expect({ slug, reachable: eclatSlugs.has(slug) }).toEqual({ slug, reachable: true });
    }
  });
});
