import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { IsRealName } from '../../common/contact.util';

/** Roll-up window: the day / ISO-week / calendar-month containing `date`. */
export type ReportPeriod = 'daily' | 'weekly' | 'monthly';

/** Delivery channel for a composed report (Module 10). */
export type ReportChannel = 'whatsapp' | 'email';

export const REPORT_PERIODS: ReportPeriod[] = ['daily', 'weekly', 'monthly'];
export const REPORT_CHANNELS: ReportChannel[] = ['whatsapp', 'email'];

/** GET /reporting/summary?period=&date= */
export class ReportSummaryQueryDto {
  /** Defaults to `daily` when omitted. */
  @IsOptional()
  @IsIn(REPORT_PERIODS)
  period?: ReportPeriod;

  /** Anchor date (YYYY-MM-DD). Defaults to today. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be in YYYY-MM-DD format' })
  date?: string;
}

/** GET /reporting/compliance?days=&storeId= */
export class ComplianceQueryDto {
  /** How many days back to show, ending today. 1–31, default 7. */
  @IsOptional()
  @IsInt()
  @Min(1)
  days?: number;

  /** Narrow to one branch (validated against the caller's scope). */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  storeId?: string;
}

/** POST /reporting/send */
export class SendReportDto {
  @IsIn(REPORT_PERIODS)
  period!: ReportPeriod;

  /** Anchor date (YYYY-MM-DD). Defaults to today. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be in YYYY-MM-DD format' })
  date?: string;

  @IsIn(REPORT_CHANNELS)
  channel!: ReportChannel;

  /** Destination: a phone number for WhatsApp, an email address for email. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  to!: string;
}

/**
 * POST /reporting/daily — the store-close Daily Sales Report a manager currently
 * types on WhatsApp. Money/weight arrive as numbers and are stored on exact
 * Decimal columns (CLAUDE.md rule #4). Store-scoped via `storeId`.
 */
export class CreateDailyReportDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  storeId!: string;

  /** Report date (YYYY-MM-DD) — the day the store closed. */
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'reportDate must be in YYYY-MM-DD format' })
  reportDate!: string;

  /** Free-text close time as shown on WhatsApp, e.g. "8:00 PM". */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  reportTime?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  walkIns?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  seriousEnquiries?: number;

  /** How many serious enquiries actually bought. Subset of seriousEnquiries. */
  @IsOptional()
  @IsInt()
  @Min(0)
  conversions?: number;

  /** Customised-order book open at the start of the day (INR). */
  @IsOptional()
  @IsNumber()
  @Min(0)
  bookingsOpen?: number;

  /** Bookings closed today — sale completed (INR). */
  @IsOptional()
  @IsNumber()
  @Min(0)
  bookingsClosed?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  deliveredBilled?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  bookingsNew?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  advanceReceived?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  cash?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  card?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  upi?: number;

  /** Old-gold weight in grams (exchange), null when none taken. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  oldGoldWtG?: number;

  /** Old-gold value in INR, null when none taken. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  oldGoldValue?: number;

  // --- Table B: how the customised-sale collection was paid -----------------
  @IsOptional()
  @IsNumber()
  @Min(0)
  customCash?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  customCard?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  customUpi?: number;

  /** Old-gold weight in grams taken against a customised order. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  customGoldWtG?: number;

  /** Old-gold value in INR taken against a customised order. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  customGoldValue?: number;

  /** Customised-sale collection received by bank transfer (INR). */
  @IsOptional()
  @IsNumber()
  @Min(0)
  customBankTransfer?: number;

  /** The sheet's Remark row — free text for the day. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  @IsRealName()
  submittedBy?: string;
}

/** GET /reporting/daily?date=&storeId= */
export class DailyReportQueryDto {
  /** Filter to a single report-date (YYYY-MM-DD). */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be in YYYY-MM-DD format' })
  date?: string;

  /** Narrow a broad-role list to one store (must be in scope). */
  @IsOptional()
  @IsString()
  storeId?: string;
}

/** The window a DSR sheet covers: the day, its Mon–Sun week, or its month. */
export type DsrSheetPeriod = 'day' | 'week' | 'month';
export const DSR_SHEET_PERIODS: DsrSheetPeriod[] = ['day', 'week', 'month'];

/** The store's sheet to print, or the same grid to work on in Excel. */
export type DsrSheetFormat = 'pdf' | 'xlsx';
export const DSR_SHEET_FORMATS: DsrSheetFormat[] = ['pdf', 'xlsx'];
export const DSR_SHEET_MIME: Record<DsrSheetFormat, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** GET /reporting/daily/sheet?storeId=&period=&date=&format= (and its `daily/pdf` alias) */
export class DailySheetQueryDto {
  /** One store per sheet (must be in scope). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  storeId!: string;

  @IsIn(DSR_SHEET_PERIODS)
  period!: DsrSheetPeriod;

  /** Any day in the period (YYYY-MM-DD). Defaults to today at the store. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be in YYYY-MM-DD format' })
  date?: string;

  /** Defaults to `pdf` — the layout the store already prints. */
  @IsOptional()
  @IsIn(DSR_SHEET_FORMATS)
  format?: DsrSheetFormat;
}

/** POST /reporting/daily/sheet/send — the same sheet, delivered as a file. */
export class SendDailySheetDto extends DailySheetQueryDto {
  @IsIn(REPORT_CHANNELS)
  channel!: ReportChannel;

  /** Destination: a phone number for WhatsApp, an email address for email. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  to!: string;
}

/** POST /reporting/daily/:id/send */
export class SendDailyReportDto {
  @IsIn(REPORT_CHANNELS)
  channel!: ReportChannel;

  /** Destination: a phone number for WhatsApp, an email address for email. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  to!: string;
}
