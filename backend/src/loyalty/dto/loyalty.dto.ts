import {
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

/** yyyy-mm-dd (date-only). */
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export class EnrollMemberDto {
  @IsString()
  storeId!: string;

  @IsString()
  customerName!: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsString()
  planId!: string;

  /** Monthly installment amount (INR). */
  @IsNumber()
  @Min(0)
  installment!: number;
}

// ============================================================================
// MODULE 17 — "Earn with Éclat" referral / commission program
// ============================================================================

/** POST /loyalty/referral-codes — mint a coupon code for a referrer. */
export class CreateReferralCodeDto {
  @IsString()
  referrerName!: string;

  @IsOptional()
  @IsString()
  referrerPhone?: string;

  /** Optional anti-leak cap: how many times the code may be used (>= 1). */
  @IsOptional()
  @IsNumber()
  @Min(1)
  maxUses?: number;

  @IsOptional()
  @IsString()
  storeId?: string;
}

/** POST /loyalty/referrals — apply a code on a referee's purchase. */
export class CreateReferralDto {
  @IsString()
  code!: string;

  @IsString()
  refereeName!: string;

  @IsOptional()
  @IsString()
  refereePhone?: string;

  /** Referee's total bill amount (INR). */
  @IsNumber()
  @Min(0)
  billAmount!: number;

  @IsOptional()
  @IsString()
  storeId?: string;

  /** Optional per-request override of the 5% diamond discount (percent, 0–100). */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  diamondDiscountPct?: number;

  /** Optional per-request override of the 5% referrer commission (percent, 0–100). */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  commissionPct?: number;

  /** Round 2: invoice number of the referee's purchase. */
  @IsOptional()
  @IsString()
  invoiceNo?: string;

  /** Round 2: sale / bill date (date-only, yyyy-mm-dd). */
  @IsOptional()
  @Matches(YMD, { message: 'billDate must be yyyy-mm-dd' })
  billDate?: string;
}

/** POST /loyalty/referral-codes/:id/payout — draw down a referrer's balance. */
export class ReferralPayoutDto {
  /** Amount to redeem / cash out (INR), must not exceed the commission balance. */
  @IsNumber()
  @IsPositive()
  amount!: number;

  @IsIn(['redeem', 'cashout'])
  type!: 'redeem' | 'cashout';

  /** Round 2: invoice a redeem is tied to (encash/cashout has none). */
  @IsOptional()
  @IsString()
  invoiceNo?: string;
}
