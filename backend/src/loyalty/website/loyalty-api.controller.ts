import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

import { Public } from '../../auth/public.decorator';
import { Roles } from '../../auth/roles.decorator';
import { HumansOnly } from '../../auth/machine.decorator';
import { AuthUser, CurrentUser } from '../../common/auth-user';
import { RateLimit } from '../../common/rate-limit';
import { LoyaltyApiService } from './loyalty-api.service';

/* ----------------------------------------------------------------- the DTOs */

/**
 * An idempotency key is REQUIRED on every movement, not optional.
 *
 * Optional would be worse than absent: the calls that omit it are exactly the
 * hurried integrations that retry hardest, and the failure only shows up as a
 * customer's balance being wrong by one transaction. 16 characters minimum so a
 * caller cannot satisfy the field with "1".
 */
class MovementDto {
  @IsString()
  @Length(16, 120, {
    message:
      'idempotencyKey must be 16-120 characters — a value unique to this attempt, such as a UUID.',
  })
  idempotencyKey!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @IsOptional()
  @IsString()
  storeId?: string;
}

export class LoyaltyLookupDto {
  @IsString()
  @MaxLength(20)
  phone!: string;
}

export class LoyaltyEnrollDto {
  @IsString()
  @MaxLength(20)
  phone!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  tier?: string;

  @IsOptional()
  @IsString()
  storeId?: string;
}

export class LoyaltyEarnDto extends MovementDto {
  @IsString()
  @MaxLength(20)
  phone!: string;

  /** The bill. Points are computed from it; the caller cannot name them. */
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  @Max(100_000_000)
  amount!: number;
}

export class LoyaltyRedeemDto extends MovementDto {
  @IsString()
  @MaxLength(20)
  phone!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000_000)
  points!: number;
}

export class LoyaltyReverseDto {
  @IsString()
  @Length(16, 120)
  idempotencyKey!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  originalIdempotencyKey?: string;

  @IsOptional()
  @IsString()
  entryId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class LoyaltyProgrammeSettingsDto {
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  earnPoints?: number | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  earnPerAmount?: number | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Type(() => Number)
  @IsNumber()
  @Min(0.0001)
  redeemValuePerPoint?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  minRedeemPoints?: number;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxRedeemPointsPerTransaction?: number | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(500)
  webhookUrl?: string | null;
}

export class ManualMovementDto {
  @IsString()
  @MaxLength(20)
  phone!: string;

  @IsIn(['earn', 'redeem', 'adjustment'])
  kind!: 'earn' | 'redeem' | 'adjustment';

  /** Required for redeem and adjustment; ignored for earn. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(-10_000_000)
  @Max(10_000_000)
  points?: number;

  /** Required for earn. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  amount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;

  @IsOptional()
  @IsString()
  storeId?: string;
}

/* ----------------------------------------------------- the website's door */

/**
 * The loyalty API, as the tenant's own website sees it.
 *
 * Anonymous to the framework and authenticated in the service by the key in the
 * header. That is the same arrangement the public enquiry form and the telephony
 * webhook use, and for the same reason: there is no signed-in person here, so a
 * user guard has nothing to check. What protects these routes is an unguessable
 * key that resolves to exactly one tenant, the per-IP throttle, and the
 * organisation-status gate inside `authenticate`.
 *
 * The key goes in a HEADER, never the URL. A key in a path is a key in every
 * proxy log, browser history and Referer header between the website and here.
 */
@Public()
@RateLimit('integration')
@Controller('public/loyalty')
export class PublicLoyaltyController {
  constructor(private readonly api: LoyaltyApiService) {}

  /**
   * What the "my rewards" page needs. `enrolled: false` is a normal answer, not
   * a 404 — a website renders a join button for it.
   */
  @Get('members/:phone')
  async lookup(@Headers('x-caratos-loyalty-key') key: string, @Param('phone') phone: string) {
    const auth = await this.api.authenticate(key);
    return this.api.lookup(auth, phone);
  }

  /** The statement, and the tenant's way to catch up on missed announcements. */
  @Get('members/:phone/ledger')
  async ledger(
    @Headers('x-caratos-loyalty-key') key: string,
    @Param('phone') phone: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const auth = await this.api.authenticate(key);
    return this.api.ledger(auth, phone, {
      limit: limit ? Number(limit) : undefined,
      cursor: cursor || undefined,
    });
  }

