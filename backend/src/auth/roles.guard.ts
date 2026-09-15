import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { ROLES_KEY } from './roles.decorator';
import { IS_PUBLIC_KEY } from './public.decorator';
import { PERMISSION_ONLY_ROLES, PERMISSIONS_KEY, Permission, holds } from './permissions';
import { AuthUser } from '../common/auth-user';
import { ROLE_RANK } from '../common/role.util';

/**
 * Role hierarchy guard. A route annotated with @Roles(store_manager) admits
 * store_manager AND anything ranked higher (area_manager, head_office), since
 * the role hierarchy rolls up (CLAUDE.md rule #2).
 *
 * A PERMISSION-ONLY role (storeperson) never climbs that ladder: it is admitted
 * where the route `@Permit()`s a permission it holds, and refused everywhere
 * else — including routes with no `@Roles()` at all, which every ladder role may
 * open. Closed by default is the point: a controller added tomorrow is not
 * reachable by a storeperson until somebody decides it should be.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, targets);
    const user = context.switchToHttp().getRequest().user as AuthUser | undefined;

    if (
      user &&
      !user.isMachine &&
      PERMISSION_ONLY_ROLES.has(user.role) &&
      !this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)
    ) {
      const permits = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, targets) ?? [];
      if (permits.some((p) => holds(user.role, p))) return true;
      throw new ForbiddenException('Your role does not include this.');
    }

    if (!required || required.length === 0) return true;
    if (!user) throw new ForbiddenException('No authenticated user');

    const minRank = Math.min(...required.map((r) => ROLE_RANK[r]));
    if (ROLE_RANK[user.role] < minRank) {
      throw new ForbiddenException('Insufficient role');
    }
    return true;
  }
}
