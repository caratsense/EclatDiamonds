import type { IndustryPack, LexiconKey, PackLexicon } from './types';

/**
 * Turning an industry's nouns into the words on the screen.
 *
 * ## The shape of the answer, and why it is this shape
 *
 * `labelsFor()` returns a map keyed by the NEUTRAL ENGLISH STRING the interface
 * already renders:
 *
 *     { "Customers": "Patients", "CRM & Leads": "CRM & Enquiries" }
 *
 * The frontend looks a label up by the text it was about to display. That is an
 * unusual key, and it was chosen over the obvious alternatives on purpose:
 *
 *  - Keying by route slug (`nav.customers`) relabels the sidebar and nothing
 *    else. Every page builds its own heading from `getNavItem(slug).title` at
 *    module scope, where no tenant is known, so the sidebar would say "Patients"
 *    while the page it opened still said "Customers". Half-translated is worse
 *    than untranslated.
 *  - Keying by a new prop threaded through every screen means editing every
 *    screen, for a label.
 *
 * Keying by the rendered string means the two places that actually render
 * chrome — the nav and the section header — consult one map, and every screen
 * inherits it without being touched.
 *
 * ## Why the whole map is empty for jewellery
 *
 * Every value below is generated from a pack's `lexicon`, and an entry is
 * emitted ONLY where that pack overrode the neutral noun. Jewellery declares no
 * lexicon, so it produces `{}`, so the frontend's lookup misses on every string
 * and renders exactly what it renders today. Eclat cannot be relabelled by this
 * mechanism even by accident — not because a branch excludes it, but because
 * there is nothing to substitute.
 *
 * ## Why substitution is whole-string and never partial
 *
 * A lookup is an exact match on a complete label. No regex, no word-boundary
 * replacement, no case folding, no scanning of body text. "Customer support"
 * does not become "Patient support" because it is not a key. This keeps the
 * blast radius of a bad lexicon value to the handful of labels named below,
 * rather than every sentence in the product that happens to contain the word.
 */

/** What the product calls these concepts when nobody overrides them. */
const NEUTRAL: Record<LexiconKey, string> = {
  customer: 'Customer',
  customer_plural: 'Customers',
  lead: 'Lead',
  lead_plural: 'Leads',
  product: 'Product',
  product_plural: 'Products',
  catalogue: 'Catalogue',
  store: 'Store',
  store_plural: 'Stores',
};

/**
 * The complete set of labels this mechanism may rewrite, and the noun each is
 * built from.
 *
 * This list is deliberately short and deliberately hand-written. It covers the
 * navigation titles and primary-action buttons of the universal suite — the
 * words a user reads a hundred times a day — plus two subtitles, and stops
 * there. General prose (empty states, help text, tour copy) is NOT in it:
 * rewriting a sentence can need an article, a plural agreement or a verb form
 * changed, and a pack author supplying a noun cannot be expected to keep every
 * sentence in the product reading correctly. That prose stays in neutral
 * English, which is true for everyone.
 *
 * Each entry MUST reproduce the neutral string exactly when given NEUTRAL —
 * `labelsFor` asserts this by omitting any entry that came out unchanged, so a
 * typo here degrades to "no override" rather than to a wrong label.
 */