  @Post('members')
  @HttpCode(201)
  async enroll(@Headers('x-caratos-loyalty-key') key: string, @Body() dto: LoyaltyEnrollDto) {
    const auth = await this.api.authenticate(key);
    return this.api.enroll(auth, dto);
  }

  /**
   * 200, not 201. A replayed call returns the original movement rather than
   * creating a second one, so "created" would be a lie on the retry — and the
   * retry is the case this endpoint exists to get right.
   */
  @Post('earn')
  @HttpCode(200)
  async earn(@Headers('x-caratos-loyalty-key') key: string, @Body() dto: LoyaltyEarnDto) {
    const auth = await this.api.authenticate(key);
    return this.api.earn(auth, dto);
  }

  @Post('redeem')
  @HttpCode(200)
  async redeem(@Headers('x-caratos-loyalty-key') key: string, @Body() dto: LoyaltyRedeemDto) {
    const auth = await this.api.authenticate(key);
    return this.api.redeem(auth, dto);
  }

  @Post('reverse')
  @HttpCode(200)
  async reverse(@Headers('x-caratos-loyalty-key') key: string, @Body() dto: LoyaltyReverseDto) {
    const auth = await this.api.authenticate(key);
    return this.api.reverse(auth, dto);
  }
}

/* ------------------------------------------------------ the tenant's side */

/**
 * Administering the programme, and moving points at the counter.
 *
 * Under the `/loyalty` entitlement family, which is capability-gated: the
 * programme belongs to the modules a tenant bought.
 */
@HumansOnly()
@Controller('loyalty/programme')
export class LoyaltyProgrammeController {
  constructor(private readonly api: LoyaltyApiService) {}

  @Get('settings')
  settings(@CurrentUser() user: AuthUser) {
    return this.api.settingsFor(user.organisationId);
  }

  @Roles('head_office')
  @Put('settings')
  updateSettings(@CurrentUser() user: AuthUser, @Body() dto: LoyaltyProgrammeSettingsDto) {
    return this.api.updateSettings(user, dto);
  }

  /**
   * Minting the website's key is head-office only: it hands a credential that
   * can move every member's points to a system outside CaratOS.
   */
  @Roles('head_office')
  @Post('api-key')
  @HttpCode(201)
  rotateKey(@CurrentUser() user: AuthUser) {
    return this.api.rotateApiKey(user);
  }

  @Roles('head_office')
  @Post('signing-secret')
  @HttpCode(201)
  rotateSecret(@CurrentUser() user: AuthUser) {
    return this.api.rotateSigningSecret(user);
  }

  @Get('members')
  members(
    @CurrentUser() user: AuthUser,
    @Query('q') q?: string,
    @Query('storeId') storeId?: string,
  ) {
    return this.api.members(user, { q: q || undefined, storeId: storeId || undefined });
  }

  @Get('members/:phone/ledger')
  async ledger(
    @CurrentUser() user: AuthUser,
    @Param('phone') phone: string,
    @Query('cursor') cursor?: string,
  ) {
    // The internal read goes through the same code path as the website's, with
    // the caller's own organisation instead of a key's. One ledger, one reader.
    return this.api.ledger(
      { organisationId: user.organisationId, integrationId: 'internal', config: {} },
      phone,
      { cursor: cursor || undefined },
    );
  }

  /** Earn, redeem or adjust from inside CaratOS. Audited against the person. */
  @Roles('store_manager', 'head_office')
  @Post('movements')
  @HttpCode(201)
  move(@CurrentUser() user: AuthUser, @Body() dto: ManualMovementDto) {
    return this.api.manualMovement(user, dto);
  }

  /**
   * Push the movements the website never heard about.
   *
   * Manual as well as scheduled, because the person fixing a mistyped URL wants
   * to know immediately whether it works now.
   */
  @Roles('head_office')
  @Post('announcements/retry')
  @HttpCode(200)
  retry(@CurrentUser() user: AuthUser) {
    return this.api.retryAnnouncements(user.organisationId);
  }
}
