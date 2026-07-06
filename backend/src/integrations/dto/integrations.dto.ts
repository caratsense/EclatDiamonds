import {
  IsArray,
  IsEmail,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator';

export class SendWhatsAppDto {
  @IsString()
  @MaxLength(20)
  to!: string;

  /** Plain-text body (used when no `template` is given). */
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  body?: string;

  /** Pre-approved template name — required to start a new conversation. */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  template?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  languageCode?: string;

  /** WhatsApp template component objects (header/body/button parameters). */
  @IsOptional()
  @IsArray()
  components?: unknown[];
}

export class CreatePaymentLinkDto {
  /** Amount in rupees. */
  @IsNumber()
  @IsPositive()
  amount!: number;

  @IsString()
  @MaxLength(120)
  customerName!: string;

  /** Store the resulting payment is attributed to (must be in caller's scope). */
  @IsString()
  storeId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;

  @IsOptional()
  @IsString()
  partyId?: string;

  @IsOptional()
  @IsString()
  saleId?: string;

  @IsOptional()
  @IsString()
  schemeMemberId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  callbackUrl?: string;
}
