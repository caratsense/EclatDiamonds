import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { AuthUser } from './auth-user';
import { current } from './tenant-context';

/**
 * AllExceptionsFilter — the single place every unhandled error passes through.
 *
 * Three jobs:
 *  1. LOG server faults (5xx) with enough context to actually debug them —
 *     method, path, store, the acting user and the stack. Expected 4xx
 *     (validation / forbidden / not-found) are logged thin, never as errors,
 *     so real faults stay visible in the noise.
 *  2. NEVER leak internals to the client. A 5xx returns a generic message;
 *     the detail lives in the logs only.
 *  3. ALERT on server faults via an optional webhook (ALERT_WEBHOOK_URL —
 *     any Slack/Discord/Teams incoming webhook). Fire-and-forget and
 *     de-duplicated, so one bad endpoint can never spam the channel.
 *
 * This filter must never throw: a crash in error handling would mask the very
 * fault it exists to report.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  /** signature -> last-alerted epoch ms, so we alert once per window. */
  private readonly lastAlerted = new Map<string, number>();
  private static readonly ALERT_WINDOW_MS = 10 * 60 * 1000; // 10 min per signature
  private static readonly MAX_SIGNATURES = 500; // bound the map

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const isHttp = exception instanceof HttpException;
    // Not everything client-caused is a Nest HttpException. The body parser
    // throws `http-errors` objects — a request over the size limit arrives as
    // PayloadTooLargeError with `status: 413` and `expose: true` — and treating
    // those as unknown faults answered 500 and paged someone for a client
    // sending too much data. Only a 4xx from a self-describing, exposable error
    // is trusted; nothing else gets to choose its own status code.
    const clientStatus = isHttp ? null : exposableClientStatus(exception);
    const status = isHttp
      ? exception.getStatus()
      : (clientStatus ?? HttpStatus.INTERNAL_SERVER_ERROR);

    // Expected, client-caused responses: pass straight through, logged thin.
    if (status < 500) {
      if (isHttp) {
        this.logger.debug(
          `${req?.method} ${req?.originalUrl} -> ${status}`,
        );
        return this.send(res, status, exception.getResponse());
      }
      // An exposable message from `http-errors` says what the client did wrong
      // ("request entity too large"); anything else stays generic.
      const message =
        clientStatus !== null && typeof (exception as { message?: unknown })?.message === 'string'
          ? (exception as { message: string }).message
          : 'Request failed';
      return this.send(res, status, { statusCode: status, message });
    }

    // ---- server fault: log richly, answer thinly ----------------------------
    const user = (req as any)?.user as AuthUser | undefined;
    const err = exception as any;
    const detail = err?.message ?? String(exception);
    const where = `${req?.method ?? '-'} ${req?.originalUrl ?? '-'}`;

    try {
      // ORGANISATION and REQUEST ID added in Phase B5. Without the tenant, a
      // multi-tenant incident cannot be scoped to whose data was involved; without
      // the correlation id, this line cannot be tied to the request log entry that
      // recorded its timing.
      const scope = current();
      const org =
        user?.organisationId ?? (scope?.kind === 'tenant' ? scope.organisationId : '-');
      this.logger.error(
        `${where} -> ${status} | org=${org} user=${user?.id ?? 'anon'} (${user?.role ?? '-'}) ` +
          `store=${(req?.headers?.['x-store-id'] as string) ?? '-'} ` +
          `rid=${(req as any)?.requestId ?? '-'} | ${detail}`,
        err?.stack,
      );
    } catch {
      /* logging must never break the response */
    }

    void this.alert(where, status, detail, user);

    this.send(res, status, {
      statusCode: status,
      message: 'Something went wrong. The team has been notified.',
    });
  }

  /** Write the response defensively (headers may already be sent). */
  private send(res: Response, status: number, body: unknown): void {
    try {
      if (!res || (res as any).headersSent) return;
      res.status(status).json(body);
    } catch {
      /* nothing more we can do */
    }
  }

  /**
   * Fire-and-forget alert to ALERT_WEBHOOK_URL. De-duplicated per
   * method+path+message so a hot loop cannot flood the channel. Any failure
   * here is swallowed — alerting is never load-bearing.
   */
  private async alert(
    where: string,
    status: number,
    detail: string,
    user?: AuthUser,
  ): Promise<void> {
    const url = process.env.ALERT_WEBHOOK_URL;
    if (!url) return;

    const signature = `${where}::${detail}`.slice(0, 300);
    const now = Date.now();
    const last = this.lastAlerted.get(signature) ?? 0;
    if (now - last < AllExceptionsFilter.ALERT_WINDOW_MS) return;

    if (this.lastAlerted.size > AllExceptionsFilter.MAX_SIGNATURES) {
      this.lastAlerted.clear();
    }
    this.lastAlerted.set(signature, now);

    const text =
      `🚨 Eclat backend ${status}\n` +
      `${where}\n` +
      `user: ${user?.id ?? 'anon'} (${user?.role ?? '-'})\n` +
      `${detail}`;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // `text` suits Slack + Discord; `content` is Discord's field.
        body: JSON.stringify({ text, content: text }),
        signal: controller.signal,
      });
      clearTimeout(timer);
    } catch {
      /* never let alerting affect the request */
    }
  }
}

/**
 * The status an `http-errors`-style exception is asking for, when it is a client
 * error that is safe to surface.
 *
 * `expose` is the library's own signal that the message was written for the
 * caller rather than for a log. Anything outside 4xx, or without it, is not
 * trusted to pick its own status: a server fault must not be able to disguise
 * itself as a client mistake and disappear from the error logs.
 */
function exposableClientStatus(exception: unknown): number | null {
  if (!exception || typeof exception !== 'object') return null;
  const err = exception as { status?: unknown; statusCode?: unknown; expose?: unknown };
  if (err.expose !== true) return null;
  const raw = typeof err.status === 'number' ? err.status : err.statusCode;
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return null;
  return raw >= 400 && raw <= 499 ? raw : null;
}
