import { BadRequestException } from '@nestjs/common';

/**
 * Per-tenant column formats for the exports the client named (21 Nov): the
 * Leads sheet and the NPS sheet.
 *
 * ## Why the tenant chooses at all
 *
 * The client does not read our workbook. She reads her own Master Leads
 * workbook, one tab per store, and reconciles ours against it by eye. Our
 * headings were ours — "Customer", "Created", "Value" — so every download needed
 * re-ordering and re-titling by hand before it could sit beside hers. The format
 * is therefore hers to declare, down to the spelling: her sheet says
 * "Product Catergory" and "Purchase Ocassion", and a column titled
 * "Product Category" is a column she has to go and rename.
 *
 * ## Why the catalogue is a constant and not free text
 *
 * A chooser that offers a column the export cannot fill produces a workbook with
 * a heading and nothing under it — and nobody finds out until the file is on
 * somebody else's desk. Every entry below is a field the builder genuinely
 * writes, and `sanitiseExportFormat` refuses anything that is not in the list.
 * Adding a column to a chooser means adding it to the builder first.
 */

/** The key this lives under in `Organisation.settings`. */
export const EXPORT_FORMATS_SETTINGS_KEY = 'exportFormats';

/** The exports a tenant may re-shape. Deliberately the two the client asked for. */
export const EXPORT_FORMAT_KINDS = ['leads', 'nps'] as const;
export type ExportFormatKind = (typeof EXPORT_FORMAT_KINDS)[number];

/** One column: which field fills it, and what the tenant calls it. */
export interface ExportColumnFormat {
  field: string;
  header: string;
}

/** One column the export can produce, as offered in the chooser. */
export interface ExportFieldSpec {
  field: string;
  /** Our own name for it, so the chooser is readable before anything is renamed. */
  label: string;
  /** What actually fills it. Shown in the chooser; prevents a wrong pick. */
  note: string;
  /** Column width, so the common case needs no resizing in Excel. */
  width: number;
}

/** Longest header we will write. Excel itself has no limit; a person does. */
const HEADER_MAX = 120;
/** A sheet past this many columns is not a sheet anybody reads. */
const COLUMNS_MAX = 60;

// ===================================================================== leads

/**
 * Every column the lead export can fill.
 *
 * The walk-in ones were added for the client's format: her sheet asks for the
 * customer type, product category and occasion that the WALK-IN REGISTER
 * records, so those read through the lead's most recent visit rather than off
 * the lead itself. A lead with no visit leaves them blank, which is the honest
 * answer — not "N/A", which reads as an answer somebody gave.
 */
