import { BadRequestException } from '@nestjs/common';
import { Workbook, type Worksheet } from 'exceljs';
import JSZip from 'jszip';
import { Readable } from 'node:stream';

import { DEFAULT_TZ, instantFromLocalTime } from '../common/tz.util';
import { MAX_IMPORT_ROWS } from '../integration/import/csv.util';
import type { NpsFollowupRow, NpsResponseRow } from './nps.service';

/**
 * Reading the client's NPS workbook.
 *
 * The file that arrives is the Google Sheet behind her forms, exported whole:
 * ten tabs, of which two matter. So sheets are found BY NAME rather than by
 * position — the generic import parser reads worksheet 1, which in her export
 * is the walk-in register, and feeding that to the response importer would have
 * produced ten pages of nonsense.
 *
 * Everything here is deliberately tolerant. The headers are her form's
 * questions, re-worded whenever she edits the form, so a column is recognised
 * by a distinctive phrase inside it and an unrecognised column is ignored
 * rather than refused. The one column that cannot be missing is the timestamp:
 * it is half of the import key, and without it a re-upload would duplicate
 * every row instead of updating it.
 */

/** The tabs as the client's workbook spells them today. */
export const NPS_RESPONSES_SHEET = 'NPS Responses';
export const NPS_FOLLOWUPS_SHEET = 'Followup answers';

/** Same ceilings as the generic XLSX import: a 16 MiB entry, 32 MiB expanded. */
const MAX_XLSX_ENTRIES = 1_024;
const MAX_XLSX_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_XLSX_EXPANDED_BYTES = 32 * 1024 * 1024;

/** A cell, flattened to the three things the importers can actually read. */
export type SheetCell = string | number | Date | null;

export interface SheetTable {
  /** The tab's own name, so a summary can say which sheet it read. */
  name: string;
  headers: string[];
  rows: SheetCell[][];
  /** One-based physical row of each entry, so a skipped row can be named. */
  rowNumbers: number[];
}

/** A source row that could not become a record, and why — never dropped silently. */
export interface SkippedRow {
  row: number;
  reason: string;
}

export interface MappedRows<T> {
  rows: T[];
  skipped: SkippedRow[];
  /** Headers that matched no question, reported so a renamed column is noticed. */
  ignoredColumns: string[];
}

export interface NpsSheetNames {
  responsesSheet?: string;
  followupsSheet?: string;
}

export interface NpsUploadTables {
  responses: SheetTable | null;
  followups: SheetTable | null;
  /** Every tab in the workbook, for an error message that can be acted on. */
  sheetNames: string[];
}

/**
 * Compare headers and sheet names the way a person does: the trailing space
 * somebody typed after "Timestamp ", the capital she changed, and the curly
 * apostrophe Google substitutes into "didn't" are all the same column.
 */
