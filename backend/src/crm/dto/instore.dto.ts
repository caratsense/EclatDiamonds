import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class LeadFeedDto {
  @IsOptional() @IsString() @Length(1, 40) storeId?: string;
  @IsOptional() @IsString() @Length(1, 40) stage?: string;
  @IsOptional() @IsString() @Length(1, 40) source?: string;
  @IsOptional() @IsString() @Length(1, 40) cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export class InStoreSearchDto {
  @IsString() @Length(3, 120) q!: string;
}

export class ScanItemDto {
  @IsString() @Length(1, 120) code!: string;
}

/**
 * One thing the customer asked about during a visit.
 *
 * Deliberately neutral: `productId` or a raw `sku`, a conversion flag, and a
 * tenant-configured reason when it did not convert. There is no jewellery
 * field here — a clinic's service and a mill's article use the same shape.
 */
export class VisitEnquiryDto {
  @IsOptional() @IsString() @Length(1, 40) productId?: string;
  @IsOptional() @IsString() @Length(1, 120) sku?: string;
  @IsOptional() @IsBoolean() converted?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(9999) quantity?: number;
  @IsOptional() @IsString() @Length(0, 500) notes?: string;
  @IsOptional() @IsString() @Length(1, 120) dropOffReason?: string;
}

export class RecordVisitDto {
  @IsString() @Length(1, 40) partyId!: string;
  @IsOptional() @IsString() @Length(1, 40) storeId?: string;
  /** A `checkin_purpose` taxonomy code from the tenant's own pack. */
  @IsOptional() @IsString() @Length(1, 60) purpose?: string;
  @IsOptional() @IsString() @Length(0, 2000) notes?: string;
  @IsOptional() @IsString() @Length(1, 40) attendedByUserId?: string;

  /** Tenant-defined visit fields (occasion, counter, department, …). */
  @IsOptional() @IsObject() fields?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => VisitEnquiryDto)
  enquiries?: VisitEnquiryDto[];
}
