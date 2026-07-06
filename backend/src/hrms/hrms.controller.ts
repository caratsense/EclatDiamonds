import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { HrmsService } from './hrms.service';
import {
  CreateHolidayDto,
  CreateShiftDto,
  DecideLeaveDto,
  MarkAttendanceDto,
  SetWeekOffDto,
} from './dto/hrms.dto';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { StoreHeader } from '../common/store-header.decorator';
import { Roles } from '../auth/roles.decorator';

@Controller('hrms')
export class HrmsController {
  constructor(private readonly hrms: HrmsService) {}

  @Get('attendance')
  attendance(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.hrms.attendance(user, store);
  }

  @Post('attendance')
  markAttendance(@CurrentUser() user: AuthUser, @Body() dto: MarkAttendanceDto) {
    return this.hrms.markAttendance(user, dto);
  }

  @Get('leave')
  leave(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.hrms.leave(user, store);
  }

  /** Approving/rejecting leave is a manager+ action (role hierarchy, CLAUDE.md rule #2). */
  @Roles('store_manager', 'area_manager', 'head_office')
  @Patch('leave/:id')
  decideLeave(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: DecideLeaveDto,
  ) {
    return this.hrms.decideLeave(user, id, dto.status);
  }

  @Get('shifts')
  shifts(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.hrms.shifts(user, store);
  }

  /** Managing shifts is a manager+ action (role hierarchy, CLAUDE.md rule #2). */
  @Roles('store_manager', 'area_manager', 'head_office')
  @Post('shifts')
  createShift(@CurrentUser() user: AuthUser, @Body() dto: CreateShiftDto) {
    return this.hrms.createShift(user, dto);
  }

  @Get('holidays')
  holidays(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.hrms.holidays(user, store);
  }

  /** Configuring holidays is a manager+ action. */
  @Roles('store_manager', 'area_manager', 'head_office')
  @Post('holidays')
  createHoliday(@CurrentUser() user: AuthUser, @Body() dto: CreateHolidayDto) {
    return this.hrms.createHoliday(user, dto);
  }

  /** Week-off is set by head office / area management only (client call 2026-07). */
  @Roles('area_manager', 'head_office')
  @Patch('week-off')
  setWeekOff(@CurrentUser() user: AuthUser, @Body() dto: SetWeekOffDto) {
    return this.hrms.setWeekOff(user, dto);
  }

  @Get('late-flags')
  lateFlags(
    @CurrentUser() user: AuthUser,
    @Query('month') month?: string,
    @StoreHeader() store?: string,
  ) {
    return this.hrms.lateFlags(user, month, store);
  }

  @Get('leaderboard')
  leaderboard(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.hrms.leaderboard(user, store);
  }

  @Get('commission')
  commission(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.hrms.commission(user, store);
  }
}
