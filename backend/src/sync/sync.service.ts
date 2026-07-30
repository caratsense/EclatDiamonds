import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { AuditService } from '../common/audit.service';
import { StoreSyncRowDto } from './dto/sync.dto';
import {
  bool,
  dec,
  docTypeFromTranType,
  dt,
  int,
  karatFromMetal,
  maxWatermark,
  metalFromTone,
  str,
  stockStatusFromInward,
} from './sync.util';

export interface SyncResult {
  entity: string;
  received: number;
  upserted: number;
  skipped: number;
  /** Highest legacy UpdateDate/EntryDate in this batch (the agent's next watermark). */
  watermark: string | null;
}

type Rec = Record<string, any>;

/**
 * Production order of the OrderStatus enum, used to decide whether a bag
 * movement moves an order FORWARD. Rework sends a bag back to an earlier
 * department all the time; that must not un-finish an order that is further on.
 * `cancelled` is deliberately -1 so it never wins a "furthest stage" comparison.
 */
const STAGE_RANK: Record<string, number> = {
  booked: 0,
  designing: 1,
  casting: 2,
  stone_setting: 3,
  polishing: 4,
  qc: 5,
  ready: 6,
  delivered: 7,
  cancelled: -1,
};

/**
 * Live legacy-sync sink (the production target the on-site sync_sjep.py agent
 * pushes to). Each method bulk-upserts one entity on its unique `legacyId`, using
 * the SAME mapping as the one-time backfill — so live sync and backfill converge
 * on identical Eclat rows. Idempotent: re-sending a record refreshes it, never
 * duplicates. Foreign keys (sale/order/stock) are resolved by looking up rows
 * already synced in an earlier entity (the agent pushes in dependency order).
 */
