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
