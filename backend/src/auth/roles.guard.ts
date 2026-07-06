import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { ROLES_KEY } from './roles.decorator';
import { AuthUser } from '../common/auth-user';
import { ROLE_RANK } from '../common/role.util';

/**
 * Role hierarchy guard. A route annotated with @Roles(store_manager) admits
 * store_manager AND anything ranked higher (area_manager, head_office), since
 * the role hierarchy rolls up (CLAUDE.md rule #2).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const user = context.switchToHttp().getRequest().user as AuthUser;
    if (!user) throw new ForbiddenException('No authenticated user');

    const minRank = Math.min(...required.map((r) => ROLE_RANK[r]));
    if (ROLE_RANK[user.role] < minRank) {
      throw new ForbiddenException('Insufficient role');
    }
    return true;
  }
}
