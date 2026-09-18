import { Controller, Get, NotFoundException, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Roles } from '../auth/roles.decorator';
import { AuthUser, CurrentUser } from '../common/auth-user';
import { AttendanceAnalyticsService, toCsv } from './attendance-analytics.service';
import { AnalyticsQueryDto, REPORT_KINDS, ReportKind, ReportQueryDto } from './dto/attendance-analytics.dto';

/**
 * Attendance analytics + report families (docs/modules/06-attendance.md).
 * Management information: store manager and above. Scope is enforced in the
 * service from the token; `storeId` only narrows.
 */
@Roles('store_manager')
@Controller('hrms')
export class AttendanceAnalyticsController {
  constructor(private readonly analytics: AttendanceAnalyticsService) {}

  @Get('analytics/overview')
  overview(@CurrentUser() user: AuthUser, @Query() q: AnalyticsQueryDto) {
    return this.analytics.overview(user, q);
  }

  @Get('reports/:kind')
  async report(
    @CurrentUser() user: AuthUser,
    @Param('kind') kind: string,
    @Query() q: ReportQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!(REPORT_KINDS as readonly string[]).includes(kind)) {
      throw new NotFoundException(`Unknown report "${kind}"`);
    }
    const report = await this.analytics.report(user, kind as ReportKind, q);
    if (q.format !== 'csv') return report;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="attendance-${kind}-${report.period.from}_${report.period.to}.csv"`,
    );
    return toCsv(report);
  }
}
