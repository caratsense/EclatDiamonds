import { Workbook } from 'exceljs';
import { DSR_ROWS, type DsrSheetData } from './dsr-sheet';

/** Indian grouping (##,##,##0), the way the store reads its own figures. */
const RUPEES = '#,##,##0';
const GRAMS = '#,##,##0.000';
const LABEL_COL_W = 34;
const VALUE_COL_W = 13;

/**
 * The same sheet as `renderDsrSheetPdf`, as a real workbook — the rows come
 * from DSR_ROWS, so a row added to the paper sheet appears in both or neither.
 *
 * Figures are written as numbers with a display format, never as pre-formatted
 * strings: the owner sorts, sums and charts this file, and a cell holding
 * "1,11,110" is text that does none of those.
 */
export async function renderDsrSheetXlsx(data: DsrSheetData): Promise<Buffer> {
  const wb = new Workbook();
  wb.creator = 'CaratSense';
  wb.created = new Date();
  const ws = wb.addWorksheet('DSR', {
    // The row labels and the header band stay put while the columns scroll.
    views: [{ state: 'frozen', xSplit: 1, ySplit: 5 }],
  });
  ws.columns = [
    { width: LABEL_COL_W },
    ...data.columns.map(() => ({ width: VALUE_COL_W })),
  ];

  /* -------------------------------------------------------------- header */
  ws.addRow([data.organisation]).font = { bold: true, size: 14 };
  ws.addRow([`Daily Sales Report — ${data.store}`]).font = { bold: true, size: 11 };
  ws.addRow([data.periodLabel]).font = { bold: true };
  ws.addRow([
    `Amounts in Rs. (rounded), gold weight in grams. Generated ${data.generatedAt}`,
  ]).font = { italic: true, size: 9 };

  /* --------------------------------------------------------------- table */
  const head = ws.addRow(['', ...data.columns.map((c) => (c.sub ? `${c.title}\n${c.sub}` : c.title))]);
  head.font = { bold: true };
  head.alignment = { horizontal: 'right', vertical: 'bottom', wrapText: true };
  head.getCell(1).alignment = { horizontal: 'left' };

  // The last data column is the week's / month's Total; a day has none.
  const totalCol = data.period === 'day' ? -1 : data.columns.length + 1;
  for (const row of DSR_ROWS) {
    const line = ws.addRow([
      row.label,
      ...data.columns.map((c) => (row.get && c.values ? row.get(c.values) : null)),
    ]);
    // The indent the PDF draws with x-offsets; Excel has its own.
    line.getCell(1).alignment = { indent: row.indent ?? 0 };
    if (row.bold) line.getCell(1).font = { bold: true };
    // By index, not eachCell: a column nobody filed holds null and would be
    // skipped, losing its number format and the section band.
    for (let col = 2; col <= data.columns.length + 1; col++) {
      const cell = line.getCell(col);
      cell.numFmt = row.grams ? GRAMS : RUPEES;
      if (row.bold || col === totalCol) cell.font = { bold: true };
    }
    // A section heading (TABLE A / TABLE B) gets the PDF's shaded band.
    if (row.bold && !row.get) {
      for (let col = 1; col <= data.columns.length + 1; col++) {
        line.getCell(col).fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFF2F2F4' },
        };
      }
    }
  }

  /* ------------------------------------------------------------- remarks */
  if (data.remarks.length) {
    ws.addRow([]);
    ws.addRow(['Remarks']).font = { bold: true };
    for (const r of data.remarks) ws.addRow([`${r.day}: ${r.text}`]);
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}
