import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { bindRequestScope } from './tenant-context';

/**
 * Opens the AsyncLocalStorage scope for every request and stamps a correlation
 * id, before guards run. JwtAuthGuard promotes the scope to a tenant once it has
 * resolved the authenticated user; anything that never authenticates (login,
 * health, webhooks) stays platform-scoped and tenant-less, which is honest.
 *
 * An inbound `x-request-id` is trusted only as a correlation label — it is echoed
 * into logs and the response, never used for any decision.
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  use(req: any, res: any, next: () => void): void {
    const inbound = req.headers?.['x-request-id'];
    const requestId =
      typeof inbound === 'string' && inbound.length > 0 && inbound.length <= 200
        ? inbound
        : randomUUID();
    req.requestId = requestId;
    res.setHeader?.('x-request-id', requestId);
    bindRequestScope(requestId, next);
  }
}
