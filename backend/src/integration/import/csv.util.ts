import { BadRequestException } from '@nestjs/common';

/**
 * CaratOS import — minimal, dependency-free CSV parser.
 *
 * Handles the real-world messiness of exported spreadsheets: quoted fields,
 * commas and newlines inside quotes, escaped double-quotes (""), and a trailing
 * newline. Deliberately NOT a full RFC-4180 streaming parser — onboarding files
 * are bounded (a shop's customer/stock list), so a correct in-memory pass is
 * enough. Excel (.xlsx) is a separate parser (needs a lib) and plugs in behind
 * the same {@link ParsedTable} shape.
 */

export interface ParsedTable {
  /** Column headers, in source order, trimmed. */
  headers: string[];
  /** Data rows as arrays aligned to `headers` (short rows padded with ''). */
  rows: string[][];
  /** One-based physical source row where each data record begins. */
  rowNumbers: number[];
}

export const MAX_IMPORT_ROWS = 20_000;
export const MAX_IMPORT_COLUMNS = 256;
/** Canonical table limits shared by CSV and XLSX, before any field mapping runs. */
export const MAX_IMPORT_CELLS = 1_000_000;
export const MAX_IMPORT_CELL_CHARACTERS = 16_384;
export const MAX_IMPORT_ROW_CHARACTERS = 256 * 1024;
export const MAX_IMPORT_CANONICAL_CHARACTERS = 8 * 1024 * 1024;
const UNSAFE_IMPORT_CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

interface CsvRecord {
  cells: string[];
  /** One-based physical line where the logical CSV record starts. */
  rowNumber: number;
}

/**
 * Incremental canonical-table budget used by both parsers. Counting padded cells
 * matters: a narrow-looking sparse file can otherwise expand to rows x headers
 * once it enters the mapper.
 */
export class ImportTableBudget {
  private cells = 0;
  private characters = 0;

  addRow(row: readonly string[], rowNumber: number): void {
    this.cells += row.length;
    if (this.cells > MAX_IMPORT_CELLS) {
      throw new BadRequestException(
        `Import files may contain at most ${MAX_IMPORT_CELLS} canonical cells.`,
      );
    }

    let rowCharacters = 0;
    for (const cell of row) {
      if (UNSAFE_IMPORT_CONTROL_CHARACTERS.test(cell)) {
        throw new BadRequestException(
          `Import row ${rowNumber} contains an unsupported control character.`,
        );
      }
      if (cell.length > MAX_IMPORT_CELL_CHARACTERS) {
        throw new BadRequestException(
          `Import row ${rowNumber} contains a cell longer than ${MAX_IMPORT_CELL_CHARACTERS} characters.`,
        );
      }
      rowCharacters += cell.length;
    }
    if (rowCharacters > MAX_IMPORT_ROW_CHARACTERS) {
      throw new BadRequestException(
        `Import row ${rowNumber} contains more than ${MAX_IMPORT_ROW_CHARACTERS} characters.`,
      );
    }
    this.characters += rowCharacters;
    if (this.characters > MAX_IMPORT_CANONICAL_CHARACTERS) {
      throw new BadRequestException(
        `Import files may contain at most ${MAX_IMPORT_CANONICAL_CHARACTERS} canonical characters.`,
      );
    }
  }
}

/** Parse CSV text into headers + rows. Empty input yields no headers, no rows. */
export function parseCsv(text: string): ParsedTable {
  const records = splitRecords(text);
  if (records.length === 0) return { headers: [], rows: [], rowNumbers: [] };
  const headers = records[0].cells.map((h) => h.trim());
  assertHeaders(headers);
  const width = headers.length;
  const budget = new ImportTableBudget();
  budget.addRow(headers, records[0].rowNumber);
  const rows: string[][] = [];
  const rowNumbers: number[] = [];
  for (const record of records.slice(1)) {
    const { cells, rowNumber } = record;
    // Drop wholly-empty physical rows (including a final newline record).
    if (cells.length === 1 && cells[0] === '') continue;
    if (cells.length > width && cells.slice(width).some((cell) => cell !== '')) {
      throw new BadRequestException(
        `CSV row ${rowNumber} has data beyond the ${width}-column header.`,
      );
    }
    const out = cells.slice(0, width);
    while (out.length < width) out.push('');
    budget.addRow(out, rowNumber);
    rows.push(out);
    rowNumbers.push(rowNumber);
  }
  return { headers, rows, rowNumbers };
}

/** Split raw CSV into an array of fields-per-record, quote-aware. */
function splitRecords(text: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let quotedFieldClosed = false;
  let physicalLine = 1;
  let recordStartLine = 1;
  let sourceCells = 0;
  // Normalise CRLF/CR to LF so a quoted newline is a single char.
  const s = text.replace(/\r\n?/g, '\n');

  const pushField = () => {
    record.push(field);
    sourceCells++;
    if (sourceCells > MAX_IMPORT_CELLS) {
      throw new BadRequestException(
        `Import files may contain at most ${MAX_IMPORT_CELLS} source cells.`,
      );
    }
  };

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++; // skip the escaped quote
        } else {
          inQuotes = false;
          quotedFieldClosed = true;
        }
      } else {
        field += c;
        if (c === '\n') physicalLine++;
      }
    } else if (c === '"') {
      if (field.length > 0 || quotedFieldClosed) {
        throw new BadRequestException(
          'CSV contains a quote in an unquoted field.',
        );
      }
      inQuotes = true;
    } else if (c === ',') {
      pushField();
      if (record.length >= MAX_IMPORT_COLUMNS) {
        throw new BadRequestException(
          `Import files may contain at most ${MAX_IMPORT_COLUMNS} columns.`,
        );
      }
      field = '';
      quotedFieldClosed = false;
    } else if (c === '\n') {
      pushField();
      records.push({ cells: record, rowNumber: recordStartLine });
      if (records.length > MAX_IMPORT_ROWS + 1) {
        throw new BadRequestException(
          `Import files may contain at most ${MAX_IMPORT_ROWS} data rows.`,
        );
      }
      field = '';
      record = [];
      quotedFieldClosed = false;
      physicalLine++;
      recordStartLine = physicalLine;
    } else {
      if (quotedFieldClosed) {
        throw new BadRequestException(
          'CSV contains characters after a closing quote.',
        );
      }
      field += c;
    }
  }
  if (inQuotes) {
    throw new BadRequestException('CSV contains an unclosed quoted field.');
  }
  // Flush the last field/record if the file didn't end on a newline.
  if (field !== '' || record.length > 0) {
    pushField();
    records.push({ cells: record, rowNumber: recordStartLine });
    if (records.length > MAX_IMPORT_ROWS + 1) {
      throw new BadRequestException(
        `Import files may contain at most ${MAX_IMPORT_ROWS} data rows.`,
      );
    }
  }
  return records;
}

export function assertHeaders(headers: string[]): void {
  if (headers.length > MAX_IMPORT_COLUMNS) {
    throw new BadRequestException(
      `Import files may contain at most ${MAX_IMPORT_COLUMNS} columns.`,
    );
  }
  if (headers.some((header) => !header)) {
    throw new BadRequestException('Every import column must have a non-blank header.');
  }
  const normalized = headers.map((header) => header.toLowerCase());
  if (new Set(normalized).size !== normalized.length) {
    throw new BadRequestException('Import column headers must be unique.');
  }
}