@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Single-branch legacy install -> one Eclat store (override via SYNC_DEFAULT_STORE_ID).
   * NOTE: the single-defaultStoreId path below is intentionally kept AS-IS so existing
   * single-branch installs keep working. Multi-store installs will instead stamp each
   * transaction row's store via `resolveStoreByLegacyId(LocationId)` — the next step is
   * threading the Gati LocationId onto each synced transaction row so per-row location
   * stamping can replace this default.
   */
  private get defaultStoreId(): string {
    return this.config.get<string>('SYNC_DEFAULT_STORE_ID') ?? 'surat-main';
  }

  private async assertStore(): Promise<string> {
    const id = this.defaultStoreId;
    const store = await this.prisma.store.findUnique({ where: { id } });
    if (!store) {
      throw new BadRequestException(
        `Sync target store '${id}' not found — seed it or set SYNC_DEFAULT_STORE_ID.`,
      );
    }
    return id;
  }

  /**
   * Map a Gati branch/location legacyId -> Eclat Store id (or null if unmapped).
   * For future per-row location stamping of transaction rows.
   */
  async resolveStoreByLegacyId(legacyId: string | number | null | undefined): Promise<string | null> {
    if (legacyId == null) return null;
    const store = await this.prisma.store.findUnique({
      where: { legacyId: String(legacyId) },
      select: { id: true },
    });
    return store?.id ?? null;
  }

  // ── Gati branches -> Store (auto-detect new branches) ────────────────────────
  /**
   * Upsert Gati branches on `legacyId`. New branches are created `pending`
   * (isActive=false, no geo/region — HO/AM fills those on activation). Known
   * branches only refresh name/city/code; their status, geo, region and manager
   * are never touched, so an activated store can't be reverted by a re-sync.
   */
  async syncStores(user: AuthUser, records: StoreSyncRowDto[]) {
    const created: { id: string; legacyId: string; name: string }[] = [];
    const updated: { id: string; legacyId: string; name: string }[] = [];

    for (const r of records) {
      const legacyId = String(r.legacyId);
      const existing = await this.prisma.store.findUnique({
        where: { legacyId },
        select: { id: true },
      });

      if (existing) {
        const store = await this.prisma.store.update({
          where: { legacyId },
          data: { name: r.name, city: r.city ?? undefined, code: r.code ?? undefined },
          select: { id: true, name: true },
        });
        updated.push({ id: store.id, legacyId, name: store.name });
      } else {
        const store = await this.prisma.store.create({
          data: {
            legacyId,
            name: r.name,
            city: r.city ?? '',
            code: r.code ?? null,
            status: 'pending',
            isActive: false,
          },
          select: { id: true, name: true },
        });
        created.push({ id: store.id, legacyId, name: store.name });
        await this.audit.record(user, {
          action: 'store.auto_detected',
          entityType: 'store',
          entityId: store.id,
          storeId: store.id,
          summary: `Auto-detected branch ${store.name} from Gati`,
          metadata: { legacyId, city: r.city ?? null, code: r.code ?? null },
        });
      }
    }

    const pendingCount = await this.prisma.store.count({
      where: { status: 'pending', isAggregate: false },
    });
    this.logger.log(
      `sync stores: received=${records.length} created=${created.length} updated=${updated.length} pending=${pendingCount}`,
    );
    return { created, updated, pendingCount };
  }

  // ── PartyMst -> Party ────────────────────────────────────────────────────────
  async syncParties(records: Rec[]): Promise<SyncResult> {
    const storeId = await this.assertStore();
    let upserted = 0;
    let skipped = 0;
    for (const r of records) {
      if (r.PartyNo == null) {
        skipped++;
        continue;
      }
      const types: string[] = [];
      if (bool(r.IsCustomer)) types.push('customer');
      if (bool(r.IsSupplier)) types.push('supplier');
      if (bool(r.IsSalesMan)) types.push('salesperson');
      if (bool(r.IsLocation) || bool(r.IsFactory)) types.push('branch');
      if (bool(r.IsAccount)) types.push('account');

      const data = {
        storeId,
        name: str(r.FirmName) || str(r.LegalName) || str(r.PartyCode) || String(r.PartyNo),
        legalName: str(r.LegalName),
        code: str(r.PartyCode),
        types: types as any,
        phone: str(r.FirmTele) || str(r.OwnerMobile),
        whatsapp: str(r.WhatsAppNo),
        email: str(r.FirmEmail),
        addressLine1: str(r.FirmAdd1),
        addressLine2: str(r.FirmAdd2),
        city: str(r.FirmCity),
        state: str(r.FirmState),
        country: str(r.FirmCountry) || 'India',
        pincode: str(r.FirmPinCode),
        gstin: str(r.AccGst),
        pan: str(r.FirmPan),
        aadhaar: str(r.AadhaarNo),
        birthday: dt(r.FirmBirthDate),
        anniversary: dt(r.FirmAnniversaryDate),
        creditLimit: dec(r.CreditLimit),
        isBlacklisted: bool(r.IsBlackList),
        legacyUpdatedAt: dt(r.UpdateDate),
      };
      const legacyId = String(r.PartyNo);
      await this.prisma.party.upsert({
        where: { legacyId },
        create: { legacyId, ...data },
        update: data,
      });
      upserted++;
    }
    return this.result('parties', records, upserted, skipped);
  }

  // ── StyleMst (+Summary) -> Product ───────────────────────────────────────────
  async syncProducts(records: Rec[]): Promise<SyncResult> {
    const storeId = await this.assertStore();
    let upserted = 0;
    let skipped = 0;
    for (const r of records) {
      if (r.StyleId == null) {
        skipped++;
        continue;
      }
      const metal = metalFromTone(r.ToneFor, r.ToneCode);
      const sku = str(r.StyleSKUNo) || str(r.StyleCode) || `STYLE-${r.StyleId}`;
      const data = {
        storeId,
        sku,
        name: str(r.StyleCode) || sku,
        metal: metal as any,
        karat: karatFromMetal(metal),
        weightGrams: dec(r.GrossWt ?? r.ModelWt) ?? '0',
        caratWeight: dec(r.TotDiaWt) ?? '0',
        price: dec(r.MRP ?? r.TagPrice ?? r.EndClientPrice) ?? '0',
        description: str(r.WebDescription),
        bestSeller: bool(r.BestSeller),
      };
      const legacyId = String(r.StyleId);
      await this.prisma.product.upsert({
        where: { legacyId },
        create: { legacyId, ...data },
        update: data,
      });
      upserted++;
    }
    return this.result('products', records, upserted, skipped);
  }

  // ── Inward (+Summary) -> StockItem ───────────────────────────────────────────
  async syncStock(records: Rec[]): Promise<SyncResult> {
    const storeId = await this.assertStore();
    const productByStyle = await this.idMap(
      'product',
      records.map((r) => r.StyleId),
    );
    let upserted = 0;
    let skipped = 0;
    for (const r of records) {
      if (r.JewelId == null) {
        skipped++;
        continue;
      }
      const metal = metalFromTone(r.ToneFor, r.ToneCode);
      const data = {
        storeId,
        productId: productByStyle.get(String(r.StyleId)) ?? null,
        sku: str(r.InwardSKUNo) || str(r.JewelCode),
        name: str(r.JewelCode),
        metal: metal as any,
        karat: karatFromMetal(metal),
        status: stockStatusFromInward(r) as any,
        grossWeight: dec(r.GrossWt),
        netWeight: dec(r.NetWt),
        pureWeight: dec(r.PureWt),
        metalLossWeight: dec(r.MetalLossWt),
        diamondWeightCt: dec(r.TotDiaWt),
        diamondPieces: int(r.TotDiaPc),
        stoneWeightCt: dec(r.TotCZWt),
        metalAmount: dec(r.TotMtlAmt),
        diamondAmount: dec(r.TotDiaAmt),
        stoneAmount: dec(r.TotCZAmt),
        makingAmount: dec(r.TotHandlingAmt),
        cpfAmount: dec(r.TotCPFAmt),
        cost: dec(r.COST),
        mrp: dec(r.MRP),
        tagPrice: dec(r.TagPrice),
        hallmarkNo: str(r.HallMarkId),
        certificateNo: str(r.Jewelry_CertificateNo),
        inwardDate: dt(r.InwardDate),
        legacyUpdatedAt: dt(r.UpdateDate),
      };
      const legacyId = String(r.JewelId);
      await this.prisma.stockItem.upsert({
        where: { legacyId },
        create: { legacyId, ...data },
        update: data,
      });
      upserted++;
    }
    return this.result('stock', records, upserted, skipped);
  }

  // ── JewelTrans -> Sale ───────────────────────────────────────────────────────
  async syncSales(records: Rec[]): Promise<SyncResult> {
    const storeId = await this.assertStore();
    const partyByLegacy = await this.idMap(
      'party',
      records.map((r) => r.PartyNo),
    );
    let upserted = 0;
    let skipped = 0;
    for (const r of records) {
      if (r.JewelTransId == null) {
        skipped++;
        continue;
      }
      const docType = docTypeFromTranType(r.TranType);
      const baseNo = `${str(r.JewelTransPrefix) || ''}${r.JewelTransNo ?? r.JewelTransId}`;
      const docNo = `${baseNo}#${r.JewelTransId}`;
      const data = {
        storeId,
        partyId: partyByLegacy.get(String(r.PartyNo)) ?? null,
        docNo,
        docType: docType as any,
        docDate: dt(r.JewelTransDate) || new Date(),
        grossAmount: dec(r.GrossAmount) ?? '0',
        totalAmount: dec(r.Amount) ?? '0',
        remarks: str(r.Remarks),
        isCancelled: bool(r.isCancel),
        legacyUpdatedAt: dt(r.UpdateDate),
      };
      const legacyId = String(r.JewelTransId);
      await this.prisma.sale.upsert({
        where: { legacyId },
        create: { legacyId, ...data },
        update: data,
      });
      upserted++;
    }
    return this.result('sales', records, upserted, skipped);
  }

  // ── JewelTransInward (+Summary) -> SaleLine ──────────────────────────────────
  async syncSaleLines(records: Rec[]): Promise<SyncResult> {
    const saleByLegacy = await this.idMap(
      'sale',
      records.map((r) => r.JewelTransId),
    );
    const stockByLegacy = await this.idMap(
      'stockItem',
      records.map((r) => r.JewelId),
    );
    let upserted = 0;
    let skipped = 0;
    for (const r of records) {
      const saleId = saleByLegacy.get(String(r.JewelTransId));
      if (!saleId) {
        skipped++; // line for a non-imported / cancelled header
        continue;
      }
      const legacyId = `${r.JewelTransId}:${r.JewelId}:${r.SrNo ?? 0}`;
      const data = {
        saleId,
        stockItemId: stockByLegacy.get(String(r.JewelId)) ?? null,
        netWeight: dec(r.NetWt),
        metalAmount: dec(r.TotMtlAmt),
        makingAmount: dec(r.TotHandlingAmt),
        stoneAmount: dec(r.TotDiaAmt),
        discountAmount: dec(r.DiscountAmt),
        lineTotal: dec(r.MRP) ?? '0',
      };
      await this.prisma.saleLine.upsert({
        where: { legacyId },
        create: { legacyId, ...data },
        update: data,
      });
      upserted++;
    }
    return this.result('sale-lines', records, upserted, skipped);
  }

  // ── Spm_MfgOrder -> ManufacturingOrder ───────────────────────────────────────
  async syncOrders(records: Rec[]): Promise<SyncResult> {
    const storeId = await this.assertStore();
    const partyByLegacy = await this.idMap(
      'party',
      records.flatMap((r) => [r.MadeFor_PartyNo, r.CustomerId]),
    );
    let upserted = 0;
    let skipped = 0;
    for (const r of records) {
      if (r.OrderId == null) {
        skipped++;
        continue;
      }
      const partyId =
        partyByLegacy.get(String(r.MadeFor_PartyNo)) ??
        partyByLegacy.get(String(r.CustomerId)) ??
        null;
      const data = {
        storeId,
        partyId,
        orderNo: `${str(r.OrderPrefix) || ''}${r.OrderNo ?? r.OrderId}`,
        orderDate: dt(r.OrderDate) || new Date(),
        // `EclatStage` is decoded agent-side from the install's own OrderStatus
        // codes (stage_map.json) — those ints are per-install, so guessing them
        // here would silently mislabel every order. Absent or unrecognised, the
        // order stays "booked" and the bag sync below advances it from the actual
        // shop-floor movements, which are far more reliable than the header int.
        status: (STAGE_RANK[str(r.EclatStage) ?? ''] != null
          ? str(r.EclatStage)
          : 'booked') as any,
        amount: dec(r.Amount ?? r.GrossAmount) ?? '0',
        poNo: str(r.PoNo),
        legacyUpdatedAt: dt(r.UpdateDate),
      };
      const legacyId = String(r.OrderId);
      await this.prisma.manufacturingOrder.upsert({
        where: { legacyId },
        create: { legacyId, ...data },
        update: data,
      });
      upserted++;
    }
    return this.result('orders', records, upserted, skipped);
  }

  // ── SPM_MfgOrderItem -> ManufacturingOrderItem ───────────────────────────────
  async syncOrderItems(records: Rec[]): Promise<SyncResult> {
    const orderByLegacy = await this.idMap(
      'manufacturingOrder',
      records.map((r) => r.OrderId),
    );
    const stockByLegacy = await this.idMap(
      'stockItem',
      records.map((r) => r.Inward_JewelId),
    );
    let upserted = 0;
    let skipped = 0;
    for (const r of records) {
      const orderId = orderByLegacy.get(String(r.OrderId));
      if (!orderId || r.OrderItemId == null) {
        skipped++;
        continue;
      }
      const data = {
        orderId,
        styleSku: str(r.SKUNo),
        description: str(r.SpecialRemarks),
        orderQty: int(r.OrderQty) ?? 1,
        status: (bool(r.Completed) ? 'ready' : 'booked') as any,
        expectedDelivery: dt(r.ExpDelDate),
        producedStockItemId: r.Inward_JewelId
          ? stockByLegacy.get(String(r.Inward_JewelId)) ?? null
          : null,
      };
      const legacyId = String(r.OrderItemId);
      await this.prisma.manufacturingOrderItem.upsert({
        where: { legacyId },
        create: { legacyId, ...data },
        update: data,
      });
      upserted++;
    }
    return this.result('order-items', records, upserted, skipped);
  }

  // ── Generic full mirror: ANY APRS-SJEP table -> LegacyRow ────────────────────
  // Stores every row verbatim (JSON), keyed by (sourceTable, rowKey). The agent
  // sends `_rowKey` (the source PK) + optional `_updatedAt`. This is the
  // "extract-everything-once" sink: future needs read LegacyRow, no code change.
  async syncRaw(table: string, records: Rec[]): Promise<SyncResult> {
    let upserted = 0;
    let skipped = 0;
    let watermark: string | null = null;
    for (const r of records) {
      const rowKey = r._rowKey != null ? String(r._rowKey) : null;
      if (!table || rowKey === null) {
        skipped++;
        continue;
      }
      const legacyUpdatedAt = dt(r._updatedAt);
      if (legacyUpdatedAt) {
        const iso = legacyUpdatedAt.toISOString();
        if (!watermark || iso > watermark) watermark = iso;
      }
      const { _rowKey, _updatedAt, ...data } = r;
      void _rowKey;
      void _updatedAt;
      await this.prisma.legacyRow.upsert({
        where: { sourceTable_rowKey: { sourceTable: table, rowKey } },
        create: { sourceTable: table, rowKey, data: data as any, legacyUpdatedAt },
        update: { data: data as any, legacyUpdatedAt, syncedAt: new Date() },
      });
      upserted++;
    }
    this.logger.log(
      `sync raw:${table}: received=${records.length} upserted=${upserted} skipped=${skipped}`,
    );
    return { entity: `raw:${table}`, received: records.length, upserted, skipped, watermark };
  }

  /**
   * Build a legacyId -> Eclat id map for a model, batched to avoid huge `IN`
   * clauses. Used to resolve foreign keys against already-synced entities.
   */
  // ── SPM_BagMaster -> ProductionBag (the manufacturing timeline) ─────────────
  /**
   * Shop-floor bags are what actually moves through the factory, so their
   * department + status IS the manufacturing timeline. `Spm_MfgOrder.OrderStatus`
   * is a single int on the header and says nothing about where a piece has got
   * to; the bag rows do.
   *
   * The agent has already decoded `DepartmentId` to a department NAME and mapped
   * it to an Eclat stage (see stage_map.json on the agent side) — the codes are
   * per-install, so that decode is configuration, not something to hardcode here.
   * `stage` is optional: an unmapped department still records the movement, it
   * just doesn't advance the order.
   */
  async syncBags(records: Rec[]): Promise<SyncResult> {
    const orderByLegacy = await this.idMap(
      'manufacturingOrder',
      records.map((r) => r.OrderId),
    );
    let upserted = 0;
    let skipped = 0;
    /** Furthest stage seen per order, so the header can follow the shop floor. */
    const furthest = new Map<string, { stage: string; at: Date | null }>();

    for (const r of records) {
      if (r.BagId == null) {
        skipped++;
        continue;
      }
      const orderId = orderByLegacy.get(String(r.OrderId)) ?? null;
      const bagDate = dt(r.BagDate);
      const data = {
        orderId,
        bagNo: str(r.BagNo) || String(r.BagId),
        barcode: str(r.BagBarcode),
        department: str(r.DepartmentName) || str(r.DepartmentId),
        status: str(r.BagStatus),
        grossWeight: dec(r.GrossWt),
        netWeight: dec(r.NetWt),
        isComplete: bool(r.IsBagComplete) ?? false,
        bagDate,
        legacyUpdatedAt: dt(r.UpdateDate),
      };
      const legacyId = String(r.BagId);
      await this.prisma.productionBag.upsert({
        where: { legacyId },
        create: { legacyId, ...data },
        update: data,
      });
      upserted++;

      const stage = str(r.EclatStage);
      if (orderId && stage && STAGE_RANK[stage] != null) {
        const seen = furthest.get(orderId);
        if (!seen || STAGE_RANK[stage] > STAGE_RANK[seen.stage]) {
          furthest.set(orderId, { stage, at: bagDate });
        }
      }
    }

    // Advance each order header to the furthest stage its bags have reached.
    // Never moves an order BACKWARDS — a bag returning to an earlier department
    // for rework must not un-finish an order that is already further along.
    for (const [orderId, { stage, at }] of furthest) {
      const current = await this.prisma.manufacturingOrder.findUnique({
        where: { id: orderId },
        select: { status: true },
      });
      const currentRank = current ? (STAGE_RANK[current.status] ?? -1) : -1;
      if (STAGE_RANK[stage] > currentRank) {
        await this.prisma.manufacturingOrder.update({
          where: { id: orderId },
          data: { status: stage as any, expectedDelivery: undefined },
        });
        this.logger.log(`order ${orderId} -> ${stage}${at ? ` (${at.toISOString()})` : ''}`);
      }
    }

    return this.result('bags', records, upserted, skipped);
  }

  // ── Inward.ImageName / StyleMst image -> Product.imageUrl, StockItem photo ───
  /**
   * Attach already-uploaded image URLs to the rows they belong to.
   *
   * Deliberately takes URLs, not bytes: the agent uploads each photo straight
   * from the shop PC to Cloudinary and sends only the resulting link. Routing
   * tens of GB of catalogue photography through the API would be slow, would
   * count twice against Railway egress, and would run into request-size limits.
   *
   * `kind` selects the target table because the legacy image lives on both the
   * design master (StyleMst -> Product) and the physical piece (Inward -> StockItem).
   */
  async syncProductImages(records: Rec[]): Promise<SyncResult> {
    let upserted = 0;
    let skipped = 0;
    for (const r of records) {
      const legacyId = r.legacyId == null ? null : String(r.legacyId);
      const url = str(r.imageUrl);
      if (!legacyId || !url) {
        skipped++;
        continue;
      }
      const kind = str(r.kind) === 'stock' ? 'stock' : 'product';
      try {
        if (kind === 'product') {
          await this.prisma.product.update({
            where: { legacyId },
            data: { imageUrl: url, ...(str(r.stlUrl) ? { stlUrl: str(r.stlUrl) } : {}) },
          });
        } else {
          await this.prisma.stockItem.update({
            where: { legacyId },
            data: { imageUrl: url },
          });
        }
        upserted++;
      } catch {
        // The row hasn't been synced yet (images can run ahead of a full pull).
        // Skipping is correct: the next media run re-sends it.
        skipped++;
      }
    }
    return this.result('product-images', records, upserted, skipped);
  }

  private async idMap(
    model: 'party' | 'product' | 'stockItem' | 'sale' | 'manufacturingOrder',
    legacyValues: unknown[],
  ): Promise<Map<string, string>> {
    const ids = [
      ...new Set(
        legacyValues.filter((v) => v !== null && v !== undefined).map((v) => String(v)),
      ),
    ];
    const map = new Map<string, string>();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = await (this.prisma[model] as any).findMany({
        where: { legacyId: { in: chunk } },
        select: { id: true, legacyId: true },
      });
      for (const row of rows) map.set(row.legacyId, row.id);
    }
    return map;
  }

  private result(entity: string, records: Rec[], upserted: number, skipped: number): SyncResult {
    this.logger.log(
      `sync ${entity}: received=${records.length} upserted=${upserted} skipped=${skipped}`,
    );
    return { entity, received: records.length, upserted, skipped, watermark: maxWatermark(records) };
  }
}
