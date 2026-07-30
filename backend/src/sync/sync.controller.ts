import { Body, Controller, Post } from '@nestjs/common';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { SyncService } from './sync.service';
import {
  PurgeDemoDto,
  RawSyncDto,
  SyncBatchDto,
  SyncStaffDto,
  SyncStoresDto,
} from './dto/sync.dto';

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

  /**
   * SPM_BagMaster -> ProductionBag. The shop-floor bag movements ARE the
   * manufacturing timeline; this also advances each order header to the furthest
   * stage its bags have reached.
   */
  @Post('bags')
  bags(@Body() body: SyncBatchDto) {
    return this.sync.syncBags(body.records);
  }

  /**
   * Attach catalogue/piece photo URLs. Takes URLs, not bytes — the agent uploads
   * straight from the shop PC to Cloudinary and sends only the link.
   */
  @Post('product-images')
  productImages(@Body() body: SyncBatchDto) {
    return this.sync.syncProductImages(body.records);
  }

  /** Auto-ingest Gati branches: new legacyIds become `pending` stores for HO/AM to set up. */
  @Post('stores')
  stores(@CurrentUser() user: AuthUser, @Body() body: SyncStoresDto) {
    return this.sync.syncStores(user, body.records);
  }

  /** Import the client's people as inactive, no-login users pending activation. */
  @Post('staff')
  staff(@CurrentUser() user: AuthUser, @Body() body: SyncStaffDto) {
    return this.sync.syncStaff(user, body.records);
  }

  /**
   * Remove seeded demo data once real data has arrived. Dry-run unless the body
   * carries `{"confirm":"DELETE DEMO DATA"}` — see SyncService.purgeDemo.
   */
  @Post('purge-demo')
  purgeDemo(@CurrentUser() user: AuthUser, @Body() body: PurgeDemoDto) {
    return this.sync.purgeDemo(user, body.confirm);
  }

  /** Generic full-mirror: ANY legacy table -> LegacyRow (extract-everything-once). */
  @Post('raw')
  raw(@Body() body: RawSyncDto) {
    return this.sync.syncRaw(body.table, body.records);
  }
}
