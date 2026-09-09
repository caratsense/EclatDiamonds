import {
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { CampaignStatus, CampaignType } from '@prisma/client';
import { IsRealName } from '../../common/contact.util';

/** Raw MarketingAsset status values (deliverables + agency tasks share the column). */
const ASSET_STATUSES = [
  'pending',
  'in_progress',
  'submitted',
  'approved',
  'changes_requested',
  'rejected',
] as const;

export class CreateCampaignDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @IsRealName()
  name!: string;

  @IsEnum(CampaignType)
  type!: CampaignType;

  @IsOptional()
  @IsEnum(CampaignStatus)
  status?: CampaignStatus;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  budget?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  @IsRealName()
  ownerName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  @IsRealName()
  agency?: string;

  /** Target stores (join rows). Omit for a pan-India campaign. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  storeIds?: string[];

  /** Delivery channels (whatsapp, sms, email, social, ...). */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  channels?: string[];
}

export class CreateAssetDto {
  @IsOptional()
  @IsString()
  campaignId?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @IsRealName()
  title!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  type!: string;

  @IsOptional()
  @IsString()
  url?: string;
}

export class UpdateAssetStatusDto {
  @IsIn(ASSET_STATUSES as unknown as string[])
  status!: string;
}

export class CreateAgencyTaskDto {
  @IsOptional()
  @IsString()
  campaignId?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @IsRealName()
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  @IsRealName()
  assignee?: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string;
}

export class UpdateAgencyTaskStatusDto {
  @IsIn(ASSET_STATUSES as unknown as string[])
  status!: string;
}
