import {
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { LeaveType, Role } from '@prisma/client';
import { IsIndianMobile, IsRealName } from '../../common/contact.util';

/** Roles a head-office admin may assign here — never `head_office` (HO cannot mint another HO). */
export const ASSIGNABLE_ROLES: Role[] = ['salesperson', 'store_manager'];

/**
 * POST /users — a manager onboards a staff member (defaults to salesperson).
 * Team add requires BOTH a phone and an email (confirmed rule). This is the
 * manager-add path ONLY — self-signup lives in AuthService and is unaffected.
 */
export class CreateUserDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(120)
  @IsRealName()
  name!: string;

  // Both mandatory for a manager-added staff member. The phone must be a real
  // Indian mobile (same rule as customers/quotes) — not merely "10 digits".
  @IsIndianMobile()
  phone!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @IsNotEmpty()
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
  @IsNotEmpty()
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

/**
 * POST /users/:id/approve — grant a pending self-signup. Both fields optional:
 * the approver may correct the requested role/store, otherwise the request's own
 * values are used. The strictly-below-rank + in-scope rules still apply, so a
 * store manager can only ever approve a salesperson into a store they own, and
 * only head office can approve a store/area manager.
 */
export class ApproveUserDto {
  @IsOptional()
  @IsIn(ASSIGNABLE_ROLES)
  role?: Role;

  @IsOptional()
  @IsString()
  storeId?: string;
}

/** POST /users/:id/reject — decline a pending self-signup (stays inactive). */
export class RejectUserDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

/**
 * PATCH /users/:id/leave-allocation — a manager sets how many days of a leave
 * type a staff member may take in a year (the "holidays allowed" quota). Upserts
 * the LeaveBalance row; `used` is untouched.
 */
export class SetLeaveAllocationDto {
  @IsIn(['casual', 'sick', 'earned', 'festival'])
  type!: LeaveType;

  @IsInt()
  @Min(2000)
  year!: number;

  @IsNumber()
  @Min(0)
  allocated!: number;
}
