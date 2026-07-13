import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { AttendanceStatus, LeaveStatus, LeaveType } from '@prisma/client';

export class DecideLeaveDto {
  @IsEnum(LeaveStatus)
  status!: LeaveStatus;
}

export class MarkAttendanceDto {
  @IsString()
  staffName!: string;

  @IsEnum(AttendanceStatus)
  status!: AttendanceStatus;

  @IsString()
  storeId!: string;

  @IsOptional()
  @IsDateString()
  checkInAt?: string;

  /**
   * Assigned shift for this check-in. When present, lateness is computed against
   * this shift's start + buffer and `status` is overridden to `late`/`present`.
   */
  @IsOptional()
  @IsString()
  shiftId?: string;

  /**
   * Stable staff identity (so per-person monthly late counts aggregate). Optional
   * for back-compat: if omitted a per-ping id is generated as before.
   */
  @IsOptional()
  @IsString()
  staffId?: string;
}

/** POST /hrms/shifts — create a store shift/batch (Module 6). */
export class CreateShiftDto {
  @IsString()
  storeId!: string;

  @IsString()
  name!: string;

  /** "HH:MM" 24h store-local shift start. */
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'startTime must be HH:MM (24h)' })
  startTime!: string;

  /** "HH:MM" 24h store-local shift end. */
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'endTime must be HH:MM (24h)' })
  endTime!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(180)
  bufferMins?: number;

  @IsOptional()
  @IsBoolean()
  isNightBatch?: boolean;
}

/** POST /hrms/holidays — configure a per-store holiday (Module 6). */
export class CreateHolidayDto {
  @IsString()
  storeId!: string;

  /** Calendar date (YYYY-MM-DD). */
  @IsDateString()
  date!: string;

  @IsOptional()
  @IsString()
  label?: string;
}

/** PATCH /hrms/week-off — set a store's weekly off day (Module 6, HO/area only). */
export class SetWeekOffDto {
  @IsString()
  storeId!: string;

  /** 0=Sunday … 6=Saturday. */
  @IsInt()
  @Min(0)
  @Max(6)
  weekOffDay!: number;
}

/**
 * POST /hrms/attendance/check-in — self-service geo check-in (Module 6).
 * The puncher is the current user; the browser sends its GPS coordinates.
 */
export class CheckInDto {
  /** Browser-reported latitude at the moment of the punch. */
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  /** Browser-reported longitude at the moment of the punch. */
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng!: number;

  /** Assigned shift for this punch. When omitted the store's first shift is used. */
  @IsOptional()
  @IsString()
  shiftId?: string;
}

/** POST /hrms/attendance/check-out — self-service geo check-out (Module 6). */
export class CheckOutDto {
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  lng!: number;
}

/**
 * POST /hrms/leave — apply for leave (self, or a manager on behalf of team staff).
 * If `days` is omitted it is computed from the date range excluding the store's
 * weekly-off day and configured holidays.
 */
export class ApplyLeaveDto {
  @IsEnum(LeaveType)
  type!: LeaveType;

  /** Inclusive first day of leave (YYYY-MM-DD). */
  @IsDateString()
  fromDate!: string;

  /** Inclusive last day of leave (YYYY-MM-DD). */
  @IsDateString()
  toDate!: string;

  /** Explicit leave-day count (supports half-days, e.g. 1.5). Auto-computed if omitted. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  days?: number;

  /** true when this request covers only half a day (counts as 0.5). */
  @IsOptional()
  @IsBoolean()
  halfDay?: boolean;

  @IsOptional()
  @IsString()
  reason?: string;

  /** Manager+ only: apply on behalf of another staff member (within store scope). */
  @IsOptional()
  @IsString()
  staffId?: string;
}

/** POST /hrms/regularize — request a fix for a missed/wrong punch (Module 6). */
export class CreateRegularizationDto {
  /** Calendar date being corrected (YYYY-MM-DD). */
  @IsDateString()
  date!: string;

  /** Corrected check-in instant (ISO 8601). */
  @IsOptional()
  @IsDateString()
  requestedCheckIn?: string;

  /** Corrected check-out instant (ISO 8601). */
  @IsOptional()
  @IsDateString()
  requestedCheckOut?: string;

  @IsOptional()
  @IsString()
  reason?: string;
}

/** PATCH /hrms/regularize/:id — approve/reject a regularization (manager+). */
export class DecideRegularizationDto {
  @IsEnum(LeaveStatus)
  status!: LeaveStatus;
}

/**
 * GET /hrms/attendance/report — a user's attendance history over a date range
 * (EzAttendancePro "Attendance Report" + "GPS Report"). Self by default; a
 * store_manager+ may pass `staffId` for anyone in their store scope.
 */
export class AttendanceReportQueryDto {
  /** Inclusive range start (YYYY-MM-DD). */
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be YYYY-MM-DD' })
  from!: string;

  /** Inclusive range end (YYYY-MM-DD). */
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be YYYY-MM-DD' })
  to!: string;

  /** Manager+ only: report for another staff member (within store scope). */
  @IsOptional()
  @IsString()
  staffId?: string;
}

/**
 * GET /hrms/attendance/team — every staff member's punch for a day within the
 * caller's store scope (manager team-GPS / anti-buddy-punching view). Defaults
 * to today when `date` is omitted.
 */
export class TeamAttendanceQueryDto {
  /** Day to report (YYYY-MM-DD). Defaults to today. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date?: string;
}

/** PATCH /hrms/commission/:id — edit an incentive's commission rate (manager+). */
export class UpdateCommissionRateDto {
  /** Commission rate as a percentage of sales value (e.g. 2.5 = 2.5%). */
  @IsNumber()
  @Min(0)
  @Max(100)
  rate!: number;
}
