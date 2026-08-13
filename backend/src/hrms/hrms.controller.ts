import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { HrmsService } from './hrms.service';
import {
  ApplyLeaveDto,
  AttendanceReportQueryDto,
  CancelLeaveDto,
  CheckInDto,
  CheckOutDto,
  CreateHolidayDto,
  CreateRegularizationDto,
  CreateShiftDto,
  DayCloseDto,
  DecideLeaveDto,
  DecideRegularizationDto,
  MarkAttendanceDto,
  SetWeekOffDto,
  TeamAttendanceQueryDto,
  UpdateCommissionRateDto,
} from './dto/hrms.dto';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { StoreHeader } from '../common/store-header.decorator';
import { Roles } from '../auth/roles.decorator';

@Controller('hrms')
export class HrmsController {
  constructor(private readonly hrms: HrmsService) {}

  // --- Attendance -----------------------------------------------------------
  // Static sub-routes are declared BEFORE any `:id` route so they aren't shadowed.

  @Get('attendance')
  attendance(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.hrms.attendance(user, store);
  }

  /**
   * The caller's resolved store geofence for LIVE client-side auto check-in — any
   * authenticated role. Static route, declared before any `:id`/dynamic route.
   */
  @Get('geofence')
  geofence(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.hrms.geofence(user, store);
  }

  /** Self-service geo check-in — the puncher is the current user. */
  @Post('attendance/check-in')
  checkIn(
    @CurrentUser() user: AuthUser,
    @Body() dto: CheckInDto,
    @StoreHeader() store?: string,
  ) {
    return this.hrms.checkIn(user, dto, store);
  }

  /** Self-service geo check-out — the puncher is the current user. */
  @Post('attendance/check-out')
  checkOut(
    @CurrentUser() user: AuthUser,
    @Body() dto: CheckOutDto,
    @StoreHeader() store?: string,
  ) {
    return this.hrms.checkOut(user, dto, store);
  }

  /** The current user's own punches for a month (+ today's state). */
  @Get('attendance/me')
  myAttendance(
    @CurrentUser() user: AuthUser,
    @Query('month') month?: string,
    @StoreHeader() store?: string,
  ) {
    return this.hrms.myAttendance(user, month, store);
  }

  /**
   * A user's attendance + GPS history over a date range (EzAttendancePro
   * "Attendance Report" + "GPS Report"). Self by default; a store_manager+ may
   * pass ?staffId for anyone in their store scope.
   */
  @Get('attendance/report')
  attendanceReport(
    @CurrentUser() user: AuthUser,
    @Query() query: AttendanceReportQueryDto,
    @StoreHeader() store?: string,
  ) {
    return this.hrms.attendanceReport(user, query, store);
  }

  /**
   * Manager team-GPS view: every staff member's punch for a day within scope,
   * showing WHERE each person punched (owner anti-buddy-punching visibility).
   */
  @Roles('store_manager', 'head_office')
  @Get('attendance/team')
  teamAttendance(
    @CurrentUser() user: AuthUser,
    @Query() query: TeamAttendanceQueryDto,
    @StoreHeader() store?: string,
  ) {
    return this.hrms.teamAttendance(user, query.date, store);
  }

  /** Admin/tablet manual mark — marking attendance for others is manager+ only. */
  @Roles('store_manager', 'head_office')
  @Post('attendance')
  markAttendance(@CurrentUser() user: AuthUser, @Body() dto: MarkAttendanceDto) {
    return this.hrms.markAttendance(user, dto);
  }

  /**
   * End-of-day reconciliation for a store: auto-close dangling punches and write
   * an explicit row (absent / on_leave / week_off / holiday) for everyone who
   * never punched. Without this, absence simply has no record.
   *
   * Idempotent, so a nightly scheduler may hit it repeatedly. Manager+ only.
   */
  @Roles('store_manager', 'head_office')
  @Post('attendance/day-close')
  dayClose(@CurrentUser() user: AuthUser, @Body() dto: DayCloseDto) {
    return this.hrms.dayClose(user, dto);
  }

