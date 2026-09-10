import {
  IsArray,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Matches,
} from 'class-validator';
import { IsIndianMobile, IsRealName } from '../../common/contact.util';

export class SendWhatsAppDto {
  // `to` may be a phone number OR a WhatsApp group id, so we only require
  // non-empty here and skip @IsIndianMobile (a group id is not a mobile).
  @IsString()
  @IsNotEmpty()
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

  /**
   * Why this message is being sent. Defaults to `service`, which is what every
   * historic caller of this endpoint meant — a quote, a reminder, a DSR reply.
   * `marketing` additionally requires recorded consent and is refused without it.
   */
  @IsOptional()
  @IsIn(['service', 'marketing'])
  purpose?: 'service' | 'marketing';

  /** Repeat submissions with the same key resolve to the same outbound message. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  idempotencyKey?: string;
}

export class RegisterMetaAssetDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  integrationId!: string;

  @IsString()
  @IsIn(['page', 'ad_account', 'form'])
  kind!: 'page' | 'ad_account' | 'form';

  @IsString()
  @Matches(/^\d{3,64}$/)
  externalId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;
}

export class CreatePaymentLinkDto {
  /** Amount in rupees. */
  @IsNumber()
  @IsPositive()
  amount!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @IsRealName()
  customerName!: string;

  /** Store the resulting payment is attributed to (must be in caller's scope). */
  @IsString()
  @IsNotEmpty()
  storeId!: string;

  @IsOptional()
  @IsString()
  @IsIndianMobile()
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
