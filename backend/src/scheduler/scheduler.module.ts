import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { HrmsModule } from '../hrms/hrms.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { ReportingModule } from '../reporting/reporting.module';
import { JobRunnerService } from './job-runner.service';
import { SchedulerService } from './scheduler.service';
import { SchedulerController } from './scheduler.controller';

/**
 * Background jobs. Registered last in AppModule so everything it drives already
 * exists. `SCHEDULER_ENABLED=false` turns the jobs off without removing the
 * module — the read-only run log stays available either way.
 */
@Module({
  // ReportingModule is not @Global, so the scheduled-report tick needs it
  // named here. The edge runs one way (scheduler drives reporting), so there
  // is no cycle.
  imports: [ScheduleModule.forRoot(), HrmsModule, ReportingModule, LoyaltyModule],
  controllers: [SchedulerController],
  providers: [SchedulerService, JobRunnerService],
  exports: [JobRunnerService],
})
export class SchedulerModule {}
