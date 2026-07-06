import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
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
  ) {}

  /** Single-branch legacy install -> one Eclat store (override via SYNC_DEFAULT_STORE_ID). */
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
        // Legacy OrderStatus is an int code (decode TBD) — map all to "booked" for now.
        status: 'booked' as any,
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
