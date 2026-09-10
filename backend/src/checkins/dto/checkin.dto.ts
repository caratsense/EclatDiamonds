import { IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { CheckinOutcome, CheckinPurpose } from '@prisma/client';
import { IsIndianMobile, IsRealName } from '../../common/contact.util';

export class CreateCheckInDto {
  @IsString()
  @IsNotEmpty()
  storeId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @IsRealName()
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
  @MaxLength(120)
  @IsRealName()
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
