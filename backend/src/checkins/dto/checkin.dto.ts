import { IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { CheckinOutcome, CheckinPurpose } from '@prisma/client';
import { IsIndianMobile } from '../../common/contact.util';

export class CreateCheckInDto {
  @IsString()
  storeId!: string;

  @IsString()
  customerName!: string;

  @IsOptional()
  @IsString()
  @IsIndianMobile()
  phone?: string;

  @IsOptional()
  @IsEnum(CheckinPurpose)
  purpose?: CheckinPurpose;

  @IsOptional()
  @IsString()
  repId?: string;

  @IsOptional()
  @IsString()
  repName?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  partySize?: number;
}

export class CheckoutDto {
  @IsOptional()
  @IsEnum(CheckinOutcome)
  outcome?: CheckinOutcome;
}
