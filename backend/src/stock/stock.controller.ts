import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { StockService } from './stock.service';
import { CreateStockDto, UpdateStockDto } from './dto/stock.dto';
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
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.stock.list(user, store, parsePagination(page, pageSize));
  }

  @Roles('store_manager', 'area_manager', 'head_office')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateStockDto) {
    return this.stock.create(user, dto);
  }

  /**
   * Adjust a stock piece: status change (store_manager+) and/or cross-store
   * transfer (area_manager+, enforced in the service when storeId differs).
   */
  @Roles('store_manager', 'area_manager', 'head_office')
  @Patch(':id')
  adjust(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateStockDto,
  ) {
    return this.stock.adjust(user, id, dto);
  }
}
