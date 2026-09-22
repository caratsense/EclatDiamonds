import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import type { DsrSheetPeriod } from './dto/reporting.dto';

/**
 * The DailyReport figures that add up across days. The booking book is a
 * balance, not a flow, so its opening and closing are taken from the first and
 * last report of a column instead (see the service).
 */
export const DSR_SUMMED = [
  'walkIns',
  'seriousEnquiries',
  'conversions',
  'deliveredBilled',
  'cash',
  'card',
  'upi',
  'oldGoldWtG',
  'oldGoldValue',
  'bookingsNew',
  'bookingsClosed',
  'advanceReceived',
  'customCash',
  'customCard',
  'customUpi',
  'customGoldWtG',
  'customGoldValue',
  'customBankTransfer',
] as const;

export type DsrSheetValues = Record<
  (typeof DSR_SUMMED)[number] | 'bookingsOpen' | 'bookingsClosing',
  number
>;

/** One store's DSR sheet, already resolved and in scope. */
export interface DsrSheetData {
  organisation: string;
  store: string;
  period: DsrSheetPeriod;
  periodLabel: string;
  generatedAt: string;
  /** Left to right. `values` is null when nothing was filed: printed blank, not as zeros. */
  columns: { title: string; sub: string; values: DsrSheetValues | null }[];
  /** Each filed day's remark in date order, labelled like "Mon 22". */
  remarks: { day: string; text: string }[];
}

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 40;
const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.42, 0.42, 0.46);
const RULE = rgb(0.82, 0.82, 0.85);
const SHADE = rgb(0.95, 0.95, 0.96);
const LABEL_W = 175;
const ROW_H = 14;

type Row = {
  label: string;
  indent?: number;
  bold?: boolean;
  /** No getter: a heading row, nothing in the value cells. */
  get?: (v: DsrSheetValues) => number;
  grams?: boolean;
};

/** The store's paper sheet, row for row. */
const ROWS: Row[] = [
  { label: 'Walkins', get: (v) => v.walkIns },
  { label: 'Serious enquiries', get: (v) => v.seriousEnquiries },
  { label: 'Conversion', get: (v) => v.conversions },
  { label: 'TABLE A  Counter Sale', bold: true },
  { label: 'Sale Value', indent: 1, get: (v) => v.deliveredBilled },
  { label: 'Mode of payment', indent: 1 },
  { label: 'Cash', indent: 2, get: (v) => v.cash },
  { label: 'Card', indent: 2, get: (v) => v.card },
  { label: 'UPI', indent: 2, get: (v) => v.upi },
  { label: 'Gold Weight (g)', indent: 2, get: (v) => v.oldGoldWtG, grams: true },
  { label: 'Gold Value', indent: 2, get: (v) => v.oldGoldValue },
  { label: 'Total', indent: 1, bold: true, get: (v) => v.cash + v.card + v.upi + v.oldGoldValue },
  { label: 'TABLE B  Customised Sale', bold: true },
  { label: 'Booking Value for the Day', indent: 1, get: (v) => v.bookingsNew },
  { label: 'Open Bookings', indent: 1, get: (v) => v.bookingsOpen },
  { label: 'Bookings Closed – Sale Completed', indent: 1, get: (v) => v.bookingsClosed },
  { label: 'Closing Booking', indent: 1, get: (v) => v.bookingsClosing },
  { label: 'Amount Received', indent: 1, get: (v) => v.advanceReceived },
  { label: 'Cash', indent: 2, get: (v) => v.customCash },
  { label: 'Card', indent: 2, get: (v) => v.customCard },
  { label: 'UPI', indent: 2, get: (v) => v.customUpi },
  { label: 'Gold Weight (g)', indent: 2, get: (v) => v.customGoldWtG, grams: true },
  { label: 'Gold Value', indent: 2, get: (v) => v.customGoldValue },
  { label: 'Bank Transfer', indent: 2, get: (v) => v.customBankTransfer },
  {
    label: 'Total',
    indent: 1,
    bold: true,
    get: (v) =>
      v.customCash + v.customCard + v.customUpi + v.customGoldValue + v.customBankTransfer,
  },
];

