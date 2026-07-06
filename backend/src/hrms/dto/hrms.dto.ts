import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { AttendanceStatus, LeaveStatus } from '@prisma/client';

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
