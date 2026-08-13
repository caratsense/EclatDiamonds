import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
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

  /**
   * Who the collection is from. Free-text identity for an un-linked walk-in
   * collection — required so a receipt can never be booked against a nameless
   * "walk in" placeholder. When a party is linked, this still carries the name
   * the counter typed.
   */
  @IsString()
  @IsNotEmpty()
  reference!: string;

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

/** POST /payments/:id/reverse — reason for reversing a collection (store manager+). */
export class ReversePaymentDto {
  @IsString()
  @IsNotEmpty({ message: 'A reversal reason is required' })
  reason!: string;
}
