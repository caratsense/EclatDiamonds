import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { LedgerKind, LedgerSide } from '@prisma/client';

/**
 * POST /finance/ledger — record a ledger entry (Module 4).
 *
 * `kind` accepts the full LedgerKind enum — AR, AP, expense, income, asset,
 * liability — so a manager can book budget/expense/income rows, not just AP/AR.
 * `status` carries the planning bucket (open / actual / budget / forecast and the
 * AP/AR lifecycle values partial / cleared / overdue) and `narration` the label
 * (e.g. Rentals, Salaries, New Store) used by the budget/cashflow reports.
 */
export class CreateLedgerEntryDto {
  @IsString()
  @IsNotEmpty()
  storeId!: string;

  /** AR | AP | expense | income | asset | liability. */
  @IsEnum(LedgerKind)
  kind!: LedgerKind;

  @IsEnum(LedgerSide)
  side!: LedgerSide;

  @IsNumber()
  @Min(0)
  amount!: number;

  @IsOptional()
  @IsDateString()
  entryDate?: string;

  @IsOptional()
  @IsString()
  narration?: string;

  @IsOptional()
  @IsString()
  partyId?: string;

  @IsOptional()
  @IsString()
  status?: string;
}
