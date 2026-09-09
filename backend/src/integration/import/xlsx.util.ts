import { Workbook } from 'exceljs';
import JSZip from 'jszip';
import { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { BadRequestException } from '@nestjs/common';
import {
  assertHeaders,
  ImportTableBudget,
  MAX_IMPORT_COLUMNS,
  MAX_IMPORT_ROWS,
  type ParsedTable,
} from './csv.util';

const MAX_XLSX_ENTRIES = 1_024;
const MAX_XLSX_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_XLSX_EXPANDED_BYTES = 32 * 1024 * 1024;
/**
 * ExcelJS builds an in-memory object for every source cell. 200k supports the
 * MVP's largest intended shape (20k rows x 10 populated columns) without
 * allowing a compressed upload to create a million-object heap spike.
 */
export const MAX_XLSX_SOURCE_CELLS = 200_000;
const MAX_XLSX_XML_TAG_CHARACTERS = 4_096;

/**
 * CaratOS import — XLSX parser. Produces the SAME {@link ParsedTable} shape as the
 * CSV parser, so the entire import pipeline (discover/map/preview/import/reconcile)
 * treats CSV and Excel identically — there is no separate Excel workflow. Reads the
 * FIRST worksheet only (onboarding files are single-sheet); header row = row 1.
 */

/** Coerce an ExcelJS value without trusting stale formula caches. */
function cellToString(v: unknown, rowNumber: number, columnNumber: number): string {
  if (v == null) return '';
  let text: string;
  if (typeof v === 'string') text = v;
  else if (typeof v === 'number') {
    if (!Number.isFinite(v)) {
      throw new BadRequestException(
        `XLSX row ${rowNumber}, column ${columnNumber} contains a non-finite number.`,
      );
    }
    text = String(v);
  } else if (typeof v === 'boolean') text = String(v);
  else if (v instanceof Date) text = v.toISOString().slice(0, 10);
  else {
    const o = v as Record<string, unknown>;
    // ExcelJS never recalculates formulae. A cached result can be stale, so the
    // safe import contract requires the workbook owner to paste values first.
    if ('formula' in o || 'sharedFormula' in o) {
      throw new BadRequestException(
        `XLSX row ${rowNumber}, column ${columnNumber} contains a formula. Paste calculated values before importing.`,
      );
    }
    if ('error' in o) {
      throw new BadRequestException(
        `XLSX row ${rowNumber}, column ${columnNumber} contains an Excel error value.`,
      );
    }
    if ('text' in o) text = String(o.text ?? '');
    else if ('richText' in o && Array.isArray(o.richText)) {
      text = (o.richText as { text: string }[])
        .map((run) => String(run.text ?? ''))
        .join('');
    } else if ('hyperlink' in o) text = String(o.text ?? o.hyperlink ?? '');
    else {
      throw new BadRequestException(
        `XLSX row ${rowNumber}, column ${columnNumber} contains an unsupported cell value.`,
      );
    }
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) {
    throw new BadRequestException(
      `XLSX row ${rowNumber}, column ${columnNumber} contains an unsupported control character.`,
    );
  }
  return text;
}

/** Parse an XLSX buffer into headers + rows (first sheet). */
export async function parseXlsx(buffer: Buffer): Promise<ParsedTable> {
  await assertSafeArchive(buffer);
  const wb = new Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new BadRequestException('The XLSX file is malformed or unsupported.');
  }
  const ws = wb.worksheets[0];
  if (!ws) return { headers: [], rows: [], rowNumbers: [] };
  if (ws.rowCount > MAX_IMPORT_ROWS + 1 || ws.actualRowCount > MAX_IMPORT_ROWS + 1) {
    throw new BadRequestException(
      `Import files may contain at most ${MAX_IMPORT_ROWS} data rows.`,
    );
  }
  if (ws.columnCount > MAX_IMPORT_COLUMNS || ws.actualColumnCount > MAX_IMPORT_COLUMNS) {
    throw new BadRequestException(
      `Import files may contain at most ${MAX_IMPORT_COLUMNS} columns.`,
    );
  }

  // Row 1 is always the header. Skipping blank physical rows would otherwise
  // promote row 2 and make every reported row number wrong.
  const headerRow = ws.getRow(1);
  const headerWidth = headerRow.cellCount;
  if (headerWidth === 0) return { headers: [], rows: [], rowNumbers: [] };
  const headers = Array.from({ length: headerWidth }, (_, index) =>
    cellToString(headerRow.getCell(index + 1).value, 1, index + 1).trim(),
  );
  assertHeaders(headers);
  const width = headers.length;
  const budget = new ImportTableBudget();
  budget.addRow(headers, 1);
  const rows: string[][] = [];
  const rowNumbers: number[] = [];
  for (let rowNumber = 2; rowNumber <= ws.rowCount; rowNumber++) {
    const row = ws.getRow(rowNumber);
    const raw = Array.from({ length: row.cellCount }, (_, index) =>
      cellToString(row.getCell(index + 1).value, rowNumber, index + 1),
    );
    if (!raw.some((cell) => cell.trim() !== '')) continue;
    if (raw.length > width && raw.slice(width).some((cell) => cell.trim() !== '')) {
      throw new BadRequestException(
        `XLSX row ${rowNumber} has data beyond the ${width}-column header.`,
      );
    }
    const out = raw.slice(0, width);
    while (out.length < width) out.push('');
    budget.addRow(out, rowNumber);
    rows.push(out);
    rowNumbers.push(rowNumber);
  }
  return { headers, rows, rowNumbers };
}

/**
 * XLSX is a ZIP container. Multer limits compressed bytes, which alone does not
 * stop a tiny highly-compressible archive expanding until the Node process runs
 * out of memory. Stream every entry once with explicit expanded-size ceilings
 * before ExcelJS is allowed to materialise the workbook.
 */
