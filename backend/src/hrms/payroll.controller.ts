import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

import { HumansOnly } from '../auth/machine.decorator';
import { Roles } from '../auth/roles.decorator';
import { AuthUser, CurrentUser } from '../common/auth-user';
import { PayrollService } from './payroll.service';

export class SetWeekOffsDto {
  @IsString()
  userId!: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  storeId?: string | null;

  /** 0 = Sunday … 6 = Saturday. Empty means "follow the branch". */
  @IsArray()
  @ArrayMaxSize(3)
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  days!: number[];
}

export class SetCompensationDto {
  @IsString()
  userId!: string;

  @IsOptional()
  @IsIn(['monthly', 'daily'])
  basis?: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  amount!: number;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(31)
  paidLeavePerMonth?: number | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  overtimeHourlyRate?: number | null;
}

export class GeneratePayslipDto {
  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsString()
  storeId?: string;

  @Matches(/^\d{4}-\d{2}$/, { message: 'A period looks like 2026-09.' })
  periodKey!: string;
}

export class RunPayrollDto {
  @IsString()
  storeId!: string;

  @Matches(/^\d{4}-\d{2}$/, { message: 'A period looks like 2026-09.' })
  periodKey!: string;
}

/**
 * The roster and the payslip.
 *
 * Under the `/hrms` entitlement entry by longest-prefix match. Attendance is
 * sold to every industry, and so is asking what a month of it comes to.
 */
@HumansOnly()
@Controller('hrms/payroll')
export class PayrollController {
  constructor(private readonly payroll: PayrollService) {}

  // ── Weekly offs ───────────────────────────────────────────────────────────

  @Roles('store_manager', 'head_office')
  @Get('week-offs')
  weekOffs(@CurrentUser() user: AuthUser, @Query('storeId') storeId?: string) {
    return this.payroll.weekOffsFor(user, storeId || undefined);
  }

  /**
   * A store manager sets their own branch's roster — it is the person who knows
   * who is on the floor on Tuesday.
   */
  @Roles('store_manager', 'head_office')
  @Put('week-offs')
  setWeekOffs(@CurrentUser() user: AuthUser, @Body() dto: SetWeekOffsDto) {
    return this.payroll.setWeekOffs(user, dto);
  }

  // ── Compensation ──────────────────────────────────────────────────────────

  /**
   * Head office only, enforced again in the service.
   *
   * Twice on purpose: what somebody is paid is the one field in this product a
   * store manager must not be able to set for their own team, and a decorator is
   * easy to lose in a refactor.
   */
  @Roles('head_office')
  @Put('compensation')
  setCompensation(@CurrentUser() user: AuthUser, @Body() dto: SetCompensationDto) {
    return this.payroll.setCompensation(user, dto);
  }

  @Get('compensation/:userId')
  compensation(@CurrentUser() user: AuthUser, @Param('userId') userId: string) {
    return this.payroll.compensationFor(user, userId);
  }

  // ── Payslips ──────────────────────────────────────────────────────────────

  /** One employee, or a whole branch when no `userId` is given. */
  @Roles('store_manager', 'head_office')
  @Post('payslips/generate')
  generate(@CurrentUser() user: AuthUser, @Body() dto: GeneratePayslipDto) {
    return dto.userId
      ? this.payroll.generate(user, { userId: dto.userId, periodKey: dto.periodKey })
      : this.payroll.generateForStore(user, {
          storeId: dto.storeId,
          periodKey: dto.periodKey,
        });
  }

  @Roles('store_manager', 'head_office')
  @Post('payslips/:id/issue')
  issue(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.payroll.issue(user, id);
  }

  /** An employee asking with no filters gets their own, whatever their role. */
  @Get('payslips')
  list(
    @CurrentUser() user: AuthUser,
    @Query('periodKey') periodKey?: string,
    @Query('userId') userId?: string,
    @Query('storeId') storeId?: string,
  ) {
    return this.payroll.list(user, {
      periodKey: periodKey || undefined,
      userId: userId || undefined,
      storeId: storeId || undefined,
    });
  }

  /** One slip, with the day-by-day breakdown behind its totals. */
  @Get('payslips/:id')
  one(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.payroll.one(user, id);
  }

  // ── Month-end runs ────────────────────────────────────────────────────────

  /** What the month-end scheduler and every manual run did, newest first. */
  @Roles('store_manager', 'head_office')
  @Get('runs')
  runs(
    @CurrentUser() user: AuthUser,
    @Query('periodKey') periodKey?: string,
    @Query('storeId') storeId?: string,
  ) {
    return this.payroll.runs(user, {
      periodKey: periodKey || undefined,
      storeId: storeId || undefined,
    });
  }

  /**
   * Run one branch's month now: recovery when the automatic run failed or was
   * interrupted, or a recount after late corrections. Drafts only, audited.
   */
  @Roles('store_manager', 'head_office')
  @Post('runs')
  rerun(@CurrentUser() user: AuthUser, @Body() dto: RunPayrollDto) {
    return this.payroll.rerun(user, dto);
  }
}
