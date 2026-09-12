import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export class QuoteApprovalSettingsDto {
  /**
   * Quotes at or above this amount need a manager's decision before they can be
   * sent. `null` switches the gate off entirely, which is the default — an
   * existing tenant behaves exactly as it did until somebody chooses a number.
   */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(99_999_999)
  valueThreshold?: number | null;

  /**
   * Whether the person who asked may also decide. Off by default: separation is
   * the point of an approval step, and a tenant switching it on should have to
   * mean it.
   */
  @IsOptional()
  @IsBoolean()
  allowSelfApproval?: boolean;
}

export class DecideQuoteDto {
  @IsBoolean()
  approve!: boolean;

  /** Required when rejecting — enforced in the service, where the verb is known. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
