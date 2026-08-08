import { Controller, Get, Query } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { Roles } from '../auth/roles.decorator';

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

  /** Recent job runs, newest first. */
  @Get('runs')
  runs(@Query('job') job?: string, @Query('limit') limit?: string) {
    const take = Math.min(Math.max(Number(limit) || 50, 1), 200);
    return this.prisma.scheduledJobRun.findMany({
      where: job ? { job } : undefined,
      orderBy: { startedAt: 'desc' },
      take,
    });
  }
}
