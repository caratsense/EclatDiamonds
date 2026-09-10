import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  Equals,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { LeadSource, LeadStage } from '@prisma/client';

import { IsRealName } from '../../common/contact.util';

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const SHA256 = /^[a-f0-9]{64}$/;

/** A bounded, explainable lead query. It is stored as data, never executable code. */
export class LeadSegmentFiltersDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsString({ each: true })
  storeIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ArrayUnique()
  @IsString({ each: true })
  ownerIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ArrayUnique()
  @IsEnum(LeadSource, { each: true })
  sources?: LeadSource[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ArrayUnique()
  @IsEnum(LeadStage, { each: true })
  stages?: LeadStage[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @ArrayUnique()
  @IsIn(['open', 'won', 'lost'], { each: true })
  outcomes?: string[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  minValue?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  maxValue?: number;

  @IsOptional()
  @Matches(YMD, { message: 'createdFrom must be yyyy-mm-dd' })
  createdFrom?: string;

  @IsOptional()
  @Matches(YMD, { message: 'createdTo must be yyyy-mm-dd' })
  createdTo?: string;

  /** No activity for at least this many complete store-local calendar days. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3650)
  inactiveForDays?: number;

  @IsOptional()
  @IsBoolean()
  hasPhone?: boolean;
}

export class CreateLeadSegmentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ValidateNested()
  @Type(() => LeadSegmentFiltersDto)
  filters!: LeadSegmentFiltersDto;
}

export class PreviewLeadSegmentDto {
  @ValidateNested()
  @Type(() => LeadSegmentFiltersDto)
  filters!: LeadSegmentFiltersDto;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class MergeCustomersDto {
  /** Hash returned by the immediately preceding plan call. Prevents stale approval. */
  @IsString()
  @Matches(SHA256)
  planHash!: string;
}

export class LeadAgeingQueryDto {
  @IsOptional()
  @IsString()
  storeId?: string;

  @IsOptional()
  @IsEnum(LeadStage)
  stage?: LeadStage;

  @IsOptional()
  @IsIn(['open', 'won', 'lost', 'all'])
  outcome?: string;

  @IsOptional()
  @IsIn(['fresh', 'due_soon', 'breached', 'untouched'])
  bucket?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class ReplaceLeadAgeingPolicyDto {
  @IsInt()
  @Min(1)
  @Max(8760)
  defaultHours!: number;

  /** Optional overrides keyed only by LeadStage; the service rejects unknown keys. */
  @IsOptional()
  @IsObject()
  byStage?: Record<string, number>;
}

export class RoundRobinStoreDto {
  @IsString()
  @IsNotEmpty()
  storeId!: string;

  /** Empty means every active, approved salesperson assigned to this store. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsString({ each: true })
  eligibleUserIds?: string[];
}

export class ReplaceRoundRobinPolicyDto {
  @IsBoolean()
  enabled!: boolean;

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => RoundRobinStoreDto)
  stores!: RoundRobinStoreDto[];
}

export class RoundRobinAssignDto {
  @IsIn(['lead', 'conversation'])
  entity!: 'lead' | 'conversation';

  @IsString()
  @IsNotEmpty()
  entityId!: string;
}

export class IssueLeadQrDto {
  @IsString()
  @IsNotEmpty()
  storeId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  defaultInterest?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2160)
  expiresInHours?: number;
}

export class CaptureLeadFromQrDto {
  /** Client-generated request identity; repeating it returns the same lead. */
  @IsUUID('4')
  submissionId!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  @IsRealName()
  customerName!: string;

  /** Validated against the tenant's country after the opaque QR token is opened. */
  @IsString()
  @MinLength(8)
  @MaxLength(32)
  phone!: string;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  interest?: string;

  /** Explicit acknowledgement that the visitor asked the business to contact them. */
  @Equals(true)
  consent!: true;

  /** Honeypot. Real forms leave it empty; populated submissions are refused. */
  @IsOptional()
  @IsString()
  @MaxLength(0)
  website?: string;
}

