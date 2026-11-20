import { ProductCategory } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { CODE_GROUP } from './sync.util';

/**
 * The tenant's own reading of Gati's product-group codes.
 *
 * ## Why this is tenant data and not a constant
 *
 * `CODE_GROUP` in sync.util.ts is a map somebody worked out by reading design
 * codes: RG is a ring, NK a necklace. It covers what could be inferred and no
 * more. On the client's live catalogue 154 of 1,415 designs (11%) carry a code
 * that is not in it, so they classify as `other` and fall out of every filter.
 * The real list is Gati's own MainProductGroup master, which this install does
 * not sync, so the answer has to come from head office — and when it does it
 * must be a paste-and-apply, not another release.
 *
 * Guessing has already been tried and was wrong (NKERA and CRGB both looked
 * obvious and were neither), which is the other half of the argument: the only
 * safe source is the person who owns the master, so the product has to let
 * them type it in.
 *
 * ## Why Organisation.settings
 *
 * Same home as `crmAdSetRules`: a small, tenant-owned configuration bag that
 * one screen writes and the ingestion reads, with `updateOrgSettings` already
 * holding the row lock that keeps two savers from clobbering each other. A
 * table for what is at most a few dozen two-letter rows would need a migration,
 * its own scoping and its own CRUD, and would still be read on every sync batch
 * the same way this is.
 *
 * The built-in map stays as the FALLBACK, so an organisation that has entered
 * nothing classifies exactly as it does today; a tenant entry for the same code
 * wins.
 */
export const PRODUCT_GROUP_CODES_KEY = 'gatiProductGroupCodes';

/** Two-letter code -> the category it names. */
export type GroupCodeMap = Record<string, string>;

/** One line of head office's answer: "CR means a bracelet". */
export interface ProductGroupCode {
  /** The two letters as they appear in the design code, upper case. */
  code: string;
  category: ProductCategory;
  /** Gati's own wording for the group, kept so the next person can check it. */
  label: string | null;
}

/** The categories a code may name. Read off the enum so it cannot drift from it. */
export const GROUP_CATEGORIES = Object.values(ProductCategory);

/** Head office's longest sensible wording for a group. */
export const GROUP_LABEL_MAX = 60;

function isCategory(value: unknown): value is ProductCategory {
  return typeof value === 'string' && (GROUP_CATEGORIES as string[]).includes(value);
}

/**
 * Whatever is stored (or posted) read back as entries, with anything
 * unreadable dropped rather than trusted.
 *
 * Runs on READ as well as on write: a settings bag is years old by the time it
 * matters, and a half-written entry must not be able to classify a catalogue.
 * Later entries for the same code win, so a save never silently keeps a stale
 * duplicate of a row the screen believes it replaced.
 */
export function normaliseGroupCodes(value: unknown): ProductGroupCode[] {
  if (!Array.isArray(value)) return [];
  const byCode = new Map<string, ProductGroupCode>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as { code?: unknown; category?: unknown; label?: unknown };
    const code = String(entry.code ?? '')
      .replace(/[^A-Za-z]/g, '')
      .toUpperCase();
    if (code.length !== 2 || !isCategory(entry.category)) continue;
    const label = typeof entry.label === 'string' ? entry.label.trim().slice(0, GROUP_LABEL_MAX) : '';
    byCode.set(code, { code, category: entry.category, label: label || null });
  }
  return [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
}

/**
 * The map the classifier actually reads: the built-in codes, with the tenant's
 * own entries laid over the top.
 *
 * A tenant entry of `other` is an ANSWER, not a blank — "this code names
 * something the catalogue has no bucket for" (a coin, a nose pin). It therefore
 * wins over the English-word scan the classifier would otherwise fall back to,
 * which is the difference between a considered `other` and a guessed one.
 */
export function resolveGroupCodes(value: unknown): GroupCodeMap {
  const entries = normaliseGroupCodes(value);
  return { ...CODE_GROUP, ...Object.fromEntries(entries.map((e) => [e.code, e.category])) };
}

/**
 * One tenant's merged map, from the settings column.
 *
 * Callers read this ONCE PER BATCH, not per row: it is one small column and a
 * batch is thousands of rows. Deliberately not cached between batches either —
 * the point of the screen is that a correction reaches the next sync, and a
 * process-lifetime cache would make head office wait for a restart.
 */
export async function groupCodesFor(
  prisma: PrismaService,
  organisationId: string,
): Promise<GroupCodeMap> {
  const organisation = await prisma.organisation.findUnique({
    where: { id: organisationId },
    select: { settings: true },
  });
  const settings = (organisation?.settings ?? {}) as Record<string, unknown>;
  return resolveGroupCodes(settings[PRODUCT_GROUP_CODES_KEY]);
}

/**
 * The codes whose meaning moved between two versions of the list.
 *
 * Compared through the MERGED map, so re-stating a built-in code as what it
 * already meant is correctly no change at all — and a removed entry does count,
 * because its rows go back to whatever the built-in map (or the English-word
 * scan) makes of them, and leaving them under a reading head office has
 * withdrawn would be worse than either.
 */
export function changedGroupCodes(before: unknown, after: unknown): string[] {
  const was = resolveGroupCodes(before);
  const now = resolveGroupCodes(after);
  const codes = new Set([...Object.keys(was), ...Object.keys(now)]);
  return [...codes].filter((code) => was[code] !== now[code]).sort();
}
