import { Module } from '@nestjs/common';
import { ReportingController } from './reporting.controller';
import { ReportingService } from './reporting.service';
import { ScheduledReportsController } from './scheduled-reports.controller';
import { ScheduledReportsService } from './scheduled-reports.service';

/**
 * Reporting, and the reports that send themselves.
 *
 * `ScheduledReportsService` is exported so the scheduler can tick it. It reuses
 * `LeadExportService` (global, from CrmModule) rather than owning a second copy
 * of the workbook builder — two spreadsheet writers for one spreadsheet is how
 * the emailed file and the downloaded one come to disagree.
 */
@Module({
  controllers: [ReportingController, ScheduledReportsController],
  providers: [ReportingService, ScheduledReportsService],
  exports: [ScheduledReportsService],
})
export class ReportingModule {}
