import { IsEmail, IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { Role } from '@prisma/client';

/** Roles a head-office admin may assign here — never `head_office` (HO cannot mint another HO). */
export const ASSIGNABLE_ROLES: Role[] = ['salesperson', 'store_manager', 'area_manager'];

/**
 * POST /users — head office onboards a staff member (defaults to salesperson).
 * Requires at least one login identifier (phone and/or email); enforced in the
 * service since either is individually optional.
 */
export class CreateUserDto {
  @IsString()
  @MinLength(2)
  name!: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsString()
  storeId!: string;

  /** Defaults to `salesperson` when omitted. `head_office` is not assignable here. */
  @IsOptional()
  @IsIn(ASSIGNABLE_ROLES)
  role?: Role;
}

/** PATCH /users/:id/role — promote/demote within the assignable set (never to head_office). */
export class UpdateUserRoleDto {
  @IsIn(ASSIGNABLE_ROLES)
  role!: Role;
}

/** PATCH /users/:id/store — reassign a user's primary store. */
export class UpdateUserStoreDto {
  @IsString()
  storeId!: string;
}

/**
 * PATCH /users/:id/deactivate — offboard a user, optionally handing off their
 * open work (owned leads + check-ins) to another active in-scope user.
 */
export class DeactivateUserDto {
  /** If given, the deactivated user's open leads/check-ins are reassigned here. */
  @IsOptional()
  @IsString()
  reassignToId?: string;
}
