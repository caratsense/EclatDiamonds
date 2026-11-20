import { Body, Controller, Get, Param, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min, ValidateIf } from 'class-validator';

import { HumansOnly } from '../auth/machine.decorator';
import { Permit } from '../auth/permissions';
import { Roles } from '../auth/roles.decorator';
import { AuthUser, CurrentUser } from '../common/auth-user';
import { StoreHeader } from '../common/store-header.decorator';
import { LowStockService } from './low-stock.service';

export class LowStockSettingsDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(999)
  defaultLevel!: number;
}

export class ReorderLevelDto {
  /** Null returns the design to the tenant's default. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(999)
  level?: number | null;
}

/**
 * Designs a branch has run short of, and the level that decides it.
 *
 * Under `/stock` with the rest of inventory, so the entitlement guard's
 * longest-prefix match gives it the same `inventory` capability — a tenant
 * without a shelf has no use for a reorder level.
 */
@HumansOnly()
@Controller('stock/low-stock')
export class LowStockController {
  constructor(private readonly lowStock: LowStockService) {}

  /** What is below its level now, for the branch in the header (or all in scope). */
  @Permit('inventory.read')
  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @StoreHeader() store?: string,
    @Query('limit') limit?: string,
  ) {
    return this.lowStock.list(user, { storeId: store, limit: limit ? Number(limit) : undefined });
  }

  @Permit('inventory.read')
  @Get('settings')
  settings(@CurrentUser() user: AuthUser) {
    return this.lowStock.settings(user.organisationId);
  }

  /**
   * Head office decides, as it does for the dead-stock threshold: this number
   * changes what every branch's list means, so it is not one branch's call.
   */
  @Roles('head_office')
  @Put('settings')
  saveSettings(@CurrentUser() user: AuthUser, @Body() dto: LowStockSettingsDto) {
    return this.lowStock.saveSettings(user, dto);
  }

  /** One design's own level — it applies at every branch, so also head office. */
  @Roles('head_office')
  @Put('level/:productId')
  setLevel(
    @CurrentUser() user: AuthUser,
    @Param('productId') productId: string,
    @Body() dto: ReorderLevelDto,
  ) {
    return this.lowStock.setLevel(user, productId, dto.level ?? null);
  }
}