const PHRASES: { neutral: string; build: (l: Record<LexiconKey, string>) => string }[] = [
  // Bare nouns — these are what a section heading is usually set to.
  { neutral: 'Customer', build: (l) => l.customer },
  { neutral: 'Customers', build: (l) => l.customer_plural },
  { neutral: 'Lead', build: (l) => l.lead },
  { neutral: 'Leads', build: (l) => l.lead_plural },
  { neutral: 'Product', build: (l) => l.product },
  { neutral: 'Products', build: (l) => l.product_plural },
  { neutral: 'Catalogue', build: (l) => l.catalogue },
  { neutral: 'Store', build: (l) => l.store },
  { neutral: 'Stores', build: (l) => l.store_plural },

  // Composite navigation titles, verbatim as navigation.ts spells them.
  { neutral: 'CRM & Leads', build: (l) => `CRM & ${l.lead_plural}` },
  { neutral: 'Store Setup', build: (l) => `${l.store} Setup` },
  { neutral: 'Store Comparison', build: (l) => `${l.store} Comparison` },

  // Primary-action buttons.
  { neutral: 'New Lead', build: (l) => `New ${l.lead}` },
  { neutral: 'Add Product', build: (l) => `Add ${l.product}` },
  { neutral: 'Add Store', build: (l) => `Add ${l.store}` },
  // The Customers screen writes its button label inline in lower case rather
  // than taking it from the navigation item, so it needs its own entry. Without
  // it a clinic reads "Patients" as the heading and "Add customer" on the button
  // directly beneath it.
  { neutral: 'Add customer', build: (l) => `Add ${l.customer.toLowerCase()}` },

  /*
   * Two subtitles, under the headings of the universal suite's busiest screens.
   *
   * Sentences are otherwise out of scope here — see the note above — and these
   * are the deliberate exception rather than the start of a general prose
   * facility. A clinic reading "Patients" above "Your store's customer
   * directory" learns immediately that the relabelling is skin deep, and these
   * three need nothing but the nouns in lower case. Any sentence that would need
   * an article, a plural agreement or a verb form changed does not belong here;
   * it belongs in neutral English.
   */
  /*
   * The CRM subtitle is deliberately NOT here. "Leads and follow-ups for every
   * customer enquiry." templates to "Enquiries and follow-ups for every patient
   * enquiry." — grammatical, and clumsy enough that neutral English reads
   * better. This is the line where the rule above stops being theoretical.
   */
  {
    neutral: "Your store's customer directory — contacts, purchase history and key dates.",
    build: (l) =>
      `Your ${l.store.toLowerCase()}'s ${l.customer.toLowerCase()} directory — contacts, purchase history and key dates.`,
  },
  {
    neutral: 'Browse products across stores; search by photo.',
    build: (l) =>
      `Browse ${l.product_plural.toLowerCase()} across ${l.store_plural.toLowerCase()}; search by photo.`,
  },
];

/** The longest a substituted label may be. A sidebar row is not a paragraph. */
export const MAX_LEXICON_TERM = 22;

/**
 * The label overrides for one pack: neutral string -> this industry's wording.
 *
 * Returns `{}` when the pack has no lexicon, and omits any label that resolved
 * back to its own neutral text, so the map contains only genuine differences.
 */
export function labelsFor(pack: Pick<IndustryPack, 'lexicon'> | undefined): Record<string, string> {
  const lexicon = pack?.lexicon;
  if (!lexicon || Object.keys(lexicon).length === 0) return {};

  const resolved: Record<LexiconKey, string> = { ...NEUTRAL };
  for (const [key, value] of Object.entries(lexicon) as [LexiconKey, string | undefined][]) {
    const word = value?.trim();
    // A blank or over-long override is dropped rather than rendered. A pack is
    // code and this should never happen, but a truncated sidebar is a visible
    // defect and falling back to the neutral word never is.
    if (word && word.length <= MAX_LEXICON_TERM) resolved[key] = word;
  }

  const out: Record<string, string> = {};
  for (const phrase of PHRASES) {
    const built = phrase.build(resolved);
    if (built !== phrase.neutral) out[phrase.neutral] = built;
  }
  return out;
}

/** Every noun this pack overrides, resolved against the neutral defaults. */
export function lexiconFor(pack: Pick<IndustryPack, 'lexicon'> | undefined): Record<LexiconKey, string> {
  const out: Record<LexiconKey, string> = { ...NEUTRAL };
  for (const [key, value] of Object.entries(pack?.lexicon ?? {}) as [LexiconKey, string | undefined][]) {
    const word = value?.trim();
    if (word && word.length <= MAX_LEXICON_TERM) out[key] = word;
  }
  return out;
}

/** Exposed for tests: the neutral wording every pack starts from. */
export const NEUTRAL_LEXICON: Readonly<Record<LexiconKey, string>> = NEUTRAL;

/** Exposed for tests: which labels this mechanism is allowed to touch. */
export const REWRITABLE_LABELS: readonly string[] = PHRASES.map((p) => p.neutral);

export type { PackLexicon };
