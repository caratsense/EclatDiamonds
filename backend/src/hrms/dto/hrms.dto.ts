import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { AttendanceStatus, LeaveStatus, LeaveType } from '@prisma/client';
import { IsRealName } from '../../common/contact.util';

export class DecideLeaveDto {
  @IsEnum(LeaveStatus)
  status!: LeaveStatus;

  /** Rationale recorded on the request and shown back to the applicant. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** PATCH /hrms/leave/:id/cancel — withdraw (owner) or revoke (manager+) a request. */
export class CancelLeaveDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class MarkAttendanceDto {
  /**
   * The staff member being marked. REQUIRED: it used to be optional, and omitting
   * it minted a synthetic `att-<timestamp>` id, creating an untraceable ghost
   * staff row that no report could ever attribute or reconcile.
   */
  @IsString()
  @IsNotEmpty()
  staffId!: string;

  /** Display name; ignored in favour of the resolved user's real name. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @IsRealName()
  staffName?: string;

  @IsEnum(AttendanceStatus)
  status!: AttendanceStatus;

  @IsString()
  @IsNotEmpty()
  storeId!: string;

  @IsOptional()
  @IsDateString()
  checkInAt?: string;

  /** Day being marked (YYYY-MM-DD, store-local). Defaults to the store's today. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date?: string;

  /**
   * Assigned shift for this check-in. When present, lateness is computed against
   * this shift's start + buffer and `status` is overridden to `late`/`present`.
   */
  @IsOptional()
  @IsString()
  shiftId?: string;
}

/**
 * POST /hrms/attendance/day-close — end-of-day reconciliation for a store
 * (absence marking + dangling-punch cleanup). Safe to call repeatedly.
 */
export class DayCloseDto {
  @IsString()
  @IsNotEmpty()
  storeId!: string;

  /** Day to close (YYYY-MM-DD, store-local). Defaults to the previous local day. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date?: string;
}

/** POST /hrms/shifts — create a store shift/batch (Module 6). */
export class CreateShiftDto {
  @IsString()
  @IsNotEmpty()
  storeId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @IsRealName()
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

  /**
   * Minutes that must be worked to earn a FULL day's payroll credit. Omit to use
   * the shift's own scheduled length.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  fullDayMins?: number;

  /** Minutes for a HALF day's credit. Omit for 50% of the full-day threshold. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  halfDayMins?: number;
}

/** POST /hrms/holidays — configure a per-store holiday (Module 6). */
export class CreateHolidayDto {
  @IsString()
  @IsNotEmpty()
  storeId!: string;

  /** Calendar date (YYYY-MM-DD). */
  @IsDateString()
  date!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  @IsRealName()
  label?: string;
}

/** PATCH /hrms/week-off — set a store's weekly off day (Module 6, HO/area only). */
export class SetWeekOffDto {
  @IsString()
  @IsNotEmpty()
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
  /**
   * Browser-reported latitude at the moment of the punch. OMIT when the device
   * could not produce a fix — do not substitute 0, which is a real coordinate
   * (Null Island, ~8,200 km from Mumbai) and is indistinguishable from someone
   * punching in from the other side of the planet.
   */
  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat?: number;

  /** Browser-reported longitude. Omit when unavailable — see `lat`. */
  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng?: number;

  /** Assigned shift for this punch. When omitted the store's first shift is used. */
  @IsOptional()
  @IsString()
  shiftId?: string;

  /**
   * Justification for punching from outside the store geofence. The API REJECTS
   * an out-of-fence punch that carries no reason — the punch is still allowed
   * (staff are never locked out by a GPS drift), but it must be explained, and it
   * is surfaced to the manager's review queue.
   */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;

  /**
   * The device reported a mock/spoofed location provider. Recorded and trailed
   * rather than blocked, because a false positive must never stop someone
   * clocking in for their shift.
   */
  @IsOptional()
  @IsBoolean()
  isMockLocation?: boolean;

  /**
   * A `data:image/...;base64,` frame from the device camera, captured at the
   * moment of the punch.
   *
   * EVIDENCE, not identification. Nothing compares it to an enrolled face, so
   * accepting it never means "this is who they say they are" — it means a camera
   * on this device produced this image now. The distinction matters: a record
   * that claims a verified identity it never checked is worse than no record.
   *
   * Optional in every case. A punch is never refused for the want of a camera:
   * an old handset, a denied permission or a dark stockroom must not stop
   * someone clocking in for their shift.
   */
  @IsOptional()
  @IsString()
  @MaxLength(3_000_000)
  photo?: string;
}

/** POST /hrms/attendance/check-out — self-service geo check-out (Module 6). */
export class CheckOutDto {
  /** Omit when the device has no fix — see the note on {@link CheckInDto.lat}. */
  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat?: number;

  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng?: number;

  /** Justification when the check-out lands outside the store geofence. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;

  /** Same contract as {@link CheckInDto.photo} — evidence, never identification. */
  @IsOptional()
  @IsString()
  @MaxLength(3_000_000)
  photo?: string;
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

  /** Rationale recorded on the request and shown back to the applicant. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
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
