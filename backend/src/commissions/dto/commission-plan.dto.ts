import { IsBoolean, IsNotEmpty, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * PUT /commissions/plans — head office sets (upserts) a STORE's monthly sales
 * commission plan: commission = max(0, qualifying sales − threshold) × rate.
 */
export class UpsertCommissionPlanDto {
  @IsString()
  @IsNotEmpty()
  storeId!: string;

  /** Monthly qualifying-sales threshold in INR (e.g. 1500000 = ₹15,00,000). */
  @IsNumber()
  @Min(0)
  threshold!: number;

  /** Percent paid on the excess ABOVE the threshold (1 = 1%). */
  @IsNumber()
  @Min(0)
  @Max(100)
  ratePercent!: number;

  /** Switch the plan off without deleting its configuration. Defaults to true. */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
