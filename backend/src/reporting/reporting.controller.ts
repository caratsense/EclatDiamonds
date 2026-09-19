import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ReportingService } from './reporting.service';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { StoreHeader } from '../common/store-header.decorator';
import { Roles } from '../auth/roles.decorator';
import {
  ComplianceQueryDto,
  CreateDailyReportDto,
  DailyReportQueryDto,
  ReportSummaryQueryDto,
  SendDailyReportDto,
  SendReportDto,
} from './dto/reporting.dto';

@Controller('reporting')
export class ReportingController {
  constructor(private readonly reporting: ReportingService) {}

  /*
   * The DSR, the movers and the period roll-up are a branch's takings, stock
   * and cash — and, for head office, branch against branch. Store manager and
   * above; a salesperson's day lives on their own screens.
   */
  @Roles('store_manager', 'head_office')
  @Get('dsr')
  dsr(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.reporting.dsr(user, store);
  }

  @Roles('store_manager', 'head_office')
  @Get('movers')
  movers(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.reporting.movers(user, store);
  }

  /**
   * GET /reporting/summary?period=daily|weekly|monthly&date=YYYY-MM-DD
   * Store-scoped roll-up of sales / orders / payments for the period containing `date`.
   */
  @Roles('store_manager', 'head_office')
  @Get('summary')
  summary(
    @CurrentUser() user: AuthUser,
    @Query() query: ReportSummaryQueryDto,
    @StoreHeader() store?: string,
  ) {
    return this.reporting.summary(user, query.period ?? 'daily', query.date, store);
  }

  /**
   * POST /reporting/send — compose the summary and deliver it via WhatsApp or email.
   *
   * Manager+ only. This endpoint takes an arbitrary `to` (any phone number, any
   * email address) and sends it the store's revenue, collections and payment
   * mix. Ungated, it is a one-call data-exfiltration path for anyone with a
   * login — the sensitivity is in the payload, not the route name.
   */
  @Roles('store_manager', 'head_office')
  @Post('send')
  send(
    @CurrentUser() user: AuthUser,
    @Body() dto: SendReportDto,
    @StoreHeader() store?: string,
  ) {
    return this.reporting.send(user, dto, store);
  }

  /**
   * GET /reporting/compliance?days=7&storeId= — which branches have filed a
   * daily report and which have not. Manager+ (a salesperson has no use for a
   * cross-branch adherence view). Store-scoped, organisation-bounded in the service.
   */
  @Roles('store_manager', 'head_office')
  @Get('compliance')
  compliance(
    @CurrentUser() user: AuthUser,
    @Query() query: ComplianceQueryDto,
    @StoreHeader() store?: string,
  ) {
    return this.reporting.compliance(user, query, store);
  }

  /** POST /reporting/daily — capture a store-close Daily Sales Report (Module 10). */
  // A salesperson files the day's report; only a manager may overwrite one
  // already filed (enforced in the service).
  @Roles('salesperson')
  @Post('daily')
  createDaily(@CurrentUser() user: AuthUser, @Body() dto: CreateDailyReportDto) {
    return this.reporting.createDaily(user, dto);
  }

  /** GET /reporting/daily?date=YYYY-MM-DD&storeId= — store-scoped DSR list. */
  // The store's filed reports, so a salesperson can see what was sent.
  @Roles('salesperson')
  @Get('daily')
  listDaily(
    @CurrentUser() user: AuthUser,
    @Query() query: DailyReportQueryDto,
    @StoreHeader() store?: string,
  ) {
    return this.reporting.listDaily(user, query, store);
  }

  /** GET /reporting/daily/:id — a single DSR, gated to the caller's store scope. */
  @Roles('salesperson')
  @Get('daily/:id')
  getDaily(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.reporting.getDaily(user, id);
  }

  /**
   * POST /reporting/daily/:id/send — deliver the composed DSR via WhatsApp/email.
   * Manager+ for the same reason as `/send`: it ships the day's takings to an
   * arbitrary external recipient.
   */
  @Roles('store_manager', 'head_office')
  @Post('daily/:id/send')
  sendDaily(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: SendDailyReportDto,
  ) {
    return this.reporting.sendDaily(user, id, dto);
  }
}
