import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/public.decorator';

/**
 * Liveness probe for Railway healthchecks and uptime monitors.
 * Deliberately touches nothing (no DB, no Redis) so it stays fast and truthful
 * about process liveness even when downstream dependencies are saturated.
 * Skips the rate limiter so a flood from one IP can never starve the healthcheck.
 */
@Controller('health')
export class HealthController {
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
}
