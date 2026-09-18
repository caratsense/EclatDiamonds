import { IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** GET /hrms/analytics/overview. `from`/`to` default to the current store-local month. */
export class AnalyticsQueryDto {
  @IsOptional()
  @Matches(YMD, { message: 'from must be YYYY-MM-DD' })
  from?: string;

  @IsOptional()
  @Matches(YMD, { message: 'to must be YYYY-MM-DD' })
  to?: string;

  @IsOptional()
  @IsString()
  storeId?: string;

  @IsOptional()
  @IsString()
  departmentId?: string;
}

export const REPORT_KINDS = [
  'daily-register',
  'muster',
  'monthly-summary',
  'in-out',
  'late-early',
  'missed-punch',
  'constant-absent',
  'leave-balance',
  'leave-register',
  'punch-log',
  'gps',
  'birthdays',
  'hiring',
  'separation',
  'employee-details',
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/** GET /hrms/reports/:kind */
export class ReportQueryDto extends AnalyticsQueryDto {
  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsIn(['json', 'csv'])
  format?: 'json' | 'csv';

  /** constant-absent: minimum consecutive absent days. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(62)
  minDays?: number;

  /** birthdays: 1-12, default the current month. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  month?: number;
}
