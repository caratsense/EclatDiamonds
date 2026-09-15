import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { Permit } from '../auth/permissions';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min, ValidateIf } from 'class-validator';
import type { Response } from 'express';

import { HumansOnly } from '../auth/machine.decorator';
import { Roles } from '../auth/roles.decorator';
import { AuthUser, CurrentUser } from '../common/auth-user';
import { DeadStockService, type DeadStockListOptions } from './dead-stock.service';
import { STOCK_CLASSES } from './stock-class';

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

export class ClassifyPieceDto {
  /** Null returns the piece to its design's classification. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsIn(STOCK_CLASSES)
  stockClass?: string | null;

  @IsOptional()
  @IsBoolean()
  remakeSuitable?: boolean;
}

export class ClassifyProductDto {
  @IsIn(STOCK_CLASSES)
  stockClass!: string;
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

  @Permit('inventory.read')
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

  @Permit('inventory.read')
  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('storeId') storeId?: string,
    @Query('category') category?: string,
    @Query('limit') limit?: string,
    @Query('includeWarning') includeWarning?: string,
    @Query('state') state?: string,
    @Query('view') view?: string,
  ) {
    return this.dead.list(user, listOptions({ storeId, category, limit, includeWarning, state, view }));
  }

  /**
   * The same list as a workbook, classification included. Manager-level, like
   * every other export: a file of tag prices leaves the system.
   */
  @Roles('store_manager', 'head_office')
  @Get('export.xlsx')
  @Header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  async export(
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
    @Query('storeId') storeId?: string,
    @Query('category') category?: string,
    @Query('includeWarning') includeWarning?: string,
    @Query('state') state?: string,
    @Query('view') view?: string,
  ): Promise<StreamableFile> {
    const out = await this.dead.exportWorkbook(
      user,
      listOptions({ storeId, category, includeWarning, state, view }),
    );
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.setHeader('X-Export-Rows', String(out.rows));
    return new StreamableFile(out.buffer);
  }

  /** Classify one piece, or mark it worth remaking. Store-scoped. */
  @Roles('store_manager', 'head_office')
  @Patch('classification/piece/:stockItemId')
  classifyPiece(
    @CurrentUser() user: AuthUser,
    @Param('stockItemId') stockItemId: string,
    @Body() dto: ClassifyPieceDto,
  ) {
    return this.dead.classifyPiece(user, stockItemId, dto);
  }

  /** Classify a design — every piece without its own classification follows. */
  @Roles('head_office')
  @Patch('classification/product/:productId')
  classifyProduct(
    @CurrentUser() user: AuthUser,
    @Param('productId') productId: string,
    @Body() dto: ClassifyProductDto,
  ) {
    return this.dead.classifyProduct(user, productId, dto.stockClass);
  }
}

function listOptions(q: {
  storeId?: string;
  category?: string;
  limit?: string;
  includeWarning?: string;
  state?: string;
  view?: string;
}): DeadStockListOptions {
  return {
    storeId: q.storeId || undefined,
    category: q.category || undefined,
    limit: q.limit ? Number(q.limit) : undefined,
    includeWarning: q.includeWarning === 'true' || q.includeWarning === '1',
    // Validated in the service against the closed lists, so a typo is a 400
    // naming the choices rather than a silently empty screen.
    state: (q.state || undefined) as DeadStockListOptions['state'],
    view: (q.view || undefined) as DeadStockListOptions['view'],
  };
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

  @Permit('inventory.read')
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
