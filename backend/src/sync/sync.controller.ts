import { Body, Controller, Post } from '@nestjs/common';
import { Roles } from '../auth/roles.decorator';
import { HumansOnly, OrganisationWideMachineOnly } from '../auth/machine.decorator';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { SyncService } from './sync.service';
import { RateLimit } from '../common/rate-limit';
import { PurgeDemoDto, RawSyncDto, SyncBatchDto, SyncStaffDto, SyncStoresDto } from './dto/sync.dto';
import { CurrentGatiIngestion, GatiIngestion, GatiIngestionContext } from './gati-ingestion.guard';

/**
 * Legacy-sync ingestion (the on-site sync_sjep.py agent's production sink).
 *
 * Per-entity bulk-upsert routes keyed on `legacyId`, pushed in dependency order:
 * parties -> products -> stock -> sales -> sale-lines -> orders -> order-items,
 * with the agent advancing its watermark to the max returned here.
 *
 * AUTHENTICATION. Ingestion is machine-token-only. Every request must also
 * present the exact profile hash, source descriptor hash and server config
 * revision approved for that agent. The source descriptor is atomically pinned
 * before the first domain write.
 *
 * The four destructive routes at the bottom are `@HumansOnly()`. They were
 * reachable by the sync account, which means a credential in a config file on a
 * shop-floor PC could purge the tenant. A person has to make that call.
 */
