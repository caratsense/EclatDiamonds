import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min, ValidateIf } from 'class-validator';

import { HumansOnly } from '../auth/machine.decorator';
import { Roles } from '../auth/roles.decorator';
import { AuthUser, CurrentUser } from '../common/auth-user';
import { DeadStockService } from './dead-stock.service';

export class DeadStockRuleDto {
  /** Omitted or 'default' sets the tenant-wide rule. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  category?: string | null;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  thresholdDays!: number;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  warnAfterDays?: number | null;
}

/**
 * When a piece counts as dead, and which pieces have crossed the line.
 *
 * Under the `/stock` capability: dead stock is a merchandising question and a
 * tenant without inventory has no use for it. A separate prefix from `/stock`
 * only because `StockController` owns the root routes — the entitlement entry is
 * the same one, by longest-prefix match on `/stock`.
 */
@HumansOnly()
@Controller('stock/dead')
export class DeadStockController {
  constructor(private readonly dead: DeadStockService) {}

  @Get('policy')
  policy(@CurrentUser() user: AuthUser) {
    return this.dead.policyFor(user.organisationId);
  }

  /** Head office decides: the threshold changes what every branch's figure means. */
  @Roles('head_office')
  @Put('policy')
  setPolicy(@CurrentUser() user: AuthUser, @Body() dto: DeadStockRuleDto) {
    return this.dead.setRule(user, dto);
  }

  @Roles('head_office')
  @Delete('policy/:category')
  clearPolicy(@CurrentUser() user: AuthUser, @Param('category') category: string) {
    return this.dead.clearRule(user, category);
  }

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('storeId') storeId?: string,
    @Query('category') category?: string,
    @Query('limit') limit?: string,
    @Query('includeWarning') includeWarning?: string,
  ) {
    return this.dead.list(user, {
      storeId: storeId || undefined,
      category: category || undefined,
      limit: limit ? Number(limit) : undefined,
      includeWarning: includeWarning === 'true' || includeWarning === '1',
    });
  }
}

/**
 * The piece's own identifier.
 *
 * Read is open to anyone who can see stock — somebody on the floor holding a tag
 * needs to know what they are holding. Issuing is manager-level: it is the act
 * that decides what gets printed.
 */
@HumansOnly()
@Controller('stock/vin')
export class StockVinController {
  constructor(private readonly dead: DeadStockService) {}

  @Get(':vin')
  lookup(@CurrentUser() user: AuthUser, @Param('vin') vin: string) {
    return this.dead.lookup(user, vin);
  }

  @Roles('store_manager', 'head_office')
  @Post('issue/:stockItemId')
  issue(@CurrentUser() user: AuthUser, @Param('stockItemId') stockItemId: string) {
    return this.dead.issue(user, stockItemId);
  }

  /** Every piece in scope that has none. Bounded, and says how many are left. */
  @Roles('store_manager', 'head_office')
  @Post('issue-missing')
  issueMissing(
    @CurrentUser() user: AuthUser,
    @Body('storeId') storeId?: string,
    @Body('limit') limit?: number,
  ) {
    return this.dead.issueMissing(user, {
      storeId: storeId || undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }
}
