import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { QuoteStatus } from '@prisma/client';

export class QuoteLineDto {
  @IsString()
  description!: string;

  @IsInt()
  karat!: number;

  @IsNumber()
  @Min(0)
  weightGrams!: number;

  @IsNumber()
  @Min(0)
  goldRatePerGram!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  makingCharges?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  stoneCharges?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  caratWeight?: number;

  @IsOptional()
  @IsString()
  productId?: string;
}

export class CreateQuoteDto {
  @IsString()
  storeId!: string;

  @IsString()
  customerName!: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsEnum(QuoteStatus)
  status?: QuoteStatus;

  @IsOptional()
  @IsString()
  validUntil?: string;

  @IsOptional()
  @IsString()
  leadId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  redeemableStoreIds?: string[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QuoteLineDto)
  lines!: QuoteLineDto[];
}
