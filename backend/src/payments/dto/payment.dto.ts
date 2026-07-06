import {
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { PaymentMode } from '@prisma/client';

export class CreatePaymentDto {
  @IsString()
  storeId!: string;

  @IsNumber()
  @Min(0)
  amount!: number;

  @IsEnum(PaymentMode)
  mode!: PaymentMode;

  @IsOptional()
  @IsString()
  reference?: string;

  @IsOptional()
  @IsString()
  partyId?: string;

  @IsOptional()
  @IsString()
  saleId?: string;

  @IsOptional()
  @IsDateString()
  paidAt?: string;
}