export function normaliseHeader(raw: string): string {
  return raw
    .replace(/[\u00a0\u200b\ufeff]/g, ' ')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * Flatten an ExcelJS cell.
 *
 * Unlike the onboarding import, a formula cell is read at its cached result
 * instead of refusing the file. The stakes are opposite: there, a stale cached
 * number would be imported as stock on hand; here the worst case is one
 * free-text answer reading as it did when the sheet was last opened, and
 * refusing the upload would leave NPS with no route in at all.
 */
export function cellValue(v: unknown): SheetCell {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return v.trim() || null;
  // A checkbox question ("Do you follow our brand on social media?") arrives as
  // a boolean; the sheet's own wording for it is Yes/No.
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  const o = v as Record<string, unknown>;
  if ('result' in o) return cellValue(o.result);
  if ('richText' in o && Array.isArray(o.richText)) {
    return cellValue((o.richText as { text?: unknown }[]).map((r) => String(r.text ?? '')).join(''));
  }
  if ('text' in o) return cellValue(o.text);
  if ('hyperlink' in o) return cellValue(o.text ?? o.hyperlink);
  // #N/A and friends arrive as { error }. Losing the cell keeps the row.
  return null;
}

const YEAR_MIN = 2000;
const YEAR_MAX = 2100;
/** Excel serial days for 2000-01-01 … 2100-01-01, used to sanity-check a bare number. */
const SERIAL_MIN = 36_526;
const SERIAL_MAX = 73_415;
const EXCEL_EPOCH_OFFSET_DAYS = 25_569; // 1899-12-30 → 1970-01-01
const DAY_MS = 86_400_000;

const ISO_LIKE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/;
const DMY_LIKE =
  /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[T ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*(am|pm)?/i;
const EXPLICIT_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * A sheet timestamp as a real instant.
 *
 * Both readings here are the same decision: a timestamp on the client's sheet
 * is a wall clock in the shop's own timezone, with no offset written down. A
 * form filled at 13:08 in Nagpur is 07:38 UTC, and taking the digits as UTC
 * would place the submission five and a half hours later than it happened —
 * long enough to pull in a visit from that afternoon and match the feedback to
 * the wrong one of a repeat customer's two visits.
 *
 * ExcelJS hands a date cell back as the naive wall clock labelled UTC, so its
 * UTC components are read and re-anchored; a text cell is parsed and anchored
 * the same way. Day-before-month is assumed when the first number could be
 * either: the sheet is a Google Form in India, and `en-IN` writes 05/11/2026 to
 * mean 5 November.
 */
export function parseNpsTimestamp(value: SheetCell, tz: string = DEFAULT_TZ): Date | null {
  if (value == null) return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return anchor(
      value.getUTCFullYear(),
      value.getUTCMonth() + 1,
      value.getUTCDate(),
      value.getUTCHours(),
      value.getUTCMinutes(),
      value.getUTCSeconds(),
      tz,
    );
  }

  if (typeof value === 'number') {
    if (value < SERIAL_MIN || value > SERIAL_MAX) return null;
    const asUtc = new Date(Math.round((value - EXCEL_EPOCH_OFFSET_DAYS) * DAY_MS));
    return parseNpsTimestamp(asUtc, tz);
  }

  const text = value.trim();
  if (!text) return null;

  // A string that states its own offset is already unambiguous; trust it.
  if (EXPLICIT_ZONE.test(text)) {
    const explicit = new Date(text);
    return Number.isNaN(explicit.getTime()) ? null : explicit;
  }

  const iso = ISO_LIKE.exec(text);
  if (iso) {
    return anchor(+iso[1], +iso[2], +iso[3], +(iso[4] ?? 0), +(iso[5] ?? 0), +(iso[6] ?? 0), tz);
  }

  const dmy = DMY_LIKE.exec(text);
  if (dmy) {
    const year = +dmy[3] < 100 ? 2000 + +dmy[3] : +dmy[3];
    let hour = +(dmy[4] ?? 0);
    const meridiem = dmy[7]?.toLowerCase();
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    return anchor(year, +dmy[2], +dmy[1], hour, +(dmy[5] ?? 0), +(dmy[6] ?? 0), tz);
  }

  // A written-out month ("13 Nov 2026 1:08 pm") is unambiguous either way round.
  if (/[A-Za-z]{3}/.test(text)) {
    const spelled = new Date(text);
    if (!Number.isNaN(spelled.getTime())) {
      // Its LOCAL components, not its UTC ones: `new Date(string)` with no zone
      // in the string resolves against the server's zone, so the local reading
      // is the wall clock the sheet wrote — re-anchoring the UTC side would
      // shift it twice on any server that is not already on UTC.
      return anchor(
        spelled.getFullYear(),
        spelled.getMonth() + 1,
        spelled.getDate(),
        spelled.getHours(),
        spelled.getMinutes(),
        spelled.getSeconds(),
        tz,
      );
    }
  }
  return null;
}

/** A local wall clock in `tz` as the UTC instant it names. */
function anchor(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  tz: string,
): Date | null {
  if (year < YEAR_MIN || year > YEAR_MAX) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  const instant = instantFromLocalTime(date, hour * 60 + minute, tz);
  return new Date(instant.getTime() + second * 1000);
}

type ColumnRule<F extends string> = [field: F, test: (header: string) => boolean];

type ResponseField =
  | 'submittedAt'
  | 'name'
  | 'number'
  | 'firstPurchase'
  | 'recommendAnswer'
  | 'visitPurpose'
  | 'likedMost'
  | 'couldImprove'
  | 'notFound'
  | 'heardAboutUs'
  | 'followsSocial'
  | 'concerns';

type FollowupField = 'submittedAt' | 'followupDate' | 'name' | 'number' | 'response';

const has =
  (...needles: string[]) =>
  (header: string) =>
    needles.some((n) => header.includes(n));

const TIMESTAMP: ColumnRule<'submittedAt'> = [
  'submittedAt',
  has('timestamp', 'submitted', 'submission time'),
];
const NAME: ColumnRule<'name'> = [
  'name',
  (h) => h === 'name' || has('your name', 'customer name', 'full name')(h),
];
const NUMBER: ColumnRule<'number'> = [
  'number',
  (h) =>
    h === 'number' || has('phone', 'mobile', 'whatsapp', 'contact number', 'contact no')(h),
];

/**
 * The client's NPS form, question by question. Each test is the shortest phrase
 * that is unique to its question, because the full wording changes: "How likely
 * are you to recommend Nibhana…" has already been through two spellings of the
 * brand name, and matching the whole sentence would have dropped the score
 * column the day she edited it.
 */
const RESPONSE_COLUMNS: ColumnRule<ResponseField>[] = [
  TIMESTAMP,
  NUMBER,
  NAME,
  ['firstPurchase', has('first purchase')],
  ['recommendAnswer', has('recommend')],
  ['visitPurpose', has('purpose of your visit', 'purpose of visit', 'purpose of the visit')],
  ['likedMost', has('liked')],
  ['couldImprove', has('improve')],
  ['notFound', has("didn't find", 'did not find', 'searching for', 'not available')],
  ['heardAboutUs', has('come to know', 'hear about', 'know about us', 'how did you find')],
  ['followsSocial', has('social media', 'follow our brand', 'follow us')],
  ['concerns', has('concern', 'suggestion')],
];

const FOLLOWUP_COLUMNS: ColumnRule<FollowupField>[] = [
  TIMESTAMP,
  [
    'followupDate',
    (h) => has('followup date', 'follow-up date', 'follow up date')(h) || h === 'date',
  ],
  NUMBER,
  NAME,
  ['response', has('response', 'answer', 'feedback', 'remark', 'what did they say')],
];

/**
 * Which column holds which question.
 *
 * A header is tested against the rules in order and takes the FIRST rule it
 * matches; if that question already has a column, the header is ignored rather
 * than handed to the next rule that happens to match — a duplicated column
 * keeps the leftmost one, and never lands under a different question.
 */
export function mapColumns<F extends string>(
  headers: string[],
  rules: ColumnRule<F>[],
): { index: Partial<Record<F, number>>; ignored: string[] } {
  const index: Partial<Record<F, number>> = {};
  const ignored: string[] = [];
  headers.forEach((header, position) => {
    const h = normaliseHeader(header);
    if (!h) return; // A stray empty column is not an error, it is nothing.
    const rule = rules.find(([, test]) => test(h));
    if (!rule || index[rule[0]] !== undefined) {
      ignored.push(header.trim());
      return;
    }
    index[rule[0]] = position;
  });
  return { index, ignored };
}

const NO_TIMESTAMP =
  'No usable timestamp, so the row has no stable identity and a re-upload would duplicate it.';

export function mapResponseRows(
  table: SheetTable,
  tz: string = DEFAULT_TZ,
): MappedRows<NpsResponseRow> {
  const { index, ignored } = mapColumns(table.headers, RESPONSE_COLUMNS);
  requireTimestamp(table, index.submittedAt);

  const rows: NpsResponseRow[] = [];
  const skipped: SkippedRow[] = [];
  table.rows.forEach((row, i) => {
    const at = (field: ResponseField): SheetCell => pick(row, index[field]);
    if (!row.some((cell) => cell != null)) return;
    const submittedAt = parseNpsTimestamp(at('submittedAt'), tz);
    if (!submittedAt) {
      skipped.push({ row: table.rowNumbers[i], reason: NO_TIMESTAMP });
      return;
    }
    // A row with no number is kept deliberately: the importer records it as
    // unmatched, which is a fact somebody can act on, and dropping it here
    // would make the sheet and the screen disagree about how many people answered.
    rows.push({
      submittedAt,
      name: at('name'),
      number: at('number'),
      firstPurchase: at('firstPurchase'),
      recommendAnswer: at('recommendAnswer'),
      visitPurpose: at('visitPurpose'),
      likedMost: at('likedMost'),
      couldImprove: at('couldImprove'),
      notFound: at('notFound'),
      heardAboutUs: at('heardAboutUs'),
      followsSocial: at('followsSocial'),
      concerns: at('concerns'),
    });
  });
  return { rows, skipped, ignoredColumns: ignored };
}

export function mapFollowupRows(
  table: SheetTable,
  tz: string = DEFAULT_TZ,
): MappedRows<NpsFollowupRow> {
  const { index, ignored } = mapColumns(table.headers, FOLLOWUP_COLUMNS);
  requireTimestamp(table, index.submittedAt);

  const rows: NpsFollowupRow[] = [];
  const skipped: SkippedRow[] = [];
  table.rows.forEach((row, i) => {
    const at = (field: FollowupField): SheetCell => pick(row, index[field]);
    if (!row.some((cell) => cell != null)) return;
    const submittedAt = parseNpsTimestamp(at('submittedAt'), tz);
    if (!submittedAt) {
      skipped.push({ row: table.rowNumbers[i], reason: NO_TIMESTAMP });
      return;
    }
    rows.push({
      submittedAt,
      // The date somebody chased them on is the sheet's own column and is
      // optional: an unreadable or absent one costs the date, not the answer.
      followupDate: parseNpsTimestamp(at('followupDate'), tz),
      name: at('name'),
      number: at('number'),
      response: at('response'),
    });
  });
  return { rows, skipped, ignoredColumns: ignored };
}

function pick(row: SheetCell[], position: number | undefined): SheetCell {
  return position === undefined ? null : row[position] ?? null;
}

function requireTimestamp(table: SheetTable, position: number | undefined): void {
  if (position === undefined) {
    throw new BadRequestException(
      `The "${table.name}" sheet has no Timestamp column, so its rows cannot be identified. Found: ${
        table.headers.filter((h) => h.trim()).join(', ') || 'no headers at all'
      }.`,
    );
  }
}

/** Read the two sheets that matter out of whatever she exported. */
export async function readNpsUpload(
  buffer: Buffer,
  filename?: string,
  names: NpsSheetNames = {},
): Promise<NpsUploadTables> {
  const wanted = {
    responses: names.responsesSheet?.trim() || NPS_RESPONSES_SHEET,
    followups: names.followupsSheet?.trim() || NPS_FOLLOWUPS_SHEET,
  };

  if (isXlsx(buffer, filename)) {
    await assertSafeArchive(buffer);
    const wb = new Workbook();
    try {
      await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    } catch {
      throw new BadRequestException('The XLSX file is malformed or unsupported.');
    }
    const sheetNames = wb.worksheets.map((ws) => ws.name);
    const responses = findSheet(wb, wanted.responses);
    const followups = findSheet(wb, wanted.followups);
    if (!responses && !followups) {
      throw new BadRequestException(
        `Neither "${wanted.responses}" nor "${wanted.followups}" is in this workbook. It has: ${
          sheetNames.join(', ') || 'no sheets'
        }.`,
      );
    }
    return {
      responses: responses ? toTable(responses) : null,
      followups: followups ? toTable(followups) : null,
      sheetNames,
    };
  }

  const table = await readCsv(buffer, filename);
  // A single-tab CSV cannot say which sheet it is, so its own columns decide.
  // The score question only exists on the responses form.
  if (mapColumns(table.headers, RESPONSE_COLUMNS).index.recommendAnswer !== undefined) {
    return { responses: table, followups: null, sheetNames: [table.name] };
  }
  if (mapColumns(table.headers, FOLLOWUP_COLUMNS).index.response !== undefined) {
    return { responses: null, followups: table, sheetNames: [table.name] };
  }
  throw new BadRequestException(
    `This CSV looks like neither the NPS responses nor the follow-up answers — no "how likely are you to recommend" column and no response column. Found: ${
      table.headers.filter((h) => h.trim()).join(', ') || 'no headers at all'
    }.`,
  );
}

function isXlsx(buffer: Buffer, filename?: string): boolean {
  // Sniffed, not trusted to the name: a .xlsx that is really a CSV (and the
  // reverse) is how a spreadsheet gets "saved as" in a hurry.
  if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) return true;
  return /\.xlsx?$/i.test(filename ?? '') && buffer.length >= 2 && buffer[0] === 0x50;
}