const rupees = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const grams = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 });

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
  let page: PDFPage = pdf.addPage(pageSize);
  let y = pageSize[1] - MARGIN;
  const right = pageSize[0] - MARGIN;

  const text = (
    value: string,
    x: number,
    opts: { size?: number; font?: PDFFont; color?: typeof INK; align?: 'left' | 'right'; width?: number } = {},
  ) => {
    const size = opts.size ?? 8.5;
    const font = opts.font ?? regular;
    let s = clean(value);
    if (opts.width) {
      while (s.length > 1 && font.widthOfTextAtSize(s, size) > opts.width) s = `${s.slice(0, -2)}…`;
    }
    const w = font.widthOfTextAtSize(s, size);
    page.drawText(s, { x: opts.align === 'right' ? x - w : x, y, size, font, color: opts.color ?? INK });
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
  const ensure = (height: number) => {
    if (y - height >= MARGIN) return;
    page = pdf.addPage(pageSize);
    y = pageSize[1] - MARGIN;
  };

  /* -------------------------------------------------------------- header */
  text(data.organisation, MARGIN, { size: 14, font: bold, width: right - MARGIN - 200 });
  text('DAILY SALES REPORT', right, { size: 14, font: bold, align: 'right' });
  y -= 15;
  text(data.store, MARGIN, { size: 10, width: right - MARGIN - 200 });
  text(data.periodLabel, right, { size: 10, font: bold, align: 'right' });
  y -= 12;
  text('Amounts in Rs. (rounded), gold weight in grams.', MARGIN, { size: 7.5, color: MUTED });
  text(`Generated ${data.generatedAt}`, right, { size: 7.5, color: MUTED, align: 'right' });
  y -= 14;

  /* --------------------------------------------------------------- table */
  const colW = (right - MARGIN - LABEL_W) / data.columns.length;
  const colRight = (i: number) => MARGIN + LABEL_W + (i + 1) * colW - 5;
  const top = y;
  hline();
  y -= 11;
  data.columns.forEach((c, i) => text(c.title, colRight(i), { font: bold, align: 'right', width: colW - 8 }));
  y -= 9;
  data.columns.forEach((c, i) =>
    text(c.sub, colRight(i), { size: 7, color: MUTED, align: 'right', width: colW - 8 }),
  );
  y -= 6;
  hline();

  const lastCol = data.columns.length - 1;
  for (const row of ROWS) {
    if (row.bold && !row.get) page.drawRectangle({ x: MARGIN, y: y - ROW_H, width: right - MARGIN, height: ROW_H, color: SHADE });
    y -= 10;
    text(row.label, MARGIN + 5 + (row.indent ?? 0) * 10, { font: row.bold ? bold : regular, width: LABEL_W - 10 });
    if (row.get) {
      data.columns.forEach((c, i) => {
        if (!c.values) return;
        const n = row.get!(c.values);
        const isTotal = data.period !== 'day' && i === lastCol;
        text((row.grams ? grams : rupees).format(n), colRight(i), {
          font: row.bold || isTotal ? bold : regular,
          align: 'right',
          width: colW - 8,
        });
      });
    }
    y -= ROW_H - 10;
    hline();
  }

  // A day's remark sits in its own row; a week's or a month's are listed below.
  if (data.period === 'day') {
    const lines = wrap(data.remarks[0]?.text ?? '', colW - 10);
    y -= 10;
    text('Remark', MARGIN + 5);
    lines.forEach((l, i) => {
      if (i) y -= 11;
      text(l, MARGIN + LABEL_W + 5);
    });
    y -= ROW_H - 10;
    hline();
  }

  // The grid's verticals, now that its height is known.
  for (const x of [MARGIN, MARGIN + LABEL_W, ...data.columns.map((_, i) => colRight(i) + 5)]) {
    page.drawLine({ start: { x, y: top }, end: { x, y }, thickness: 0.5, color: RULE });
  }

  if (data.period !== 'day' && data.remarks.length) {
    y -= 22;
    ensure(12);
    text('Remarks', MARGIN, { font: bold });
    for (const r of data.remarks) {
      for (const l of wrap(`${r.day}: ${r.text}`, right - MARGIN)) {
        y -= 12;
        ensure(0);
        text(l, MARGIN);
      }
    }
  }

  // Classic cross-reference table, as for the quote PDF: some phone previewers
  // still cannot open object streams.
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}
