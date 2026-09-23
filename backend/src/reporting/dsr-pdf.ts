import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import { DSR_ROWS, type DsrSheetData } from './dsr-sheet';

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 40;
const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.42, 0.42, 0.46);
const RULE = rgb(0.82, 0.82, 0.85);
const LABEL_W = 175;
const ROW_H_MAX = 14;
const GAP_H = 8;
/** Room left for the grid once the four header lines are drawn. */
const HEADER_H = 47;

// Plain, as the store's own sheet prints them: 1603822, not 16,03,822.
const rupees = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0, useGrouping: false });
const grams = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
  useGrouping: false,
});

/**
 * The DSR as the store's own sheet: one value column for a day, Monday to
 * Sunday plus a Total for a week, Week 1… plus a Total for a month.
 *
 * Same standard-font approach as the quote PDF (quote-pdf.ts): WinAnsi has no
 * rupee sign, so the header says the amounts are in rupees and the cells carry
 * Indian-grouped figures only.
 */
export async function renderDsrSheetPdf(data: DsrSheetData): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`DSR ${data.store} ${data.periodLabel}`);
  pdf.setAuthor(data.organisation);
  pdf.setCreator('CaratOS');

  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const drawable = new Set(regular.getCharacterSet());
  // \s also catches the narrow no-break spaces some locales put in dates.
  const clean = (text: string) =>
    [...text.replace(/\s+/g, ' ')]
      .map((ch) => (drawable.has(ch.codePointAt(0)!) ? ch : '?'))
      .join('');

  // A week or a month is too wide for portrait.
  const pageSize: [number, number] = data.period === 'day' ? A4 : [A4[1], A4[0]];
  const page: PDFPage = pdf.addPage(pageSize);
  let y = pageSize[1] - MARGIN;

  // The sheet is one page, always: a DSR split across two is a DSR nobody can
  // read side by side. The rows are the same rows whatever the period, so the
  // row height is what gives — squeezed only as far as the page needs.
  const gridRows = DSR_ROWS.filter((r) => !r.gap).length;
  const gaps = DSR_ROWS.length - gridRows;
  const room = pageSize[1] - 2 * MARGIN - HEADER_H - gaps * GAP_H;
  const ROW_H = Math.min(ROW_H_MAX, room / gridRows);
  const right = pageSize[0] - MARGIN;

  const text = (
    value: string,
    x: number,
    opts: {
      size?: number;
      font?: PDFFont;
      color?: typeof INK;
      align?: 'left' | 'right' | 'center';
      width?: number;
    } = {},
  ) => {
    const size = opts.size ?? 8.5;
    const font = opts.font ?? regular;
    let s = clean(value);
    if (opts.width) {
      while (s.length > 1 && font.widthOfTextAtSize(s, size) > opts.width) s = `${s.slice(0, -2)}…`;
    }
    const w = font.widthOfTextAtSize(s, size);
    const x0 = opts.align === 'right' ? x - w : opts.align === 'center' ? x - w / 2 : x;
    page.drawText(s, { x: x0, y, size, font, color: opts.color ?? INK });
  };
  const hline = () =>
    page.drawLine({ start: { x: MARGIN, y }, end: { x: right, y }, thickness: 0.5, color: RULE });
  const wrap = (value: string, width: number) => {
    const lines: string[] = [];
    let line = '';
    for (const word of clean(value).split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (line && regular.widthOfTextAtSize(next, 8.5) > width) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    return line ? [...lines, line] : lines;
  };
  /* -------------------------------------------------------------- header */
  text(data.organisation, MARGIN, { size: 14, font: bold, width: right - MARGIN - 200 });
  text('DAILY SALES REPORT', right, { size: 14, font: bold, align: 'right' });
  y -= 15;
  text(data.store, MARGIN, { size: 10, width: right - MARGIN - 200 });
  text(data.periodLabel, right, { size: 10, font: bold, align: 'right' });
  y -= 12;
  text('Amounts in Rs., gold weight in grams.', MARGIN, { size: 7.5, color: MUTED });
  text(`Generated ${data.generatedAt}`, right, { size: 7.5, color: MUTED, align: 'right' });
  y -= 14;

  /* --------------------------------------------------------------- table */
  const colW = (right - MARGIN - LABEL_W) / data.columns.length;
  const colRight = (i: number) => MARGIN + LABEL_W + (i + 1) * colW - 5;
  const verticals = [MARGIN, MARGIN + LABEL_W, ...data.columns.map((_, i) => colRight(i) + 5)];
  const centre = MARGIN + (right - MARGIN) / 2;

  // The sheet is two grids with a gap between them, not one long one, so the
  // verticals are drawn per band once each band's height is known.
  const bands: { top: number; bottom: number }[] = [];
  let bandTop: number | null = null;
  const openBand = () => {
    if (bandTop !== null) return;
    bandTop = y;
    hline();
  };
  const closeBand = () => {
    if (bandTop === null) return;
    bands.push({ top: bandTop, bottom: y });
    bandTop = null;
  };

  for (const row of DSR_ROWS) {
    if (row.gap) {
      closeBand();
      y -= GAP_H;
      continue;
    }
    openBand();

    if (row.banner) {
      y -= 10;
      text(row.label, centre, { font: bold, align: 'center' });
      y -= ROW_H - 10;
      hline();
      continue;
    }

    if (row.head) {
      y -= 10;
      text(row.label, MARGIN + 5, { font: bold, width: LABEL_W - 10 });
      data.columns.forEach((c, i) =>
        text(c.title, colRight(i), { font: bold, align: 'right', width: colW - 8 }),
      );
      y -= ROW_H - 10;
      hline();
      continue;
    }

    if (row.remark) {
      const joined = data.remarks.map((r) => `${r.day}: ${r.text}`).join('   |   ');
      const lines = joined ? wrap(joined, right - MARGIN - LABEL_W - 10) : [''];
      y -= 10;
      text(row.label, MARGIN + 5, { font: bold, width: LABEL_W - 10 });
      lines.forEach((l, i) => {
        if (i) y -= 11;
        text(l, MARGIN + LABEL_W + 5);
      });
      y -= ROW_H - 10;
      hline();
      continue;
    }

    if (row.blank) {
      y -= ROW_H;
      hline();
      continue;
    }

    y -= 10;
    text(row.label, MARGIN + 5, { font: row.bold ? bold : regular, width: LABEL_W - 10 });
    if (row.get) {
      data.columns.forEach((c, i) => {
        if (!c.values) return;
        text((row.grams ? grams : rupees).format(row.get!(c.values)), colRight(i), {
          font: row.bold ? bold : regular,
          align: 'right',
          width: colW - 8,
        });
      });
    }
    y -= ROW_H - 10;
    hline();
  }
  closeBand();

  for (const band of bands) {
    for (const x of verticals) {
      page.drawLine({ start: { x, y: band.top }, end: { x, y: band.bottom }, thickness: 0.5, color: RULE });
    }
  }

  // Classic cross-reference table, as for the quote PDF: some phone previewers
  // still cannot open object streams.
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}
