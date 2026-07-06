import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ReportingService } from './reporting.service';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { StoreHeader } from '../common/store-header.decorator';
import { ReportSummaryQueryDto, SendReportDto } from './dto/reporting.dto';

@Controller('reporting')
export class ReportingController {
  constructor(private readonly reporting: ReportingService) {}

  @Get('dsr')
  dsr(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.reporting.dsr(user, store);
  }

  @Get('movers')
  movers(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.reporting.movers(user, store);
  }

  /**
   * GET /reporting/summary?period=daily|weekly|monthly&date=YYYY-MM-DD
   * Store-scoped roll-up of sales / orders / payments for the period containing `date`.
   */
  @Get('summary')
  summary(
    @CurrentUser() user: AuthUser,
    @Query() query: ReportSummaryQueryDto,
    @StoreHeader() store?: string,
  ) {
    return this.reporting.summary(user, query.period ?? 'daily', query.date, store);
  }

  /** POST /reporting/send — compose the summary and deliver it via WhatsApp or email. */
  @Post('send')
  send(
    @CurrentUser() user: AuthUser,
    @Body() dto: SendReportDto,
    @StoreHeader() store?: string,
  ) {
    return this.reporting.send(user, dto, store);
  }
}
