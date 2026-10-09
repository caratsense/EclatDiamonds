import {
  IsObject,
  IsBoolean,
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
  IsArray,
  ArrayNotEmpty,
  ArrayMaxSize,
} from 'class-validator';
import { LeaveType, Role } from '@prisma/client';
import { IsIndianMobile, IsRealName } from '../../common/contact.util';

/**
 * Roles a head-office admin may assign here — never `head_office` (HO cannot
 * mint another HO), and never the retired area manager or storeperson.
 */
/**
 * Roles a request may carry. head_office is in the LIST so the DTO does not
 * refuse it before the service can decide — the real rule lives in
 * assertAssignableRole: only head office may grant it, everyone else is
 * strictly below their own rank.
 */
export const ASSIGNABLE_ROLES: Role[] = ['salesperson', 'marketing', 'store_manager', 'area_manager', 'head_office'];

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

  /**
   * The password the manager hands this person, so the login works from the
   * first day. Held to the same rule as a manager's reset (ResetPasswordDto).
   * Left out, the account gets a random one nobody knows, as before.
   */
  @IsOptional()
  @IsString()
  @MinLength(8)
  password?: string;
}

/**
 * PUT /users/:id/access — head office's changes to what one person may open:
 * `{ "<screen>": "none" | "own" | "store" }`. Replaces the previous changes; an
 * entry equal to the role's default is dropped rather than stored.
 */
export class SetUserAccessDto {
  @IsObject()
  overrides!: Record<string, string>;
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
 * PATCH /users/:id/stores — the area-manager shape: the exact set of branches
 * this person covers (client, 7 Oct meeting 2: 4-5 assigned stores). Replaces
 * the user's links; the first id becomes the primary.
 */
export class SetUserStoresDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  storeIds!: string[];
}

/**
 * PATCH /users/:id/deactivate — offboard a user, optionally handing off their
 * open work (owned leads + check-ins) to another active in-scope user.
 */
export class LocationCheckDto {
  /** true = held to the store geofence (default for everyone); false = exempt. */
  @IsBoolean()
  required!: boolean;
}

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
 * store manager can only ever approve a salesperson or storeperson into a store
 * they own, and only head office can approve a store manager.
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
  @MaxLength(500)
  reason?: string;
}

/**
 * PUT /users/signup-policy — head office sets how new Login IDs look and whether
 * applicants may ask to be a store manager. Omitted fields are left unchanged;
 * an empty or null template restores the default format.
 */
export class UpdateSignupPolicyDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  loginIdTemplate?: string | null;

  @IsOptional()
  @IsBoolean()
  allowManagerSelfRequest?: boolean;
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