export const LEAD_EXPORT_FIELDS: readonly ExportFieldSpec[] = [
  { field: 'serial', label: 'Row number', note: 'Counts 1, 2, 3 down the sheet.', width: 7 },
  { field: 'customerName', label: 'Customer', note: 'The name on the lead.', width: 26 },
  { field: 'phone', label: 'Phone', note: 'Blank if nobody captured a number.', width: 16 },
  { field: 'ref', label: 'Lead ref', note: 'Our reference for the lead.', width: 14 },
  { field: 'store', label: 'Store', note: 'The branch the lead belongs to.', width: 20 },
  {
    field: 'storeVisited',
    label: 'Store visited',
    note: 'The branch of their most recent walk-in. Blank if they never came in.',
    width: 20,
  },
  { field: 'owner', label: 'Salesperson', note: 'Who owns the lead.', width: 20 },
  {
    field: 'source',
    label: 'Source',
    note: 'Where the lead came from — walk-in, website, Meta ads.',
    width: 14,
  },
  {
    field: 'campaign',
    label: 'Campaign',
    note: 'The ad campaign. Blank for a lead that did not come from an ad.',
    width: 26,
  },
  { field: 'adId', label: 'Ad ID', note: 'Meta’s id for the ad. Blank for a walk-in.', width: 20 },
  {
    field: 'channel',
    label: 'Transaction channel',
    note: 'Website or Store, read from the source. Blank when the source does not say where the sale happened.',
    width: 20,
  },
  { field: 'location', label: 'Location (city)', note: 'The city on the lead.', width: 18 },
  {
    field: 'customerType',
    label: 'Customer type',
    note: 'New or repeat, as recorded on their most recent walk-in.',
    width: 14,
  },
  {
    field: 'productCategory',
    label: 'Product category',
    note: 'The category recorded on their most recent walk-in.',
    width: 18,
  },
  {
    field: 'interest',
    label: 'Product interested in',
    note: 'What the lead asked about.',
    width: 24,
  },
  {
    field: 'occasion',
    label: 'Occasion',
    note: 'The occasion recorded on their most recent walk-in.',
    width: 18,
  },
  { field: 'tags', label: 'Tags', note: 'Every tag on the lead, comma separated.', width: 28 },
  { field: 'stage', label: 'Stage', note: 'Where the lead sits on the board.', width: 14 },
  { field: 'outcome', label: 'Outcome', note: 'open, won or lost.', width: 12 },
  {
    field: 'purchaseStatus',
    label: 'Purchase / Non purchase',
    note: 'Purchase when won, Non-purchase when lost, blank while still open.',
    width: 22,
  },
  { field: 'value', label: 'Value', note: 'The value on the lead, whatever its outcome.', width: 14 },
  {
    field: 'salesValue',
    label: 'Sales value',
    note: 'The same amount, but only on a lead that was WON — so a column of these sums to real sales.',
    width: 14,
  },
  { field: 'createdAt', label: 'Date in', note: 'The day the lead arrived.', width: 12 },
  {
    field: 'saleDate',
    label: 'Sale date',
    note: 'The day a won lead closed. Blank unless it was won.',
    width: 12,
  },
  {
    field: 'lastActivity',
    label: 'Last activity',
    note: 'The last time anything happened on the lead.',
    width: 12,
  },
  {
    field: 'nextFollowUp',
    label: 'Next follow-up',
    note: 'The next follow-up still outstanding.',
    width: 14,
  },
  { field: 'visitCount', label: 'Visits', note: 'How many times they have walked in.', width: 8 },
  { field: 'remarks', label: 'Remarks', note: 'The most recent note on the lead.', width: 34 },
];

/**
 * The client's own Master Leads shape — her 20 columns, her order, her spelling.
 *
 * "Catergory" and "Ocassion" are typed exactly as her workbook has them. They
 * are not typos to fix: a heading that does not match hers is a heading somebody
 * renames by hand on every download, which is the work this feature removes.
 */
export const DEFAULT_LEAD_FORMAT: readonly ExportColumnFormat[] = [
  { field: 'serial', header: 'No.' },
  { field: 'createdAt', header: 'Date' },
  { field: 'customerName', header: 'Customer Name' },
  { field: 'phone', header: 'Contact No (Lead)' },
  { field: 'location', header: 'Location (City)' },
  { field: 'customerType', header: 'Customer Type' },
  { field: 'productCategory', header: 'Product Catergory' },
  { field: 'interest', header: 'Product Interested in' },
  { field: 'storeVisited', header: 'Store Visited' },
  { field: 'purchaseStatus', header: 'Status (Purchase / Non purchase)' },
  { field: 'value', header: 'Value of Purchase Made' },
  { field: 'source', header: 'Lead Source 1' },
  { field: 'campaign', header: 'Lead Source 2' },
  { field: 'store', header: 'Store Name' },
  { field: 'owner', header: 'Salesperson Name' },
  { field: 'salesValue', header: 'Sales Rs' },
  { field: 'saleDate', header: 'Sale Date' },
  { field: 'channel', header: 'Transaction channel (Website, Store)' },
  { field: 'remarks', header: 'Remarks' },
  { field: 'occasion', header: 'Purchase Ocassion' },
];

// ======================================================================= nps

/**
 * Every column the NPS Responses sheet can fill.
 *
 * The first twelve are the client's form, stored one-to-one in `NpsResponse` —
 * which is why the default below can be her tab exactly. The rest are ours:
 * whether we managed to tie the submission to a customer, and the visit it
 * belongs to.
 */