  // --- Leave ----------------------------------------------------------------

  @Get('leave')
  leave(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.hrms.leave(user, store);
  }

  /** Leave balances — self by default; a manager+ may pass ?staffId within scope. */
  @Get('leave/balances')
  leaveBalances(
    @CurrentUser() user: AuthUser,
    @Query('staffId') staffId?: string,
    @StoreHeader() store?: string,
  ) {
    return this.hrms.leaveBalances(user, staffId, store);
  }

  /** Apply for leave (self, or a manager+ on behalf of team staff). */
  @Post('leave')
  applyLeave(
    @CurrentUser() user: AuthUser,
    @Body() dto: ApplyLeaveDto,
    @StoreHeader() store?: string,
  ) {
    return this.hrms.applyLeave(user, dto, store);
  }

  /**
   * Withdraw a leave request. The applicant may withdraw their own while it is
   * pending; a manager+ may also revoke one already approved, which releases the
   * days back to the balance. Declared BEFORE `leave/:id` so it isn't shadowed.
   */
  @Patch('leave/:id/cancel')
  cancelLeave(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: CancelLeaveDto,
  ) {
    return this.hrms.cancelLeave(user, id, dto?.reason);
  }

  /** Approving/rejecting leave is a manager+ action (role hierarchy, CLAUDE.md rule #2). */
  @Roles('store_manager', 'head_office')
  @Patch('leave/:id')
  decideLeave(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: DecideLeaveDto,
  ) {
    return this.hrms.decideLeave(user, id, dto.status, dto.note);
  }

  // --- Regularization -------------------------------------------------------

  /** Request a fix for a missed/wrong punch (current user). */
  @Post('regularize')
  createRegularization(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateRegularizationDto,
    @StoreHeader() store?: string,
  ) {
    return this.hrms.createRegularization(user, dto, store);
  }

  /** Store-scoped regularizations — managers see the team, staff see their own. */
  @Get('regularize')
  listRegularizations(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.hrms.listRegularizations(user, store);
  }

  /** Approve/reject a regularization — manager+ (applies the fix on approval). */
  @Roles('store_manager', 'head_office')
  @Patch('regularize/:id')
  decideRegularization(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: DecideRegularizationDto,
  ) {
    return this.hrms.decideRegularization(user, id, dto.status, dto.note);
  }

  // --- Shifts / holidays / week-off -----------------------------------------

  @Get('shifts')
  shifts(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.hrms.shifts(user, store);
  }

  /** Managing shifts is a manager+ action (role hierarchy, CLAUDE.md rule #2). */
  @Roles('store_manager', 'head_office')
  @Post('shifts')
  createShift(@CurrentUser() user: AuthUser, @Body() dto: CreateShiftDto) {
    return this.hrms.createShift(user, dto);
  }

  @Get('holidays')
  holidays(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.hrms.holidays(user, store);
  }

  /** Configuring holidays is a manager+ action. */
  @Roles('store_manager', 'head_office')
  @Post('holidays')
  createHoliday(@CurrentUser() user: AuthUser, @Body() dto: CreateHolidayDto) {
    return this.hrms.createHoliday(user, dto);
  }

  /** Week-off is set by head office / area management only (client call 2026-07). */
  @Roles('store_manager', 'head_office')
  @Patch('week-off')
  setWeekOff(@CurrentUser() user: AuthUser, @Body() dto: SetWeekOffDto) {
    return this.hrms.setWeekOff(user, dto);
  }

  // --- Analytics / commission ----------------------------------------------

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

  /**
   * Edit a commission's rate — recomputes the incentive amount. Store managers
   * (and the area tier) INPUT this; head office is view-only. The rank guard
   * rolls up so it can't exclude the top role — the service rejects head_office
   * explicitly.
   */
  @Roles('store_manager')
  @Patch('commission/:id')
  updateCommissionRate(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateCommissionRateDto,
  ) {
    return this.hrms.updateCommissionRate(user, id, dto.rate);
  }
}
