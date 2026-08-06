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

  /**
   * The shop's day book (Journal) -> LedgerEntry. Extracted by the agent since
   * the first version and thrown away for want of somewhere to send it, which
   * is why Finance has been empty. Deliberately NOT Payment: Journal is
   * double-entry accounting including GST postings, not customer collections.
   */
  @Post('ledger')
  ledger(@Body() body: SyncBatchDto) {
    return this.sync.syncLedger(body.records);
  }

  /** Per-piece movement history (InwardHistory) -> StockMovement. */
  @Post('stock-movements')
  stockMovements(@Body() body: SyncBatchDto) {
    return this.sync.syncStockMovements(body.records);
  }

  /**
   * Designs from the client's own website. Brings the two things the shop system
   * cannot: a clean customer-facing photograph (Gati's library has measurements
   * printed across the pictures) and a price for designs no branch stocks.
   * Matched designs are only enriched; unmatched ones are created made-to-order.
   */
  @Post('website-products')
  websiteProducts(@Body() body: SyncBatchDto) {
    return this.sync.syncWebsiteProducts(body.records);
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

  /**
   * Throw away everything the sync has imported so the next run rebuilds it.
   * Dry-run unless the body carries `{"confirm":"DELETE SYNCED DATA"}`.
   *
   * The repair for a mapping bug: the agent is incremental, so rows already
   * imported under a wrong rule are never re-sent and stay wrong. Demo data and
   * stores are left alone — see SyncService.resetSyncedData.
   */
  @Post('reset')
  reset(@CurrentUser() user: AuthUser, @Body() body: PurgeDemoDto) {
    return this.sync.resetSyncedData(user, body.confirm);
  }

  /**
   * Remove imported branches that hold no data and were never activated — the
   * suppliers and holding companies a location flag wrongly identified as shops.
   * Dry-run unless the body carries `{"confirm":"DELETE EMPTY BRANCHES"}`.
   */
  @Post('prune-stores')
  pruneStores(@CurrentUser() user: AuthUser, @Body() body: PurgeDemoDto) {
    return this.sync.pruneEmptyStores(user, body.confirm);
  }

  /** Generic full-mirror: ANY legacy table -> LegacyRow (extract-everything-once). */
  @Post('raw')
  raw(@Body() body: RawSyncDto) {
    return this.sync.syncRaw(body.table, body.records);
  }
}
