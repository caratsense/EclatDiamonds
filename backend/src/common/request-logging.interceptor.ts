import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';

import { AuthUser } from './auth-user';
import { current } from './tenant-context';

/**
 * Structured, tenant-aware request logging (Phase B5).
 *
 * ## What every line carries
 *
 * request id · organisation · actor · method · path · status · duration. Those
 * are the fields that turn "the app was slow at 3pm" into a query, and without
 * the organisation they turn a multi-tenant incident into guesswork about whose
 * data was involved.
 *
 * ## What it must never carry
 *
 * Bodies, headers and query strings are NOT logged. That is a deliberate blanket
 * rule rather than a redaction list, because a redaction list only protects the
 * fields someone remembered: this API's bodies contain passwords (`/auth/login`),
 * OTP codes, access tokens (`/integrations-registry/:id/credentials`), customer
 * phone numbers and payment references. A blanket rule cannot be defeated by
 * adding a new endpoint.
 *
 * The path IS logged, with ids left in place — they are needed to correlate, and
 * an opaque cuid is not personal data on its own.
 *
 * ## Sampling
 *
 * Successful, fast requests log at `debug`; anything slow or failing logs at
 * `warn`. A production log that records every 200 in 4ms is a log nobody reads,
 * which is the same as no log at all.
 */
@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Request');

  /** Above this, a request is worth seeing even when it succeeded. */
  private readonly slowMs = Number(process.env.SLOW_REQUEST_MS) || 1000;

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest();
    const started = Date.now();

    return next.handle().pipe(
      tap({
        next: () => this.write(req, http.getResponse()?.statusCode ?? 200, started),
        // An error still gets a line, and the filter logs the detail separately.
        // Without this, the slowest requests in the system — the failing ones —
        // would be the only ones with no timing recorded.
        error: (err) =>
          this.write(req, (err?.status as number) ?? 500, started, err?.message),
      }),
    );
  }

  private write(req: any, status: number, started: number, error?: string): void {
    const ms = Date.now() - started;
    const user = req.user as AuthUser | undefined;
    const scope = current();

    const org =
      user?.organisationId ??
      (scope?.kind === 'tenant' ? scope.organisationId : undefined) ??
      '-';
    const actor = user
      ? user.isMachine
        ? `agent:${user.agentId}`
        : `${user.id}:${user.role}`
      : 'anon';

    const line =
      `${req.method} ${req.route?.path ?? req.originalUrl?.split('?')[0] ?? '-'} ` +
      `${status} ${ms}ms org=${org} actor=${actor} rid=${req.requestId ?? '-'}` +
      (error ? ` err=${error}` : '');

    if (status >= 500 || ms >= this.slowMs) this.logger.warn(line);
    else if (status >= 400) this.logger.debug(line);
    else this.logger.debug(line);
  }
}