export const NPS_EXPORT_FIELDS: readonly ExportFieldSpec[] = [
  { field: 'submittedAt', label: 'Submitted', note: 'When the customer sent the form.', width: 18 },
  { field: 'rawName', label: 'Name', note: 'The name the customer typed, untouched.', width: 22 },
  {
    field: 'rawNumber',
    label: 'Number',
    note: 'The number the customer typed, untouched.',
    width: 15,
  },
  { field: 'firstPurchase', label: 'First purchase?', note: 'Their answer, in their words.', width: 30 },
  {
    field: 'recommendAnswer',
    label: 'Would recommend',
    note: 'Their answer, in their words.',
    width: 34,
  },
  { field: 'visitPurpose', label: 'Purpose of visit', note: 'Their answer, in their words.', width: 30 },
  { field: 'likedMost', label: 'Liked most', note: 'Their answer, in their words.', width: 34 },
  { field: 'couldImprove', label: 'Could improve', note: 'Their answer, in their words.', width: 34 },
  { field: 'notFound', label: 'Not found in store', note: 'Their answer, in their words.', width: 34 },
  { field: 'heardAboutUs', label: 'Heard about us', note: 'Their answer, in their words.', width: 28 },
  {
    field: 'followsSocial',
    label: 'Follows on social',
    note: 'Their answer, in their words.',
    width: 28,
  },
  { field: 'concerns', label: 'Concerns', note: 'Their answer, in their words.', width: 34 },
  {
    field: 'score',
    label: 'Score',
    note: 'The 0-10 score read out of their recommend answer. Blank when it did not read as a number.',
    width: 8,
  },
  {
    field: 'matchState',
    label: 'Match',
    note: 'Whether we tied the submission to a customer.',
    width: 12,
  },
  { field: 'matchNote', label: 'Match note', note: 'Why it matched, or why it could not.', width: 40 },
  {
    field: 'customer',
    label: 'Customer',
    note: 'The customer it was tied to. Blank when unmatched.',
    width: 24,
  },
  {
    field: 'store',
    label: 'Store',
    note: 'The branch of the visit it was tied to. Blank when unmatched.',
    width: 20,
  },
  {
    field: 'visitAt',
    label: 'Visit date',
    note: 'The visit it was tied to. Blank when unmatched.',
    width: 16,
  },
];

/**
 * The client's NPS Responses tab, question for question.
 *
 * Her headings ARE the questions — the full sentence, not a short label — because
 * her sheet is the Google Form's own output. Shortening them would make our file
 * stop lining up with hers.
 *
 * Match and Match note are ours and are kept on the end: they are the only
 * columns that explain a blank customer, and they have shipped since the sheet
 * existed, so dropping them from the default would quietly remove a column
 * people already read.
 */
export const DEFAULT_NPS_FORMAT: readonly ExportColumnFormat[] = [
  { field: 'submittedAt', header: 'Timestamp' },
  { field: 'rawName', header: 'Name' },
  { field: 'rawNumber', header: 'Number' },
  { field: 'firstPurchase', header: 'Is this your first purchase with Nibhana?' },
  {
    field: 'recommendAnswer',
    header: 'How likely are you to recommend Nibhana to your friends and family?',
  },
  { field: 'visitPurpose', header: 'What was the purpose of your visit?' },
  { field: 'likedMost', header: 'What is the one thing you liked about our products and services?' },
  {
    field: 'couldImprove',
    header: 'What is the one thing we could improve to serve you better next time?',
  },
  {
    field: 'notFound',
    header: 'Was there any product you were searching for but didn’t find in our store?',
  },
  { field: 'heardAboutUs', header: 'How did you come to know about us?' },
  { field: 'followsSocial', header: 'Do you follow our brand on social media?' },
  { field: 'concerns', header: 'Kindly share your concerns or suggestions, if any' },
  { field: 'matchState', header: 'Match' },
  { field: 'matchNote', header: 'Match note' },
];

// ================================================================== plumbing

