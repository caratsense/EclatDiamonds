import { Global, Module } from '@nestjs/common';

import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { JobAlertsService } from './job-alerts.service';

/**
 * The background-job queue (CaratOS Phase A8). @Global because handlers are
 * registered by feature modules across the app, and every one of them would
 * otherwise need an import purely to enqueue.
 */
@Global()
@Module({
  controllers: [JobsController],
  providers: [JobsService, JobAlertsService],
  exports: [JobsService, JobAlertsService],
})
export class JobsModule {}
