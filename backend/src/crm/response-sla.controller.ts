import { Body, Controller, Get, Post, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

import { HumansOnly } from '../auth/machine.decorator';
import { Roles } from '../auth/roles.decorator';
import { AuthUser, CurrentUser } from '../common/auth-user';
import { ResponseSlaService } from './response-sla.service';

export class ResponseSlaSettingsDto {
  /**
   * Minutes allowed for the first genuine reply. `null` switches the SLA off,
   * which is the default — no clocks are opened and nothing changes for a tenant
   * who has not chosen a number. Éclat's number is 5.
   */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1440)
  firstResponseMinutes?: number | null;

  /** Minutes from the customer's message at which a manager is told. `null` = never. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1440)
  escalateAfterMinutes?: number | null;

  @IsOptional()
  @IsBoolean()
  autoCallOnBreach?: boolean;
}

export class ResponseSlaQueryDto {
  @IsOptional()
  storeId?: string;

  @IsOptional()
  @IsIn(['waiting', 'met', 'breached'])
  status?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  days?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

/**
 * The first-response promise: what it is, and who is not keeping it.
 *
 * Covered by the `/crm` entitlement entry — answering a customer quickly is not
 * a vertical feature, and every industry pack that has conversations has this.
 */
@HumansOnly()
@Controller('crm/sla')
export class ResponseSlaController {
  constructor(private readonly sla: ResponseSlaService) {}

  @Get('settings')
  settings(@CurrentUser() user: AuthUser) {
    return this.sla.settingsFor(user.organisationId);
  }

  /** Head office only: the promise is a company decision, not a branch one. */
  @Roles('head_office')
  @Put('settings')
  save(@CurrentUser() user: AuthUser, @Body() dto: ResponseSlaSettingsDto) {
    return this.sla.saveSettings(user, dto);
  }

  @Get('summary')
  summary(@CurrentUser() user: AuthUser, @Query() query: ResponseSlaQueryDto) {
    return this.sla.summary(user, { storeId: query.storeId, days: query.days });
  }

  @Get('clocks')
  clocks(@CurrentUser() user: AuthUser, @Query() query: ResponseSlaQueryDto) {
    return this.sla.list(user, query);
  }

  /**
   * Settle everything owed right now, for whoever asks.
   *
   * The scheduler runs this every minute; the endpoint exists so a manager can
   * see the state of their own floor without waiting for a tick, and so the
   * behaviour is testable without a clock. Deliberately restricted: it is the
   * act that sends alerts.
   */
  @Roles('store_manager', 'head_office')
  @Post('sweep')
  sweep(@CurrentUser() user: AuthUser) {
    // Scoped to the caller's tenant. The scheduler sweeps everybody; a person
    // pressing a button must not fire another organisation's alerts.
    return this.sla.sweep(new Date(), { organisationId: user.organisationId });
  }
}
