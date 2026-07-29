import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { HrmsModule } from '../hrms/hrms.module';
import { JobRunnerService } from './job-runner.service';
import { SchedulerService } from './scheduler.service';
import { SchedulerController } from './scheduler.controller';

/**
 * Background jobs. Registered last in AppModule so everything it drives already
 * exists. `SCHEDULER_ENABLED=false` turns the jobs off without removing the
 * module — the read-only run log stays available either way.
 */
@Module({
  imports: [ScheduleModule.forRoot(), HrmsModule],
  controllers: [SchedulerController],
  providers: [SchedulerService, JobRunnerService],
  exports: [JobRunnerService],
})
export class SchedulerModule {}
