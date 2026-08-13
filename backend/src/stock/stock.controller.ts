import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { StockService } from './stock.service';
import {
  BulkAdjustStockDto,
  BulkImportStockDto,
  CreateStockDto,
  ListStockDto,
  UpdateStockDto,
} from './dto/stock.dto';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { StoreHeader } from '../common/store-header.decorator';
import { parsePagination } from '../common/pagination';
import { Roles } from '../auth/roles.decorator';

@Controller('stock')
export class StockController {
  constructor(private readonly stock: StockService) {}

  /**
   * List stock items. Without `page`/`pageSize` returns the plain array
   * (legacy shape); with either param returns { items, total, page, pageSize }.
   */
  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @StoreHeader() store?: string,
    @Query() query?: ListStockDto,
  ) {
    const { page, pageSize, ...filters } = query ?? {};
    return this.stock.list(user, store, parsePagination(page, pageSize), filters);
  }

  /**
   * Store-scoped aging distribution + dead-stock count over the whole set,
   * so the aging chart and the dead-stock KPI stay consistent (not per-page).
   */
  @Get('summary')
  summary(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.stock.summary(user, store);
  }

  @Roles('store_manager', 'head_office')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateStockDto) {
    return this.stock.create(user, dto);
  }

  /**
   * "Adjust status" for many pieces at once (store_manager+). Transactional and
   * scope-checked; refuses any piece locked by a live transfer.
   */
  @Roles('store_manager', 'head_office')
  @Post('bulk-adjust')
  bulkAdjust(@CurrentUser() user: AuthUser, @Body() dto: BulkAdjustStockDto) {
    return this.stock.bulkAdjust(user, dto);
  }

  /**
   * Bulk-import parsed spreadsheet rows into one concrete store (store_manager+).
   * All-or-nothing with a row-level error report; import only ever creates.
   */
  @Roles('store_manager', 'head_office')
  @Post('bulk-import')
  bulkImport(@CurrentUser() user: AuthUser, @Body() dto: BulkImportStockDto) {
    return this.stock.bulkImport(user, dto);
  }

  /**
   * "Adjust status" for one piece (store_manager+). A mandatory reason drives the
   * new status; cross-store moves go through the Stock Transfer workflow instead.
   */
  @Roles('store_manager', 'head_office')
  @Patch(':id')
  adjust(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateStockDto,
  ) {
    return this.stock.adjust(user, id, dto);
  }
}
