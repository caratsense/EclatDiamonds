import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Role } from '@prisma/client';

/**
 * The authenticated principal resolved by JwtAuthGuard and attached to req.user.
 *
 * `storeIds` is the FULL set of stores this user may read/write, already resolved
 * from UserStore assignments + role rank. `head_office` gets `allStores: true`
 * (no storeId filter at all). This is the single source of truth for store-scoping.
 */
export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** Stores the user is explicitly assigned to (always populated, even for HO). */
  storeIds: string[];
  /** true for head_office: bypass the storeId filter (sees every store). */
  allStores: boolean;
}

/** @CurrentUser() — inject the resolved AuthUser into a controller method. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const req = ctx.switchToHttp().getRequest();
    return req.user as AuthUser;
  },
);
