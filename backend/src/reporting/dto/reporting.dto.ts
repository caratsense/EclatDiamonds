import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

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
  @MaxLength(255)
  to!: string;
}
