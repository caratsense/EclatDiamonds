import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { IsRealName } from '../../common/contact.util';

/**
 * CRM DTOs (Phase A3). No class here accepts an `organisationId` — the tenant is
 * always the authenticated caller's.
 */

const CONTACT_KINDS = ['phone', 'email', 'whatsapp', 'instagram', 'external'];
const INTERACTION_KINDS = [
  'viewed',
  'shown',
  'shortlisted',
  'tried',
  'quoted',
  'rejected',
  'purchased',
];
const SLUG = /^[a-z0-9][a-z0-9_]*$/;

export class LookupCustomerDto {
  @IsString()
  @IsIn(CONTACT_KINDS)
  kind!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  value!: string;
}

export class ResolveCustomerDto {
  @IsString()
  @IsIn(CONTACT_KINDS)
  kind!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  value!: string;

  /**
   * Required when a new customer is to be created. Validated as a real name so a
   * phone number can never end up as a customer's name — the failure mode that
   * fills a CRM with customers called "9876543210".
   */
  @IsOptional()
  @IsString()
  @IsRealName()
  @MaxLength(160)
  name?: string;

  @IsOptional()
  @IsString()
  storeId?: string;

  @IsOptional()
  @IsBoolean()
  createIfMissing?: boolean;
}

export class LinkContactDto {
  @IsString()
  @IsIn(CONTACT_KINDS)
  kind!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  value!: string;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

export class RecordInteractionDto {
  @IsString()
  @IsIn(INTERACTION_KINDS)
  kind!: string;

  @IsOptional()
  @IsString()
  partyId?: string;

  @IsOptional()
  @IsString()
  leadId?: string;

  @IsOptional()
  @IsString()
  productId?: string;

  /** Free text so an item not yet in the catalogue is still recorded, not lost. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  sku?: string;

  @IsOptional()
  @IsString()
  storeId?: string;

  @IsOptional()
  @IsString()
  @IsIn(['store', 'web', 'whatsapp', 'instagram', 'phone'])
  channel?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000)
  quantity?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class ReplyDto {
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  body?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  mediaUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  mediaType?: string;
}

export class UpdateConversationDto {
  @IsOptional()
  @IsString()
  @IsIn(['open', 'snoozed', 'closed'])
  status?: string;

  @IsOptional()
  @IsString()
  @IsIn(['ai', 'human', 'unassigned'])
  handling?: string;

  /*
   * `assignedUserId` is DELIBERATELY not here.
   *
   * This route accepted it while validating only that the person belonged to the
   * organisation — no store-membership check and no role gate — which is exactly
   * the hole `POST :id/assign` exists to close. Leaving both doors open made the
   * rank required on `assign` decorative: anyone could hand a Hyderabad thread to
   * a Mumbai salesperson through here instead.
   *
   * Ownership changes go through `assign()`, which is the only place that checks
   * the destination and the assignee together. With `forbidNonWhitelisted`, a
   * client that still sends it gets a 400 rather than a silent no-op.
   */

  @IsOptional()
  @IsString()
  @MaxLength(500)
  handoffReason?: string;

  @IsOptional()
  @IsString()
  partyId?: string;
}

export class CreatePipelineDto {
  @IsString()
  @Matches(SLUG, { message: 'code must be lowercase letters, digits and underscores' })
  @MaxLength(50)
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @IsIn(['lead'])
  entity?: string;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class UpsertStageDto {
  @IsString()
  @Matches(SLUG, { message: 'code must be lowercase letters, digits and underscores' })
  @MaxLength(50)
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  label!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder?: number;

  @IsOptional()
  @IsString()
  @IsIn(['open', 'won', 'lost'])
  outcome?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  systemValue?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  probability?: number;
}

export class RejectMergeDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class BackfillIdentityDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5000)
  limit?: number;
}
