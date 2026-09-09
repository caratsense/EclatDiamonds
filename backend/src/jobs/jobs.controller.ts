import { Controller, Get, Param, Post, Query } from '@nestjs/common';

import { AuthUser, CurrentUser } from '../common/auth-user';
import { Roles } from '../auth/roles.decorator';
import { JobsService } from './jobs.service';

/**
 * Background-job visibility (CaratOS Phase A8).
 *
 * Every route is bounded by the caller's organisation — a job list is operational
 * data about one tenant's imports and syncs, and the existing /scheduler/runs
 * endpoint's failure to do this is precisely the defect Phase B1 fixes.
 */
@Roles('store_manager', 'head_office')
@Controller('jobs')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('status') status?: string,
    @Query('kind') kind?: string,
    @Query('limit') limit?: string,
  ) {
    return this.jobs.list(user.organisationId, {
      status,
      kind,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('summary')
  summary(@CurrentUser() user: AuthUser) {
    return this.jobs.summary(user.organisationId);
  }

  /** Re-queue a job that exhausted its retries, once the cause is fixed. */
  @Roles('head_office')
  @Post(':id/retry')
  async retry(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const job = await this.jobs.retry(user.organisationId, id);
    return job
      ? { requeued: true, job }
      : { requeued: false, message: 'Job not found, or not in a state that can be retried.' };
  }
}