async function assertSafeArchive(buffer: Buffer): Promise<void> {
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(buffer, { createFolders: false });
  } catch {
    throw new BadRequestException('The XLSX file is not a valid ZIP archive.');
  }
  const archiveEntries = Object.values(archive.files);
  if (archiveEntries.length > MAX_XLSX_ENTRIES) {
    throw new BadRequestException(
      `XLSX files may contain at most ${MAX_XLSX_ENTRIES} archive entries.`,
    );
  }
  if (archiveEntries.some((entry) => entry.name.startsWith('/') || entry.name.includes('\0'))) {
    // ExcelJS strips a leading slash before classifying entries. Rejecting that
    // non-canonical spelling keeps this safety scan and its consumer aligned.
    throw new BadRequestException('The XLSX archive contains a non-canonical entry path.');
  }
  const entries = archiveEntries.filter((entry) => !entry.dir);

  let expandedTotal = 0;
  let worksheetCells = 0;
  for (const entry of entries) {
    await new Promise<void>((resolve, reject) => {
      let expandedEntry = 0;
      let settled = false;
      const inspectWorksheet = /^xl\/worksheets\/[^/]+\.xml$/i.test(entry.name);
      let xmlCarry = '';
      let worksheetRows = 0;
      const decoder = new StringDecoder('utf8');
      const stream = entry.nodeStream('nodebuffer') as Readable;
      const refuse = (message: string) => {
        if (settled) return;
        settled = true;
        stream.destroy();
        reject(new BadRequestException(message));
      };
      const inspectXml = (input: string) => {
        const text = xmlCarry + input;
        const tagPattern = /<[^>]*>/g;
        let match: RegExpExecArray | null;
        while ((match = tagPattern.exec(text)) !== null) {
          inspectWorksheetTag(match[0], entry.name, {
            addCell: () => {
              worksheetCells++;
              if (worksheetCells > MAX_XLSX_SOURCE_CELLS) {
                refuse(
                  `XLSX worksheets may contain at most ${MAX_XLSX_SOURCE_CELLS} source cells.`,
                );
              }
            },
            addRow: () => {
              worksheetRows++;
              if (worksheetRows > MAX_IMPORT_ROWS + 1) {
                refuse(`Import files may contain at most ${MAX_IMPORT_ROWS} data rows.`);
              }
            },
            refuse,
          });
          if (settled) return;
        }
        const lastOpen = text.lastIndexOf('<');
        const lastClose = text.lastIndexOf('>');
        xmlCarry = lastOpen > lastClose ? text.slice(lastOpen) : '';
        if (xmlCarry.length > MAX_XLSX_XML_TAG_CHARACTERS) {
          refuse('The XLSX worksheet contains an excessively long XML tag.');
        }
      };
      stream.on('data', (chunk: Buffer) => {
        expandedEntry += chunk.length;
        expandedTotal += chunk.length;
        if (expandedEntry > MAX_XLSX_ENTRY_BYTES) {
          refuse('An XLSX archive entry expands beyond the safe 16 MiB limit.');
        } else if (expandedTotal > MAX_XLSX_EXPANDED_BYTES) {
          refuse('The XLSX archive expands beyond the safe 32 MiB limit.');
        } else if (inspectWorksheet) {
          inspectXml(decoder.write(chunk));
        }
      });
      stream.once('error', () => refuse('The XLSX archive contains corrupt data.'));
      stream.once('end', () => {
        if (settled) return;
        if (inspectWorksheet) {
          inspectXml(decoder.end());
          if (settled) return;
        }
        settled = true;
        resolve();
      });
    });
  }
}

interface WorksheetInspection {
  addCell(): void;
  addRow(): void;
  refuse(message: string): void;
}

function inspectWorksheetTag(
  tag: string,
  entryName: string,
  inspection: WorksheetInspection,
): void {
  const opening = /^<(?:[A-Za-z_][\w.-]*:)?(dimension|row|c)(?=[\s/>])([^>]*)>/.exec(tag);
  if (!opening) return;
  const [, kind, attributes] = opening;
  if (kind === 'c') inspection.addCell();
  if (kind === 'row') inspection.addRow();

  const attributeName = kind === 'dimension' ? 'ref' : 'r';
  const value = xmlAttribute(attributes, attributeName);
  if (!value) return;
  if (kind === 'row') {
    const rowNumber = Number(value);
    if (!Number.isSafeInteger(rowNumber) || rowNumber < 1 || rowNumber > MAX_IMPORT_ROWS + 1) {
      inspection.refuse(
        `XLSX worksheet ${entryName} references a row beyond the safe import limit.`,
      );
    }
    return;
  }

  const references = [...value.matchAll(/\$?([A-Z]{1,3})\$?(\d+)/gi)];
  if (!references.length) {
    inspection.refuse(`XLSX worksheet ${entryName} contains an invalid ${attributeName} reference.`);
    return;
  }
  for (const reference of references) {
    const column = excelColumnNumber(reference[1]);
    const row = Number(reference[2]);
    if (
      column < 1 ||
      column > MAX_IMPORT_COLUMNS ||
      !Number.isSafeInteger(row) ||
      row < 1 ||
      row > MAX_IMPORT_ROWS + 1
    ) {
      inspection.refuse(
        `XLSX worksheet ${entryName} references a cell beyond the safe import dimensions.`,
      );
      return;
    }
  }
}

function xmlAttribute(attributes: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`).exec(attributes);
  return match?.[2] ?? null;
}

function excelColumnNumber(letters: string): number {
  let result = 0;
  for (const character of letters.toUpperCase()) {
    result = result * 26 + character.charCodeAt(0) - 64;
  }
  return result;
}
