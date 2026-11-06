import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../auth/public.decorator';
import { CredentialCrypto } from '../integration/framework/credential-crypto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Liveness probe for Railway healthchecks and uptime monitors.
 * Deliberately touches nothing (no DB, no Redis) so it stays fast and truthful
 * about process liveness even when downstream dependencies are saturated.
 * Skips the rate limiter so a flood from one IP can never starve the healthcheck.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credentialCrypto: CredentialCrypto,
  ) {}

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

  /**
   * GET /health/deep — the three-way answer the brief asks for.
   *
   * Distinguishes states an uptime monitor must not conflate:
   *
   *   ok        the application is serving and the database answers;
   *   degraded  the application is serving but an optional dependency is not
   *             configured or not responding — WhatsApp cannot send, the AI
   *             inference service is unreachable. Real work continues.
   *   down      the database is unreachable. Nothing meaningful can be served.
   *
   * A single boolean would force the monitor to treat "the gold-rate feed is
   * having a bad morning" the same as "the database is gone", and whichever way
   * that is resolved is wrong half the time.
   *
   * Dependency checks are DECLARED, not probed: this endpoint reports whether a
   * dependency is configured, and does not make live outbound calls. Probing a
   * provider on every healthcheck would turn a monitor into a traffic source and
   * could itself trip a provider rate limit.
   */
  @Public()
  @SkipThrottle()
  @Get('deep')
  async deep(@Res() res: Response) {
    const startedAt = Date.now();
    let database: 'up' | 'down' = 'up';
    let dbError: string | null = null;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      database = 'down';
      dbError = (err as Error)?.message ?? 'database unreachable';
    }

    const knowledgeProvider = (process.env.KNOWLEDGE_STORAGE_PROVIDER ?? 'local').toLowerCase();
    const knowledgeR2Ready = Boolean(
      process.env.R2_ACCOUNT_ID &&
        process.env.R2_ACCESS_KEY_ID &&
        process.env.R2_SECRET_ACCESS_KEY &&
        (process.env.KNOWLEDGE_R2_BUCKET || process.env.R2_BUCKET),
    );
    // All three are needed before the platform number can carry anything.
    const whatsappPlatformParts = [
      process.env.WHATSAPP_ACCESS_TOKEN,
      process.env.WHATSAPP_PHONE_NUMBER_ID,
      process.env.WHATSAPP_PLATFORM_ORGANISATION_ID,
    ].filter(Boolean).length;
    const whatsappPlatform =
      whatsappPlatformParts === 3
        ? 'configured'
        : whatsappPlatformParts === 0
          ? 'not_configured'
          : 'misconfigured';

    const dependencies = {
      // Configured-or-not, stated plainly. "Not configured" is a normal state
      // for a deployment that has not connected a channel, NOT a fault — so it
      // is reported as its own value rather than as a failure.
      /*
       * The PLATFORM binding only — tenants connect their own numbers in the
       * database, and this endpoint has no tenant to ask about.
       *
       * It reported `configured` whenever the token alone was present, which
       * on this deployment was true and useless: the token was set, the other
       * two were not, so the platform number could never resolve and health
       * said "configured" about a path that could not send. All three are
       * required by `WhatsAppCredentialsService.senderFor`, so a partial set
       * is `misconfigured` — the same distinction knowledgeStorage makes below,
       * and the one that would have made this visible without a log dive.
       */
      whatsapp: whatsappPlatform,
      razorpay: process.env.RAZORPAY_KEY_ID ? 'configured' : 'not_configured',
      objectStorage: (process.env.STORAGE_PROVIDER ?? 'local') === 'local' ? 'local_disk' : 'configured',
      knowledgeStorage:
        knowledgeProvider === 'r2'
          ? knowledgeR2Ready
            ? 'configured'
            : 'misconfigured'
          : 'local_disk',
      visualSearch: process.env.ML_INFERENCE_URL ? 'configured' : 'not_configured',
      crmAi: process.env.CRM_AI_API_KEY ? 'configured' : 'not_configured',
      credentialEncryption: this.credentialCrypto.isConfigured
        ? 'configured'
        : process.env.CREDENTIAL_ENCRYPTION_KEY
          ? 'misconfigured'
          : 'not_configured',
    };

    // Only things that would silently corrupt or lose tenant data count as
    // degrading. An unconnected channel does not — the app is fully usable
    // without it, and flagging it would train operators to ignore this endpoint.
    const degraded: string[] = [];
    if (dependencies.credentialEncryption !== 'configured') {
      degraded.push(
        dependencies.credentialEncryption === 'misconfigured'
          ? 'credential encryption is misconfigured — check the 32-byte key and positive key version'
          : 'credential encryption is not configured — tenant integration secrets cannot be stored',
      );
    }
    if (dependencies.objectStorage === 'local_disk' && process.env.NODE_ENV === 'production') {
      degraded.push('object storage is local disk in production — uploads do not survive a redeploy');
    }
    if (dependencies.knowledgeStorage === 'misconfigured') {
      degraded.push('private knowledge storage is set to R2 but its credentials or bucket are incomplete');
    } else if (dependencies.knowledgeStorage === 'local_disk' && process.env.NODE_ENV === 'production') {
      degraded.push('private knowledge storage is local disk in production — source documents do not survive a redeploy');
    }

    const status = database === 'down' ? 'down' : degraded.length ? 'degraded' : 'ok';
    const code =
      status === 'down' ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.OK;

    return res.status(code).json({
      status,
      database,
      ...(dbError ? { databaseError: dbError } : {}),
      dependencies,
      degraded,
      latencyMs: Date.now() - startedAt,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  }

}
