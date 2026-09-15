import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { StockTransfersService } from './stock-transfers.service';
import {
  CreateStockTransferDto,
  ListStockTransferDto,
  ReasonDto,
} from './dto/stock-transfer.dto';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { StoreHeader } from '../common/store-header.decorator';
import { Roles } from '../auth/roles.decorator';

/**
 * Module 9 — inter-store Stock Transfer.
 *
 * RBAC is declared here as a floor (RolesGuard is rank-monotonic) and tightened
 * in the service: branch operations name `store_manager` but the service still
 * rejects head_office (it has no branch); approve/reject name `head_office`
 * which only that top role satisfies. Salespeople clear no floor. Every stage
 * also re-derives the authoritative store from the record, never the request.
 */
@Controller('stock-transfers')
export class StockTransfersController {
  constructor(private readonly transfers: StockTransfersService) {}

  // Management information: store manager and above, never a salesperson.
  @Roles('store_manager')
  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @StoreHeader() store?: string,
    @Query() query?: ListStockTransferDto,
  ) {
    return this.transfers.list(user, store, query ?? {});
  }

  // Management information: store manager and above, never a salesperson.
  @Roles('store_manager')
  @Get(':id')
  detail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.transfers.detail(user, id);
  }

  @Roles('store_manager')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateStockTransferDto) {
    return this.transfers.create(user, dto);
  }

  @Roles('store_manager')
  @Post(':id/submit')
  submit(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.transfers.submit(user, id);
  }

  @Roles('head_office')
  @Post(':id/approve')
  approve(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.transfers.approve(user, id);
  }

  @Roles('head_office')
  @Post(':id/reject')
  reject(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ReasonDto) {
    return this.transfers.reject(user, id, dto);
  }

  @Roles('store_manager')
  @Post(':id/dispatch')
  dispatch(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.transfers.dispatch(user, id);
  }

  @Roles('store_manager')
  @Post(':id/receive')
  receive(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.transfers.receive(user, id);
  }

  @Roles('store_manager')
  @Post(':id/acknowledge')
  acknowledge(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.transfers.acknowledge(user, id);
  }

  @Roles('store_manager')
  @Post(':id/cancel')
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ReasonDto) {
    return this.transfers.cancel(user, id, dto);
  }
}
