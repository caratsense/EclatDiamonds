import type { DsrSheetPeriod } from './dto/reporting.dto';

/**
 * The store's paper DSR, as data: which figures add up, what the sheet's rows
 * are, and what one rendered sheet carries. Shared by both renderers
 * (`dsr-pdf.ts`, `dsr-xlsx.ts`) so the PDF and the workbook can never disagree
 * about a row, a total or a column.
 */

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
  /**
   * Left to right, headed the way the sheet heads them: Monday…Sunday. `values`
   * is null when nothing was filed, so the column prints blank rather than a
   * confident zero.
   */
  columns: { title: string; values: DsrSheetValues | null }[];
  /** Each filed day's remark in date order, labelled like "Mon 22". */
  remarks: { day: string; text: string }[];
}

export type DsrSheetRow = {
  label: string;
  bold?: boolean;
  /** The table's own title, centred across the whole width. */
  banner?: boolean;
  /** Repeats the day columns under a banner, the way the sheet does. */
  head?: boolean;
  /** An empty row inside the grid — the sheet's own breathing space. */
  blank?: boolean;
  /** A gap between the tables, outside the grid: no border, no fill. */
  gap?: boolean;
  /** The last row: the day's remarks, written across the value columns. */
  remark?: boolean;
  get?: (v: DsrSheetValues) => number;
  grams?: boolean;
};

/**
 * The store's sheet, row for row and word for word, from the copy the owner
 * sent ("Dsr format to be generated at eow"). The labels, their order, the
 * blank rows and the two table banners are the sheet's, not ours: this is the
 * page they already read every Monday, so anything renamed here — "Gold Weight
 * (g)" for the sheet's "Gold" over "Weight" — is a page they have to re-learn.
 *
 * Both tables repeat the day columns under their banner, and "Amount Received"
 * is a heading with nothing in it: the modes below it are the figures, and the
 * Total at the foot is their sum.
 */
export const DSR_ROWS: DsrSheetRow[] = [
  { label: '', head: true },
  { label: 'Walkins', get: (v) => v.walkIns },
  { label: 'Serious enquiries', get: (v) => v.seriousEnquiries },
  { label: 'Conversion', get: (v) => v.conversions },
  { label: '', gap: true },

  { label: 'TABLE A - COUNTER SALE', banner: true },
  { label: 'Sale Type - Counter Sale', head: true },
  { label: 'Sale Value', get: (v) => v.deliveredBilled },
  { label: '', blank: true },
  { label: 'Mode of Payment:', bold: true },
  { label: 'Cash', get: (v) => v.cash },
  { label: 'Card', get: (v) => v.card },
  { label: 'UPI', get: (v) => v.upi },
  { label: 'Gold', bold: true },
  { label: 'Weight', get: (v) => v.oldGoldWtG, grams: true },
  { label: 'Value', get: (v) => v.oldGoldValue },
  { label: '', blank: true },
  { label: 'Total', bold: true, get: (v) => v.cash + v.card + v.upi + v.oldGoldValue },
  { label: '', gap: true },

  { label: 'TABLE B - CUSTOMISED SALE', banner: true },
  { label: 'Customised Items:', head: true },
  { label: 'Booking Value - For the Day', get: (v) => v.bookingsNew },
  { label: 'Open Bookings', get: (v) => v.bookingsOpen },
  { label: 'Bookings Closed - Sale Completed', get: (v) => v.bookingsClosed },
  { label: 'Closing Booking', get: (v) => v.bookingsClosing },
  { label: '', blank: true },
  { label: 'Amount Received', bold: true },
  { label: 'Mode of Payment:', bold: true },
  { label: 'Cash', get: (v) => v.customCash },
  { label: 'Card', get: (v) => v.customCard },
  { label: 'UPI', get: (v) => v.customUpi },
  { label: 'Gold', bold: true },
  { label: 'Weight', get: (v) => v.customGoldWtG, grams: true },
  { label: 'Value', get: (v) => v.customGoldValue },
  { label: 'Bank Transfer', get: (v) => v.customBankTransfer },
  {
    label: 'Total',
    bold: true,
    get: (v) =>
      v.customCash + v.customCard + v.customUpi + v.customGoldValue + v.customBankTransfer,
  },
  { label: 'Remark:', bold: true, remark: true },
];