function findSheet(wb: Workbook, wanted: string): Worksheet | undefined {
  const key = normaliseHeader(wanted);
  return (
    wb.worksheets.find((ws) => normaliseHeader(ws.name) === key) ??
    // "NPS Responses (Form responses 1)" is still the NPS responses tab.
    wb.worksheets.find((ws) => normaliseHeader(ws.name).includes(key))
  );
}

async function readCsv(buffer: Buffer, filename?: string): Promise<SheetTable> {
  const wb = new Workbook();
  let ws: Worksheet;
  try {
    ws = await wb.csv.read(Readable.from(buffer), {
      sheetName: filename ?? 'CSV',
      /*
       * Every cell stays the text it was in the file. ExcelJS's default CSV
       * mapper runs dayjs over each value, which would read 05/11/2026 as 5
       * November or 11 May depending on which of its formats matched first;
       * `parseNpsTimestamp` makes that call once, explicitly, for both formats.
       */
      map: (datum: string) => (datum === '' ? null : datum),
    });
  } catch {
    throw new BadRequestException('The CSV file could not be read.');
  }
  return toTable(ws);
}

function toTable(ws: Worksheet): SheetTable {
  const headerRow = ws.getRow(1);
  const width = headerRow.cellCount;
  if (!width) return { name: ws.name, headers: [], rows: [], rowNumbers: [] };
  const headers = Array.from({ length: width }, (_, i) =>
    String(cellValue(headerRow.getCell(i + 1).value) ?? ''),
  );

  const rows: SheetCell[][] = [];
  const rowNumbers: number[] = [];
  const last = Math.min(ws.rowCount, MAX_IMPORT_ROWS + 1);
  for (let rowNumber = 2; rowNumber <= last; rowNumber++) {
    const row = ws.getRow(rowNumber);
    const cells = Array.from({ length: width }, (_, i) => cellValue(row.getCell(i + 1).value));
    if (!cells.some((cell) => cell != null)) continue;
    rows.push(cells);
    rowNumbers.push(rowNumber);
  }
  if (ws.rowCount > MAX_IMPORT_ROWS + 1) {
    throw new BadRequestException(
      `The "${ws.name}" sheet has more than ${MAX_IMPORT_ROWS} rows. Split it before uploading.`,
    );
  }
  return { name: ws.name, headers, rows, rowNumbers };
}