export function exportFieldCatalogue(kind: ExportFormatKind): readonly ExportFieldSpec[] {
  return kind === 'leads' ? LEAD_EXPORT_FIELDS : NPS_EXPORT_FIELDS;
}

export function defaultExportFormat(kind: ExportFormatKind): readonly ExportColumnFormat[] {
  return kind === 'leads' ? DEFAULT_LEAD_FORMAT : DEFAULT_NPS_FORMAT;
}

export function exportFieldWidth(kind: ExportFormatKind, field: string): number {
  return exportFieldCatalogue(kind).find((f) => f.field === field)?.width ?? 18;
}

/**
 * The format this tenant has configured, or the default.
 *
 * Tolerant on read and strict on write. A stored format is replayed through the
 * catalogue and anything unrecognised is DROPPED rather than throwing: a field
 * retired in a later release must not make a tenant's every export fail — it
 * must make that one column disappear. If dropping leaves nothing, the default
 * comes back, because a workbook with no columns is not a smaller workbook.
 */
export function readExportFormat(
  settings: unknown,
  kind: ExportFormatKind,
): readonly ExportColumnFormat[] {
  const bag = asObject(asObject(settings)[EXPORT_FORMATS_SETTINGS_KEY]);
  const stored = bag[kind];
  if (!Array.isArray(stored)) return defaultExportFormat(kind);

  const catalogue = exportFieldCatalogue(kind);
  const known = new Set(catalogue.map((f) => f.field));
  const kept: ExportColumnFormat[] = [];
  const seen = new Set<string>();
  for (const entry of stored) {
    const { field, header } = asObject(entry);
    if (typeof field !== 'string' || !known.has(field) || seen.has(field)) continue;
    seen.add(field);
    kept.push({
      field,
      header:
        typeof header === 'string' && header.trim()
          ? header.trim().slice(0, HEADER_MAX)
          : (catalogue.find((f) => f.field === field)?.label ?? field),
    });
  }
  return kept.length ? kept : defaultExportFormat(kind);
}

/**
 * Validate a format on its way in.
 *
 * Refuses rather than repairs. A tenant arranging their own sheet gets told
 * which column is the problem; silently dropping it would have them discover the
 * gap in the next download, by which time they no longer know what they changed.
 */
export function sanitiseExportFormat(kind: ExportFormatKind, input: unknown): ExportColumnFormat[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new BadRequestException('Choose at least one column.');
  }
  if (input.length > COLUMNS_MAX) {
    throw new BadRequestException(`A sheet takes at most ${COLUMNS_MAX} columns.`);
  }

  const catalogue = exportFieldCatalogue(kind);
  const out: ExportColumnFormat[] = [];
  const seen = new Set<string>();
  for (const entry of input) {
    const obj = asObject(entry);
    const field = typeof obj.field === 'string' ? obj.field.trim() : '';
    const spec = catalogue.find((f) => f.field === field);
    if (!spec) {
      throw new BadRequestException(
        `"${field || 'blank'}" is not a column this export can fill.`,
      );
    }
    if (seen.has(field)) throw new BadRequestException(`"${spec.label}" is in the sheet twice.`);
    seen.add(field);

    const header = typeof obj.header === 'string' ? obj.header.trim() : '';
    if (header.length > HEADER_MAX) {
      throw new BadRequestException(
        `The heading for "${spec.label}" is over ${HEADER_MAX} characters.`,
      );
    }
    out.push({ field, header: header || spec.label });
  }
  return out;
}

/** Merge one kind's format into the settings bag, leaving every other key alone. */
export function withExportFormat(
  current: Record<string, unknown>,
  kind: ExportFormatKind,
  columns: ExportColumnFormat[] | null,
): Record<string, unknown> {
  const bag = { ...asObject(current[EXPORT_FORMATS_SETTINGS_KEY]) };
  // null is "go back to the default", which is an ABSENT key — not an empty
  // array, whose meaning `readExportFormat` would then have to guess.
  if (columns === null) delete bag[kind];
  else bag[kind] = columns;
  return { ...current, [EXPORT_FORMATS_SETTINGS_KEY]: bag };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
