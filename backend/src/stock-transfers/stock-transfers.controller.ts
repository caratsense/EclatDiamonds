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
 * in the service: raising a request (create/submit) is open to branch STAFF
 * (client, 9 Oct: staff must be able to initiate, not only administrators), but
 * the service still rejects head_office there (it has no branch). Fulfilment
 * (dispatch/receive/acknowledge/cancel) stays `store_manager`; approve/reject
 * name `head_office`, which only that top role satisfies. Every stage also
 * re-derives the authoritative store from the record, never the request. The
 * ModuleAccessGuard runs first, so only roles holding the `stock-transfers`
 * screen (auth/access.ts) reach these floors at all.
 */
@Controller('stock-transfers')
export class StockTransfersController {
  constructor(private readonly transfers: StockTransfersService) {}

  // Open to branch staff: a salesperson who raised a request must be able to
  // see where it stands. The service scopes rows to the caller's stores.
  @Roles('salesperson')
  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @StoreHeader() store?: string,
    @Query() query?: ListStockTransferDto,
  ) {
    return this.transfers.list(user, store, query ?? {});
  }

  // Same visibility as the list: either side of the transfer, or head office.
  @Roles('salesperson')
  @Get(':id')
  detail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.transfers.detail(user, id);
  }

  // Branch staff raise the request; the piece scope and source-store checks
  // stay in the service exactly as for a manager.
  @Roles('salesperson')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateStockTransferDto) {
    return this.transfers.create(user, dto);
  }

  // Submitting is part of raising (a draft nobody can submit never reaches HO).
  @Roles('salesperson')
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
