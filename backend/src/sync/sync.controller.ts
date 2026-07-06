import { Body, Controller, Post } from '@nestjs/common';
import { Roles } from '../auth/roles.decorator';
import { SyncService } from './sync.service';
import { RawSyncDto, SyncBatchDto } from './dto/sync.dto';

/**
 * Legacy-sync ingestion (the on-site sync_sjep.py agent's production sink).
 *
 * Per-entity bulk-upsert routes keyed on `legacyId`. The agent authenticates as a
 * dedicated head_office service account (POST /auth/login) and pushes entities in
 * dependency order: parties -> products -> stock -> sales -> sale-lines ->
 * orders -> order-items, then advances its watermark to the max returned here.
 * Gated to head_office so only the sync account (not store staff) can bulk-write.
 */
@Roles('head_office')
@Controller('sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Post('parties')
  parties(@Body() body: SyncBatchDto) {
    return this.sync.syncParties(body.records);
  }

  @Post('products')
  products(@Body() body: SyncBatchDto) {
    return this.sync.syncProducts(body.records);
  }

  @Post('stock')
  stock(@Body() body: SyncBatchDto) {
    return this.sync.syncStock(body.records);
  }

  @Post('sales')
  sales(@Body() body: SyncBatchDto) {
    return this.sync.syncSales(body.records);
  }

  @Post('sale-lines')
  saleLines(@Body() body: SyncBatchDto) {
    return this.sync.syncSaleLines(body.records);
  }

  @Post('orders')
  orders(@Body() body: SyncBatchDto) {
    return this.sync.syncOrders(body.records);
  }

  @Post('order-items')
  orderItems(@Body() body: SyncBatchDto) {
    return this.sync.syncOrderItems(body.records);
  }

  /** Generic full-mirror: ANY legacy table -> LegacyRow (extract-everything-once). */
  @Post('raw')
  raw(@Body() body: RawSyncDto) {
    return this.sync.syncRaw(body.table, body.records);
  }
}
