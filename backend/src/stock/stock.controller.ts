import { Body, Controller, Get, Post } from '@nestjs/common';
import { StockService } from './stock.service';
import { CreateStockDto } from './dto/stock.dto';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { StoreHeader } from '../common/store-header.decorator';
import { Roles } from '../auth/roles.decorator';

@Controller('stock')
export class StockController {
  constructor(private readonly stock: StockService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.stock.list(user, store);
  }

  @Roles('store_manager', 'area_manager', 'head_office')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateStockDto) {
    return this.stock.create(user, dto);
  }
}
