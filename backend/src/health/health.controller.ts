import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../auth/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Liveness probe for Railway healthchecks and uptime monitors.
 * Deliberately touches nothing (no DB, no Redis) so it stays fast and truthful
 * about process liveness even when downstream dependencies are saturated.
 * Skips the rate limiter so a flood from one IP can never starve the healthcheck.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @SkipThrottle()
  @Get()
  check() {
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * GET /health/ready — READINESS, not liveness: actually reaches the database.
   * Point an external uptime monitor here to learn "the system can serve real
   * work", which `/health` (process-only) cannot tell you. Returns 503 when the
   * DB is unreachable so a monitor alerts instead of seeing a cheerful 200.
   *
   * NOT used as Railway's healthcheck: a transient DB blip should not cause the
   * platform to kill an otherwise-healthy container.
   */
  @Public()
  @SkipThrottle()
  @Get('ready')
  async ready(@Res() res: Response) {
    const startedAt = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return res.status(HttpStatus.OK).json({
        status: 'ready',
        database: 'up',
        latencyMs: Date.now() - startedAt,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      return res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        status: 'degraded',
        database: 'down',
        latencyMs: Date.now() - startedAt,
        error: (err as Error)?.message ?? 'database unreachable',
        timestamp: new Date().toISOString(),
      });
    }
  }
}
