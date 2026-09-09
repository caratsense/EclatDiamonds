import { Controller, Get, Query } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { Roles } from '../auth/roles.decorator';
import { AuthUser, CurrentUser } from '../common/auth-user';

/**
 * Read-only visibility into the background jobs.
 *
 * Automatic work that leaves no trace is work nobody can trust: "did last night's
 * attendance close run?" had no answer before this. Management-only — the run log
 * shows which stores exist and when their day ended.
 */
@Roles('store_manager', 'head_office')
@Controller('scheduler')
export class SchedulerController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Recent job runs for the CALLER'S organisation, newest first.
   *
   * This route previously injected no @CurrentUser at all and queried
   * `scheduledJobRun` unfiltered, so any store manager on any tenant could read
   * every tenant's job history — store names, run timings, error text. It
   * survived a dedicated tenant-isolation pass precisely because there was no
   * user parameter to notice was missing: nothing looked wrong at the call site.
   *
   * Runs with a NULL organisationId are platform-level (a global sweep) and are
   * deliberately excluded rather than shown to everyone.
   */
  @Get('runs')
  runs(
    @CurrentUser() user: AuthUser,
    @Query('job') job?: string,
    @Query('limit') limit?: string,
  ) {
    const take = Math.min(Math.max(Number(limit) || 50, 1), 200);
    return this.prisma.scheduledJobRun.findMany({
      where: {
        organisationId: user.organisationId,
        ...(job ? { job } : {}),
      },
      orderBy: { startedAt: 'desc' },
      take,
    });
  }
}
