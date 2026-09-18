import { Controller, Get, NotFoundException, Param, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { Roles } from '../auth/roles.decorator';
import { AuthUser, CurrentUser } from '../common/auth-user';
import { AttendanceAnalyticsService, toCsv, toPdf, toXlsx } from './attendance-analytics.service';
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
    if (!q.format || q.format === 'json') return report;

    const stem = `attendance-${kind}-${report.period.from}_${report.period.to}`;
    res.setHeader('X-Export-Rows', String(report.rows.length));
    if (q.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${stem}.csv"`);
      return toCsv(report);
    }
    if (q.format === 'xlsx') {
      const buffer = await toXlsx(report);
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.setHeader('Content-Disposition', `attachment; filename="${stem}.xlsx"`);
      res.setHeader('Content-Length', String(buffer.byteLength));
      return new StreamableFile(buffer);
    }

    const buffer = await toPdf(report);
    res.setHeader('Content-Type', 'application/pdf');
    // Inline opens the browser's print-capable PDF viewer; clients may still
    // save it under the supplied filename.
    res.setHeader('Content-Disposition', `inline; filename="${stem}.pdf"`);
    res.setHeader('Content-Length', String(buffer.byteLength));
    return new StreamableFile(buffer);
  }
}