@Roles('head_office')
@OrganisationWideMachineOnly()
// Bulk ingestion from the on-site agent: machine-paced by definition.
@RateLimit('integration')
@Controller('sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @GatiIngestion()
  @Post('parties')
  parties(
    @CurrentUser() user: AuthUser,
    @CurrentGatiIngestion() generation: GatiIngestionContext,
    @Body() body: SyncBatchDto,
  ) {
    return this.sync.runGatiIngestion(user, generation, 'parties', body.records.length, () =>
      this.sync.syncParties(user.organisationId, body.records),
    );
  }

  @GatiIngestion()
  @Post('products')
  products(
    @CurrentUser() user: AuthUser,
    @CurrentGatiIngestion() generation: GatiIngestionContext,
    @Body() body: SyncBatchDto,
  ) {
    return this.sync.runGatiIngestion(user, generation, 'products', body.records.length, () =>
      this.sync.syncProducts(user.organisationId, body.records),
    );
  }

  @GatiIngestion()
  @Post('stock')
  stock(
    @CurrentUser() user: AuthUser,
    @CurrentGatiIngestion() generation: GatiIngestionContext,
    @Body() body: SyncBatchDto,
  ) {
    return this.sync.runGatiIngestion(user, generation, 'stock', body.records.length, () =>
      this.sync.syncStock(user.organisationId, body.records),
    );
  }

  @GatiIngestion()
  @Post('sales')
  sales(
    @CurrentUser() user: AuthUser,
    @CurrentGatiIngestion() generation: GatiIngestionContext,
    @Body() body: SyncBatchDto,
  ) {
    return this.sync.runGatiIngestion(user, generation, 'sales', body.records.length, () =>
      this.sync.syncSales(user.organisationId, body.records),
    );
  }

  @GatiIngestion()
  @Post('sale-lines')
  saleLines(
    @CurrentUser() user: AuthUser,
    @CurrentGatiIngestion() generation: GatiIngestionContext,
    @Body() body: SyncBatchDto,
  ) {
    return this.sync.runGatiIngestion(user, generation, 'sale-lines', body.records.length, () =>
      this.sync.syncSaleLines(user.organisationId, body.records),
    );
  }

  @GatiIngestion()
  @Post('orders')
  orders(
    @CurrentUser() user: AuthUser,
    @CurrentGatiIngestion() generation: GatiIngestionContext,
    @Body() body: SyncBatchDto,
  ) {
    return this.sync.runGatiIngestion(user, generation, 'orders', body.records.length, () =>
      this.sync.syncOrders(user.organisationId, body.records),
    );
  }

  @GatiIngestion()
  @Post('order-items')
  orderItems(
    @CurrentUser() user: AuthUser,
    @CurrentGatiIngestion() generation: GatiIngestionContext,
    @Body() body: SyncBatchDto,
  ) {
    return this.sync.runGatiIngestion(user, generation, 'order-items', body.records.length, () =>
      this.sync.syncOrderItems(user.organisationId, body.records),
    );
  }

  /**
   * SPM_BagMaster -> ProductionBag. The shop-floor bag movements ARE the
   * manufacturing timeline; this also advances each order header to the furthest
   * stage its bags have reached.
   */
  @GatiIngestion()
  @Post('bags')
  bags(
    @CurrentUser() user: AuthUser,
    @CurrentGatiIngestion() generation: GatiIngestionContext,
    @Body() body: SyncBatchDto,
  ) {
    return this.sync.runGatiIngestion(user, generation, 'bags', body.records.length, () =>
      this.sync.syncBags(user.organisationId, body.records),
    );
  }

  /**
   * Attach catalogue/piece photo URLs. Takes URLs, not bytes — the agent uploads
   * straight from the shop PC to Cloudinary and sends only the link.
   */
  @GatiIngestion()
  @Post('product-images')
  productImages(
    @CurrentUser() user: AuthUser,
    @CurrentGatiIngestion() generation: GatiIngestionContext,
    @Body() body: SyncBatchDto,
  ) {
    return this.sync.runGatiIngestion(user, generation, 'product-images', body.records.length, () =>
      this.sync.syncProductImages(user.organisationId, body.records),
    );
  }

  /**
   * The shop's day book (Journal) -> LedgerEntry. Extracted by the agent since
   * the first version and thrown away for want of somewhere to send it, which
   * is why Finance has been empty. Deliberately NOT Payment: Journal is
   * double-entry accounting including GST postings, not customer collections.
   */
  @GatiIngestion()
  @Post('ledger')
  ledger(
    @CurrentUser() user: AuthUser,
    @CurrentGatiIngestion() generation: GatiIngestionContext,
    @Body() body: SyncBatchDto,
  ) {
    return this.sync.runGatiIngestion(user, generation, 'ledger', body.records.length, () =>
      this.sync.syncLedger(user.organisationId, body.records),
    );
  }

  /** Per-piece movement history (InwardHistory) -> StockMovement. */
  @GatiIngestion()
  @Post('stock-movements')
  stockMovements(
    @CurrentUser() user: AuthUser,
    @CurrentGatiIngestion() generation: GatiIngestionContext,
    @Body() body: SyncBatchDto,
  ) {
    return this.sync.runGatiIngestion(user, generation, 'stock-movements', body.records.length, () =>
      this.sync.syncStockMovements(user.organisationId, body.records),
    );
  }

  /**
   * Designs from the client's own website. Brings the two things the shop system
   * cannot: a clean customer-facing photograph (Gati's library has measurements
   * printed across the pictures) and a price for designs no branch stocks.
   * Matched designs are only enriched; unmatched ones are created made-to-order.
   */
  @GatiIngestion()
  @Post('website-products')
  websiteProducts(
    @CurrentUser() user: AuthUser,
    @CurrentGatiIngestion() generation: GatiIngestionContext,
    @Body() body: SyncBatchDto,
  ) {
    return this.sync.runGatiIngestion(user, generation, 'website-products', body.records.length, () =>
      this.sync.syncWebsiteProducts(user.organisationId, body.records),
    );
  }

  /** Auto-ingest Gati branches: new legacyIds become `pending` stores for HO/AM to set up. */
  @GatiIngestion()
  @Post('stores')
  stores(
    @CurrentUser() user: AuthUser,
    @CurrentGatiIngestion() generation: GatiIngestionContext,
    @Body() body: SyncStoresDto,
  ) {
    return this.sync.runGatiIngestion(user, generation, 'stores', body.records.length, () =>
      this.sync.syncStores(user, body.records),
    );
  }

  /** Import the client's people as inactive, no-login users pending activation. */
  @GatiIngestion()
  @Post('staff')
  staff(
    @CurrentUser() user: AuthUser,
    @CurrentGatiIngestion() generation: GatiIngestionContext,
    @Body() body: SyncStaffDto,
  ) {
    return this.sync.runGatiIngestion(user, generation, 'staff', body.records.length, () =>
      this.sync.syncStaff(user, body.records),
    );
  }

  /**
   * Remove seeded demo data once real data has arrived. Dry-run unless the body
   * carries `{"confirm":"DELETE DEMO DATA"}` — see SyncService.purgeDemo.
   */
  @HumansOnly()
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
  @HumansOnly()
  @Post('reset')
  reset(@CurrentUser() user: AuthUser, @Body() body: PurgeDemoDto) {
    return this.sync.resetSyncedData(user, body.confirm);
  }

  /**
   * Remove imported branches that hold no data and were never activated — the
   * suppliers and holding companies a location flag wrongly identified as shops.
   * Dry-run unless the body carries `{"confirm":"DELETE EMPTY BRANCHES"}`.
   */
  @HumansOnly()
  @Post('prune-stores')
  pruneStores(@CurrentUser() user: AuthUser, @Body() body: PurgeDemoDto) {
    return this.sync.pruneEmptyStores(user, body.confirm);
  }

  /**
   * Clean slate for go-live: delete every account except head office (everyone
   * else then self-signs-up and is approved). Dry-run unless the body carries
   * `{"confirm":"DELETE ALL USERS EXCEPT HEAD OFFICE"}`. Atomic — see
   * SyncService.resetToHeadOffice.
   */
  @HumansOnly()
  @Post('reset-users')
  resetUsers(@CurrentUser() user: AuthUser, @Body() body: PurgeDemoDto) {
    return this.sync.resetToHeadOffice(user, body.confirm);
  }

  /** Generic full-mirror: ANY legacy table -> LegacyRow (extract-everything-once). */
  @GatiIngestion()
  @Post('raw')
  raw(
    @CurrentUser() user: AuthUser,
    @CurrentGatiIngestion() generation: GatiIngestionContext,
    @Body() body: RawSyncDto,
  ) {
    return this.sync.runGatiIngestion(
      user,
      generation,
      'raw',
      body.records.length,
      () => this.sync.syncRaw(user.organisationId, body.table, body.records),
      body.table,
    );
  }
}
