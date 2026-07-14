import {
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { CampaignStatus, CampaignType } from '@prisma/client';

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
  ownerName?: string;

  @IsOptional()
  @IsString()
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
  title!: string;

  @IsString()
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
  title!: string;

  @IsOptional()
  @IsString()
  assignee?: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string;
}

export class UpdateAgencyTaskStatusDto {
  @IsIn(ASSET_STATUSES as unknown as string[])
  status!: string;
}
