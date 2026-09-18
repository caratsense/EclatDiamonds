import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
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

  /** No fixed start: lateness and early-out are never computed. */
  @IsOptional()
  @IsBoolean()
  isFlexible?: boolean;

  /** Short code a punch source or import refers to ("S", "G", "F", "6HR"). */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  code?: string;
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

  /** The device's own radius of uncertainty for that fix, in metres (`coords.accuracy`). */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1_000_000)
  accuracyM?: number;

  /** Assigned shift for this punch. When omitted the store's first shift is used. */
  @IsOptional()
  @IsString()
  shiftId?: string;

  /**
   * Reason for a punch GPS cannot decide (no fix, or a fix too imprecise to
   * tell): required then, and the punch goes to the manager's review queue. A
   * CONFIDENT fix outside the fence is refused whatever the note says.
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

  /** See {@link CheckInDto.accuracyM}. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1_000_000)
  accuracyM?: number;

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

// ===========================================================================
// Attendance operations (docs/modules/06-attendance.md)
// ===========================================================================

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export class TodayQueryDto {
  @IsOptional()
  @IsString()
  storeId?: string;
}

export class RegisterQueryDto {
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
  userId?: string;

  /** An AttendanceStatus; `late` also matches present rows flagged late. */
  @IsOptional()
  @IsEnum(AttendanceStatus)
  status?: AttendanceStatus;

  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  pageSize?: number;
}

/** PATCH /hrms/attendance/:id — a correction; the note is mandatory. */
export class UpdateAttendanceDto {
  /** For absent / on_leave / week_off / holiday. Attended statuses are derived from the times. */
  @IsOptional()
  @IsEnum(AttendanceStatus)
  status?: AttendanceStatus;

  /** Store-local "HH:MM" on the record's date. */
  @IsOptional()
  @Matches(HHMM, { message: 'checkIn must be HH:MM (24h)' })
  checkIn?: string;

  /** Store-local "HH:MM"; earlier than the check-in means the next morning. */
  @IsOptional()
  @Matches(HHMM, { message: 'checkOut must be HH:MM (24h)' })
  checkOut?: string;

  @IsOptional()
  @IsString()
  shiftId?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  note!: string;
}

/** A mandatory reason (DELETE attendance / leave). */
export class ReasonDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

/** An optional reason (void a punch). */
export class OptionalReasonDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class PunchesQueryDto {
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
  userId?: string;
}

export class CreatePunchDto {
  @IsString()
  @IsNotEmpty()
  userId!: string;

  @IsString()
  @IsNotEmpty()
  storeId!: string;

  @IsIn(['in', 'out'])
  kind!: 'in' | 'out';

  /** ISO 8601 instant. */
  @IsDateString()
  at!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  note!: string;
}

export class StartProcessingRunDto {
  @Matches(YMD, { message: 'from must be YYYY-MM-DD' })
  from!: string;

  @Matches(YMD, { message: 'to must be YYYY-MM-DD' })
  to!: string;

  @IsOptional()
  @IsString()
  storeId?: string;
}

export class PayrollLockDto {
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month must be YYYY-MM' })
  month!: string;
}

export class ApprovalsQueryDto {
  /** Omit for every status. */
  @IsOptional()
  @IsEnum(LeaveStatus)
  status?: LeaveStatus;
}

/** PATCH /hrms/leave/:id/edit — a manager corrects a PENDING request. */
export class EditLeaveDto {
  @IsDateString()
  fromDate!: string;

  @IsDateString()
  toDate!: string;

  @IsEnum(LeaveType)
  type!: LeaveType;

  @IsOptional()
  @IsBoolean()
  halfDay?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class UpdateLeaveBalanceDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(400)
  allocated?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(400)
  used?: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  note!: string;
}

export class CreateLeaveBalanceDto {
  @IsString()
  @IsNotEmpty()
  userId!: string;

  @IsEnum(LeaveType)
  type!: LeaveType;

  /** Financial-year start (2026 = FY 2026–27). */
  @IsInt()
  @Min(2000)
  @Max(2100)
  year!: number;

  @IsNumber()
  @Min(0)
  @Max(400)
  allocated!: number;
}

export class UpdateShiftDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @IsRealName()
  name?: string;

  @IsOptional()
  @Matches(HHMM, { message: 'startTime must be HH:MM (24h)' })
  startTime?: string;

  @IsOptional()
  @Matches(HHMM, { message: 'endTime must be HH:MM (24h)' })
  endTime?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(180)
  bufferMins?: number;

  @IsOptional()
  @IsBoolean()
  isNightBatch?: boolean;

  @IsOptional()
  @IsBoolean()
  isFlexible?: boolean;

  /** Null or "" clears it. */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  code?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  fullDayMins?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  halfDayMins?: number;
}

export class UpdateHolidayDto {
  @IsOptional()
  @Matches(YMD, { message: 'date must be YYYY-MM-DD' })
  date?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string | null;
}

export class ShiftAssignmentQueryDto {
  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsString()
  storeId?: string;
}

export class CreateShiftAssignmentDto {
  @IsString()
  @IsNotEmpty()
  userId!: string;

  @IsString()
  @IsNotEmpty()
  shiftId!: string;

  @Matches(YMD, { message: 'effectiveFrom must be YYYY-MM-DD' })
  effectiveFrom!: string;
}

export class UpdateShiftAssignmentDto {
  @IsOptional()
  @IsString()
  shiftId?: string;

  @IsOptional()
  @Matches(YMD, { message: 'effectiveFrom must be YYYY-MM-DD' })
  effectiveFrom?: string;

  /** Null reopens it (open-ended). */
  @IsOptional()
  @Matches(YMD, { message: 'effectiveTo must be YYYY-MM-DD' })
  effectiveTo?: string | null;
}