/**
 * XLSX is a ZIP, and the multipart limit only bounds the COMPRESSED bytes: a
 * few-hundred-kilobyte archive of repeated text can expand into hundreds of
 * megabytes and take the API process down with it. Every entry is therefore
 * streamed once against an expanded-size ceiling before ExcelJS is allowed to
 * build a workbook out of it.
 *
 * The onboarding import guards itself the same way, with the same ceilings, but
 * its scan is private to that pipeline and reads worksheet 1 only — which is
 * the one sheet this import must not read.
 */
async function assertSafeArchive(buffer: Buffer): Promise<void> {
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(buffer, { createFolders: false });
  } catch {
    throw new BadRequestException('The XLSX file is not a valid ZIP archive.');
  }
  const all = Object.values(archive.files);
  if (all.length > MAX_XLSX_ENTRIES) {
    throw new BadRequestException(
      `XLSX files may contain at most ${MAX_XLSX_ENTRIES} archive entries.`,
    );
  }
  if (all.some((entry) => entry.name.startsWith('/') || entry.name.includes('\0'))) {
    throw new BadRequestException('The XLSX archive contains a non-canonical entry path.');
  }

  let expandedTotal = 0;
  for (const entry of all.filter((e) => !e.dir)) {
    await new Promise<void>((resolve, reject) => {
      let expandedEntry = 0;
      let settled = false;
      const stream = entry.nodeStream('nodebuffer') as Readable;
      const refuse = (message: string) => {
        if (settled) return;
        settled = true;
        stream.destroy();
        reject(new BadRequestException(message));
      };
      stream.on('data', (chunk: Buffer) => {
        expandedEntry += chunk.length;
        expandedTotal += chunk.length;
        if (expandedEntry > MAX_XLSX_ENTRY_BYTES) {
          refuse('An XLSX archive entry expands beyond the safe 16 MiB limit.');
        } else if (expandedTotal > MAX_XLSX_EXPANDED_BYTES) {
          refuse('The XLSX archive expands beyond the safe 32 MiB limit.');
        }
      });
      stream.once('error', () => refuse('The XLSX archive contains corrupt data.'));
      stream.once('end', () => {
        if (settled) return;
        settled = true;
        resolve();
      });
    });
  }
}
