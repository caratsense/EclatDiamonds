import { Module } from '@nestjs/common';
import { CheckinsModule } from '../checkins/checkins.module';
import { ReportingController } from './reporting.controller';
import { ReportingService } from './reporting.service';
import { ScheduledReportsController } from './scheduled-reports.controller';
import { ScheduledReportsService } from './scheduled-reports.service';
import { DsrDigestService } from './dsr-digest.service';

/**
 * Reporting, and the reports that send themselves.
 *
 * `ScheduledReportsService` is exported so the scheduler can tick it. It reuses
 * `LeadExportService` (global, from CrmModule) rather than owning a second copy
 * of the workbook builder — two spreadsheet writers for one spreadsheet is how
 * the emailed file and the downloaded one come to disagree.
 */
@Module({
  // CheckinsModule supplies the walk-ins workbook for scheduled reports —
  // the same builder as the page's export button, never a second copy.
  imports: [CheckinsModule],
  controllers: [ReportingController, ScheduledReportsController],
  providers: [ReportingService, ScheduledReportsService, DsrDigestService],
  exports: [ScheduledReportsService, DsrDigestService],
})
export class ReportingModule {}
