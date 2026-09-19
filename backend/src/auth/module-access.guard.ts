import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthUser } from '../common/auth-user';
import { ROLE_RANK } from '../common/role.util';
import { IS_PUBLIC_KEY } from './public.decorator';
import { routeForPath } from './access';

/**
 * Per-screen access (auth/access.ts), enforced on the API.
 *
 * Runs after JwtAuthGuard (which puts the person's access map on the request)
 * and before RolesGuard:
 *
 *  - a screen the person does not hold is refused, whatever their role;
 *  - a screen held at `store` level by a front-line person (a salesperson head
 *    office gave Inventory to, a marketing person on CRM) is served as a store
 *    manager would be — for that screen's API only, still inside their stores;
 *  - a screen held at `own` level by a manager is served as a salesperson would
 *    be, i.e. only their own records.
 *
 * Shared APIs (products, parties, stores, users, config…) belong to no screen
 * and pass through to the role checks unchanged. Head office is never limited.
 */
@Injectable()
export class ModuleAccessGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const user = req.user as AuthUser | undefined;
    const targets = [context.getHandler(), context.getClass()];
    if (!user || user.isMachine || !user.access || user.role === 'head_office') return true;
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const route = routeForPath(req.route?.path ?? req.path ?? '');
    if (!route?.module) return true;
    const level = user.access[route.module];
    if (!level) {
      // A shared API: not holding the screen that leads it is no reason to refuse.
      if (route.soft) return true;
      throw new ForbiddenException('This screen is not switched on for you.');
    }

    const rank = ROLE_RANK[user.role];
    if (level === 'store' && rank < ROLE_RANK.store_manager) {
      req.user = { ...user, role: 'store_manager', actingAs: user.role };
    } else if (level === 'own' && rank >= ROLE_RANK.store_manager) {
      req.user = { ...user, role: 'salesperson', actingAs: user.role };
    }
    return true;
  }
}
