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
 * Roles a self-signup may REQUEST. Never `head_office` — that is not grantable by
 * anyone, least of all the applicant themselves. `area_manager` was removed too:
 * the tier was folded into `store_manager` (2026-08), so it is no longer a role
 * anyone signs up as.
 */
export const REQUESTABLE_ROLES: Role[] = ['salesperson', 'store_manager'];

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
   * It is NOT the login: the sign-in identity is a generated
   * `firstname.storeslug@eclatdiamonds.in` handle returned by signup.
   */
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsOptional()
  @IsString()
  @IsIndianMobile()
  phone?: string;

  /** The role the applicant is asking for (default salesperson). Never head_office. */
  @IsIn(REQUESTABLE_ROLES)
  requestedRole!: Role;

  /** The store the applicant wants to join. Validated + scope-checked at approval. */
  @IsString()
  @IsNotEmpty()
  requestedStoreId!: string;
}
