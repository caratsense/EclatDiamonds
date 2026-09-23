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
  /** Left to right. `values` is null when nothing was filed: printed blank, not as zeros. */
  columns: { title: string; sub: string; values: DsrSheetValues | null }[];
  /** Each filed day's remark in date order, labelled like "Mon 22". */
  remarks: { day: string; text: string }[];
}

export type DsrSheetRow = {
  label: string;
  indent?: number;
  bold?: boolean;
  /** No getter: a heading row, nothing in the value cells. */
  get?: (v: DsrSheetValues) => number;
  grams?: boolean;
};

/** The store's paper sheet, row for row. */
export const DSR_ROWS: DsrSheetRow[] = [
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
