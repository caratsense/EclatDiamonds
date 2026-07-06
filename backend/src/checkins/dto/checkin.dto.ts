import { IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { CheckinOutcome, CheckinPurpose } from '@prisma/client';

export class CreateCheckInDto {
  @IsString()
  storeId!: string;

  @IsString()
  customerName!: string;

  @IsOptional()
  @IsString()
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
