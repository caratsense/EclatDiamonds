import { Workbook, type Worksheet, type Row } from 'exceljs';
import { DSR_ROWS, type DsrSheetData, type DsrSheetRow } from './dsr-sheet';

/**
 * Plain numbers, the way the store's own sheet shows them: 1603822, not
 * 16,03,822. The owner reads this next to the copy they already keep, and a
 * separator we added would be the first thing that looks wrong.
 */
const RUPEES = '0';
const GRAMS = '0.000';
const LABEL_COL_W = 36;
const VALUE_COL_W = 13;
const THIN = { style: 'thin' as const, color: { argb: 'FF000000' } };
const BOX = { top: THIN, left: THIN, bottom: THIN, right: THIN };

/**
 * The store's end-of-week sheet as a real workbook: same rows, same wording,
 * same two banners, same blank lines, from `DSR_ROWS`.
 *
 * Figures are written as numbers with a display format, never as pre-formatted
 * strings: the owner sorts, sums and charts this file, and a cell holding
 * "16,03,822" is text that does none of those. A day nobody filed stays empty
 * rather than showing a confident zero.
 */
export async function renderDsrSheetXlsx(data: DsrSheetData): Promise<Buffer> {
  const wb = new Workbook();
  wb.creator = 'CaratSense';
  wb.created = new Date();
  const cols = data.columns.length;
  const last = cols + 1;
  const ws = wb.addWorksheet('DSR', {
    // The row labels and the title band stay put while the columns scroll.
    views: [{ state: 'frozen', xSplit: 1, ySplit: 2 }],
  });
  ws.columns = [{ width: LABEL_COL_W }, ...data.columns.map(() => ({ width: VALUE_COL_W }))];

  /* --------------------------------------------------------------- title */
  // Two lines only. The sheet in the photo starts straight at the day names;
  // these say which branch and which week, which a file sent to head office
  // needs and a sheet sitting on one desk does not.
  ws.addRow([`${data.store} — Daily Sales Report`]).font = { bold: true, size: 12 };
  ws.addRow([data.periodLabel]).font = { bold: true, size: 10 };

  const border = (r: Row) => {
    for (let c = 1; c <= last; c++) r.getCell(c).border = BOX;
  };

  for (const row of DSR_ROWS) {
    if (row.gap) {
      ws.addRow([]);
      continue;
    }

    if (row.banner) {
      const r = ws.addRow([row.label]);
      ws.mergeCells(r.number, 1, r.number, last);
      r.getCell(1).font = { bold: true };
      r.getCell(1).alignment = { horizontal: 'center' };
      border(r);
      continue;
    }

    if (row.head) {
      const r = ws.addRow([row.label, ...data.columns.map((c) => c.title)]);
      r.font = { bold: true };
      border(r);
      continue;
    }

    if (row.remark) {
      const r = ws.addRow([row.label, data.remarks.map((x) => `${x.day}: ${x.text}`).join('  |  ')]);
      r.getCell(1).font = { bold: true };
      if (last > 2) ws.mergeCells(r.number, 2, r.number, last);
      r.getCell(2).alignment = { horizontal: 'left', wrapText: true };
      border(r);
      continue;
    }

    const r = ws.addRow([
      row.label,
      ...data.columns.map((c) => (row.get && c.values ? row.get(c.values) : null)),
    ]);
    if (row.bold) r.getCell(1).font = { bold: true };
    // By index, not eachCell: a column nobody filed holds null and would be
    // skipped, losing its number format and its border.
    for (let c = 2; c <= last; c++) {
      const cell = r.getCell(c);
      cell.numFmt = row.grams ? GRAMS : RUPEES;
      if (row.bold) cell.font = { bold: true };
    }
    border(r);
  }

  markTotalColumn(ws, data);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * A month's sheet is columns of weeks, which the weekly sheet has no equivalent
 * of, so its trailing Total column is ours and is marked as such. A week's
 * sheet has no such column — it is seven days and nothing else, as the store's
 * copy is.
 */
function markTotalColumn(ws: Worksheet, data: DsrSheetData): void {
  if (data.period !== 'month') return;
  const col = data.columns.length + 1;
  ws.eachRow((r) => {
    const cell = r.getCell(col);
    if (cell.value !== null && cell.value !== undefined) cell.font = { ...cell.font, bold: true };
  });
}

export type { DsrSheetRow };
