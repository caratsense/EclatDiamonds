import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Role } from '@prisma/client';
import { IsIndianMobile, IsRealName } from '../../common/contact.util';

/**
 * Every role a self-signup can NAME. Never `head_office`, and `area_manager` was
 * folded into `store_manager` (2026-08). `store_manager` stays in the list only
 * so the API shape is stable: AuthService refuses it unless the tenant's signup
 * policy allows manager self-requests (users.util.requestableRoles).
 */
export const REQUESTABLE_ROLES: Role[] = ['salesperson', 'storeperson', 'store_manager'];

/**
 * POST /auth/signup — a person registers themselves. This creates a POWERLESS
 * pending request, not an account with access: the row is `isActive=false`,
 * `approvalStatus=pending`, real `role=salesperson`, and has no store link. The
 * requested role/store are recorded for the approver and granted only on approval.
 */
export class SignupDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(120)
  @IsRealName()
  name!: string;

  /**
   * Personal/contact email — OPTIONAL and not unique (two people may share one).
   * It is NOT the login: the sign-in identity is a generated Login ID returned by
   * signup. `email` is the original field name; `contactEmail` says what it is.
   */
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsEmail()
  contactEmail?: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsOptional()
  @IsString()
  @IsIndianMobile()
  phone?: string;

  /** The role the applicant is asking for. Never head_office. */
  @IsIn(REQUESTABLE_ROLES)
  requestedRole!: Role;

  /** The store the applicant wants to join. Validated + scope-checked at approval. */
  @IsString()
  @IsNotEmpty()
  requestedStoreId!: string;

  /**
   * The organisation code (slug) the applicant typed. When sent, the store must
   * belong to it — a store id from another tenant is refused exactly like one
   * that does not exist.
   */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  organisationCode?: string;
}

/** POST /auth/signup/preview — the Login ID format, computed from the template only. */
export class SignupPreviewDto {
  @IsString()
  @MaxLength(80)
  organisationCode!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  requestedStoreId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;
}
