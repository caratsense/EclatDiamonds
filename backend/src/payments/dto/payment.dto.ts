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

  /**
   * Collection amount in INR. Strictly positive — a zero-rupee "collection" is
   * not a payment, it is a ledger row that inflates the count and reconciles
   * against nothing. Refunds go through Module 14 returns, not a negative here.
   */
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
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
