import {
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { LedgerKind, LedgerSide } from '@prisma/client';

export class CreateLedgerEntryDto {
  @IsString()
  storeId!: string;

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
