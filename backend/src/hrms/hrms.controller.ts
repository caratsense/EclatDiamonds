import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { Permit } from '../auth/permissions';
import type { Response } from 'express';
import { HrmsService } from './hrms.service';
import { AttendancePhotoService } from './attendance-photo.service';
import { AttendanceOpsService } from './attendance-ops.service';
import {
  ApplyLeaveDto,
  ApprovalsQueryDto,
  CreateLeaveBalanceDto,
  CreatePunchDto,
  CreateShiftAssignmentDto,
  EditLeaveDto,
  OptionalReasonDto,
  PayrollLockDto,
  PunchesQueryDto,
  ReasonDto,
  RegisterQueryDto,
  ShiftAssignmentQueryDto,
  StartProcessingRunDto,
  TodayQueryDto,
  UpdateAttendanceDto,
  UpdateHolidayDto,
  UpdateLeaveBalanceDto,
  UpdateShiftAssignmentDto,
  UpdateShiftDto,
  AttendanceReportQueryDto,
  CancelLeaveDto,
  CheckInDto,
  CheckOutDto,
  CreateHolidayDto,
  CreateRegularizationDto,
  ConfirmAttendanceRulesDto,
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
  constructor(
    private readonly hrms: HrmsService,
    private readonly photos: AttendancePhotoService,
    private readonly ops: AttendanceOpsService,
  ) {}

  // --- Attendance -----------------------------------------------------------
  // Static sub-routes are declared BEFORE any `:id` route so they aren't shadowed.

  @Permit('self.attendance')
  @Get('attendance')
  attendance(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.hrms.attendance(user, store);
  }

  /**
   * The caller's resolved store geofence for LIVE client-side auto check-in — any
   * authenticated role. Static route, declared before any `:id`/dynamic route.
   */
  @Permit('self.attendance')
  @Get('geofence')
  geofence(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.hrms.geofence(user, store);
  }

  /** Today: one primary state per eligible employee; the counts sum to the denominator. */
  @Roles('store_manager')
  @Get('attendance/today')
  today(@CurrentUser() user: AuthUser, @Query() q: TodayQueryDto, @StoreHeader() store?: string) {
    return this.ops.today(user, q.storeId ?? store);
  }

  /** The daily register over a date range, paginated `{items,total}`. */
  @Roles('store_manager')
  @Get('attendance/register')
  register(@CurrentUser() user: AuthUser, @Query() q: RegisterQueryDto, @StoreHeader() store?: string) {
    return this.hrms.register(user, q, store);
  }

  /** Correct a register row (manager or head office); the note is mandatory. */
  @Roles('store_manager')
  @Patch('attendance/:id')
  updateAttendance(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateAttendanceDto) {
    return this.hrms.updateAttendance(user, id, dto);
  }

  /** Delete a register row; the raw punches stay. */
  @Roles('store_manager')
  @Delete('attendance/:id')
  deleteAttendance(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ReasonDto) {
    return this.hrms.deleteAttendance(user, id, dto.reason);
  }

  // --- Raw punch ledger -----------------------------------------------------

  @Roles('store_manager')
  @Get('punches')
  punches(@CurrentUser() user: AuthUser, @Query() q: PunchesQueryDto, @StoreHeader() store?: string) {
    return this.ops.punches(user, { ...q, storeId: q.storeId ?? store });
  }

  @Roles('store_manager')
  @Post('punches')
  addPunch(@CurrentUser() user: AuthUser, @Body() dto: CreatePunchDto) {
    return this.ops.addPunch(user, dto);
  }

  /** Voids (never deletes) a punch, then recomputes that day. */
  @Roles('store_manager')
  @Delete('punches/:id')
  voidPunch(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: OptionalReasonDto) {
    return this.ops.voidPunch(user, id, dto?.reason);
  }

  // --- Processing runs + payroll locks (head office) -------------------------

  @Roles('head_office')
  @Post('processing-runs')
  startProcessingRun(@CurrentUser() user: AuthUser, @Body() dto: StartProcessingRunDto) {
    return this.ops.startProcessingRun(user, dto);
  }

  @Roles('head_office')
  @Get('processing-runs')
  processingRuns(@CurrentUser() user: AuthUser) {
    return this.ops.processingRuns(user);
  }

  @Roles('head_office')
  @Get('payroll-locks')
  payrollLocks(@CurrentUser() user: AuthUser) {
    return this.ops.payrollLocks(user);
  }

  @Roles('head_office')
  @Post('payroll-locks')
  lockMonth(@CurrentUser() user: AuthUser, @Body() dto: PayrollLockDto) {
    return this.ops.lockMonth(user, dto.month);
  }

  @Roles('head_office')
  @Post('payroll-locks/:month/reopen')
  reopenMonth(@CurrentUser() user: AuthUser, @Param('month') month: string, @Body() dto: ReasonDto) {
    return this.ops.reopenMonth(user, month, dto.reason);
  }

  // --- Approvals inbox ------------------------------------------------------

  /** Leave + regularization in one list. Decisions reuse PATCH leave/:id and regularize/:id. */
  @Roles('store_manager')
  @Get('approvals')
  approvals(@CurrentUser() user: AuthUser, @Query() q: ApprovalsQueryDto, @StoreHeader() store?: string) {
    return this.ops.approvals(user, q.status, store);
  }

  /**
   * The photo taken at one punch.
   *
   * Bytes, not a redirect to object storage: the point of this route is that the
   * object's own URL never leaves the server. Declared before any `:id` route
   * that could shadow it, and gated per-record inside the service — the staffer
   * themselves, or a manager at that branch. See `AttendancePhotoService`.
   */
  @Permit('self.attendance')
  @Get('attendance/:id/photo/:which')
  @Header('Cache-Control', 'private, max-age=300')
  async attendancePhoto(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('which') which: string,
    @Res() res: Response,
  ) {
    const side = which === 'out' ? 'out' : 'in';
    const { buffer, contentType } = await this.photos.read(user, id, side);
    res.setHeader('Content-Type', contentType);
    // A face photograph is never a document to open in a tab of its own.
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(buffer);
  }

  /** Self-service geo check-in — the puncher is the current user. */
  @Permit('self.attendance')
  @Post('attendance/check-in')
  checkIn(
    @CurrentUser() user: AuthUser,
    @Body() dto: CheckInDto,
    @StoreHeader() store?: string,
  ) {
    return this.hrms.checkIn(user, dto, store);
  }

  /** Self-service geo check-out — the puncher is the current user. */
  @Permit('self.attendance')
  @Post('attendance/check-out')
  checkOut(
    @CurrentUser() user: AuthUser,
    @Body() dto: CheckOutDto,
    @StoreHeader() store?: string,
  ) {
    return this.hrms.checkOut(user, dto, store);
  }

  /** The current user's own punches for a month (+ today's state). */
  @Permit('self.attendance')
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
  // Management information: store manager and above, never a salesperson.
  @Roles('store_manager')
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

  /** Per location: the configured attendance rules and whether automatic absence is on. */
  @Roles('store_manager', 'head_office')
  @Get('attendance/rules')
  attendanceRules(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.hrms.attendanceRules(user, store);
  }

  /** HR confirms a location's rules complete through a date. Head office only. */
  @Roles('head_office')
  @Post('attendance/rules/confirm')
  confirmAttendanceRules(@CurrentUser() user: AuthUser, @Body() dto: ConfirmAttendanceRulesDto) {
    return this.hrms.confirmAttendanceRules(user, dto);
  }

  // --- Leave ----------------------------------------------------------------

  @Permit('self.leave')
  @Get('leave')
  leave(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.hrms.leave(user, store);
  }

  /** Leave balances — self by default; a manager+ may pass ?staffId within scope. */
  @Permit('self.leave')
  @Get('leave/balances')
  leaveBalances(
    @CurrentUser() user: AuthUser,
    @Query('staffId') staffId?: string,
    @StoreHeader() store?: string,
  ) {
    return this.hrms.leaveBalances(user, staffId, store);
  }

  /** Head office grants a balance row (e.g. week-off leave for a store employee). */
  @Roles('head_office')
  @Post('leave/balances')
  createLeaveBalance(@CurrentUser() user: AuthUser, @Body() dto: CreateLeaveBalanceDto) {
    return this.hrms.createLeaveBalance(user, dto);
  }

  /** Head office adjusts allocated / used, with a note. */
  @Roles('head_office')
  @Patch('leave/balances/:id')
  updateLeaveBalance(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateLeaveBalanceDto) {
    return this.hrms.updateLeaveBalance(user, id, dto);
  }

  /** A manager corrects a pending request. */
  @Roles('store_manager')
  @Patch('leave/:id/edit')
  editLeave(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: EditLeaveDto) {
    return this.hrms.editLeave(user, id, dto);
  }

  /** A manager deletes a request; an approved one gives its days back. */
  @Roles('store_manager')
  @Delete('leave/:id')
  deleteLeave(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ReasonDto) {
    return this.hrms.deleteLeave(user, id, dto.reason);
  }

  /** Apply for leave (self, or a manager+ on behalf of team staff). */
  @Permit('self.leave')
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
  @Permit('self.leave')
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
  @Permit('self.attendance')
  @Post('regularize')
  createRegularization(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateRegularizationDto,
    @StoreHeader() store?: string,
  ) {
    return this.hrms.createRegularization(user, dto, store);
  }

  /** Store-scoped regularizations — managers see the team, staff see their own. */
  @Permit('self.attendance')
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

  @Permit('self.attendance')
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

  @Roles('store_manager')
  @Patch('shifts/:id')
  updateShift(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateShiftDto) {
    return this.ops.updateShift(user, id, dto);
  }

  /** 409 while assigned or on the register today, unless ?force=1 (which unassigns). */
  @Roles('store_manager')
  @Delete('shifts/:id')
  deleteShift(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('force') force?: string) {
    return this.ops.deleteShift(user, id, force === '1' || force === 'true');
  }

  @Roles('store_manager')
  @Get('shift-assignments')
  shiftAssignments(@CurrentUser() user: AuthUser, @Query() q: ShiftAssignmentQueryDto, @StoreHeader() store?: string) {
    return this.ops.shiftAssignments(user, { ...q, storeId: q.storeId ?? store });
  }

  @Roles('store_manager')
  @Post('shift-assignments')
  createShiftAssignment(@CurrentUser() user: AuthUser, @Body() dto: CreateShiftAssignmentDto) {
    return this.ops.createShiftAssignment(user, dto);
  }

  @Roles('store_manager')
  @Patch('shift-assignments/:id')
  updateShiftAssignment(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateShiftAssignmentDto,
  ) {
    return this.ops.updateShiftAssignment(user, id, dto);
  }

  @Roles('store_manager')
  @Delete('shift-assignments/:id')
  deleteShiftAssignment(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.ops.deleteShiftAssignment(user, id);
  }

  @Permit('self.attendance')
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

  @Roles('store_manager')
  @Patch('holidays/:id')
  updateHoliday(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateHolidayDto) {
    return this.ops.updateHoliday(user, id, dto);
  }

  @Roles('store_manager')
  @Delete('holidays/:id')
  deleteHoliday(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.ops.deleteHoliday(user, id);
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
