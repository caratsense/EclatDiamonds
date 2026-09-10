import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * A normalised inbound-call notification.
 *
 * Provider-neutral: every telephony vendor names these fields differently, and
 * the mapping belongs in whichever adapter is eventually written for one, not
 * in the shape the rest of the product reads.
 *
 * The endpoint is public, so this DTO is the type boundary as well as the
 * validation. `forbidNonWhitelisted` is on globally, which means a payload
 * carrying anything not declared here is refused rather than quietly stored —
 * the right direction for a body that arrives from outside.
 */
export class TelephonyWebhookDto {
  /** The caller. Kept as sent; normalisation is the CRM identity layer's job. */
  @IsString()
  @MinLength(4)
  @MaxLength(32)
  fromNumber!: string;

  /** The number that was DIALLED. This is what decides which branch owns it. */
  @IsString()
  @MinLength(4)
  @MaxLength(32)
  toNumber!: string;

  /**
   * The provider's own id for this call.
   *
   * Required, and the reason a retried delivery is a no-op rather than a second
   * enquiry, a second task and a doubled call count in the day's report.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(191)
  callId!: string;

  @IsOptional()
  @IsIn(['inbound', 'outbound'])
  direction?: 'inbound' | 'outbound';

  @IsOptional()
  @IsInt()
  @Min(0)
  // A day. Anything longer is a provider bug, and storing it would poison every
  // average-call-length figure that reads this column.
  @Max(86_400)
  durationSec?: number;

  /** The provider's outcome word. Vocabulary is the tenant's, so no enum. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  disposition?: string;

  /**
   * A LINK to the provider's recording, never the audio.
   *
   * See the CallLog model header: holding customer call recordings would mean a
   * retention policy nobody has agreed in a jurisdiction nobody has chosen.
   */
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2048)
  recordingUrl?: string;

  @IsOptional()
  @IsISO8601()
  startedAt?: string;

  @IsOptional()
  @IsISO8601()
  answeredAt?: string;

  @IsOptional()
  @IsISO8601()
  endedAt?: string;

  /** Caller ID name, where the network supplies one. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  callerName?: string;
}
