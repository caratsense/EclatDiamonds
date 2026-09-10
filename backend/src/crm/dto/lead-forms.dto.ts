import {
  ArrayMaxSize,
  Equals,
  IsArray,
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsInt,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { IsRealName } from '../../common/contact.util';

export class CreateLeadFormDto {
  @IsString() @IsNotEmpty() @MaxLength(120)
  name!: string;

  @IsString() @IsNotEmpty()
  storeId!: string;

  @IsOptional() @IsString() @MaxLength(280)
  defaultInterest?: string;

  @IsOptional() @IsString() @MaxLength(120)
  campaign?: string;

  /** Full origins, e.g. "https://www.example.com". Empty means any origin. */
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true })
  allowedOrigins?: string[];
}

export class UpdateLeadFormDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(120)
  name?: string;

  @IsOptional() @IsString() @IsNotEmpty()
  storeId?: string;

  @IsOptional() @IsString() @MaxLength(280)
  defaultInterest?: string;

  @IsOptional() @IsString() @MaxLength(120)
  campaign?: string;

  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true })
  allowedOrigins?: string[];

  /** The kill switch. */
  @IsOptional() @IsBoolean()
  enabled?: boolean;
}

export class SubmitLeadFormDto {
  /** Client-generated per form load; repeating it returns the same lead. */
  @IsUUID('4')
  submissionId!: string;

  @IsString() @MinLength(2) @MaxLength(120) @IsRealName()
  customerName!: string;

  /** One of phone or email is required; the service enforces that pair rule. */
  @IsOptional() @IsString() @MinLength(8) @MaxLength(32)
  phone?: string;

  @IsOptional() @IsEmail() @MaxLength(160)
  email?: string;

  @IsOptional() @IsString() @MaxLength(280)
  interest?: string;

  /** Explicit acknowledgement that the visitor asked to be contacted. */
  @Equals(true)
  consent!: true;

  /** Honeypot. Real forms leave it empty; populated submissions are refused. */
  @IsOptional() @IsString() @MaxLength(0)
  website?: string;
}

export class OpenImportLeadsDto {
  /** What these imported customers are being followed up about. */
  @IsString() @IsNotEmpty() @MaxLength(280)
  interest!: string;

  /** Required when the import was organisation-wide rather than branch-scoped. */
  @IsOptional() @IsString() @IsNotEmpty()
  storeId?: string;

  /** Bounded server-side to 2000. */
  @IsOptional() @IsInt() @Min(1) @Max(2000)
  limit?: number;
}
