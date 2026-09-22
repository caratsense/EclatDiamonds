/**
 * CaratOS import — per-entity map + persist registry.
 *
 * The pipeline (discover/preview/import/reconcile) is entity-agnostic; each entity
 * plugs in a `mapRow` (validate+normalise a mapped row) and a `persist` (idempotent,
 * organisation-scoped upsert with duplicate detection). Adding an entity = adding a
 * dictionary entry + an importer here. NEVER fabricates data: missing optional
 * fields stay empty; missing metal is `gold_unspecified` (NOT 22K); a required field
 * makes the row a reported error, never a guess.
 */

import { MetalKind, Prisma, StockClass } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { parseStockClass } from '../../stock/stock-class';
import { ImportEntity } from './field-dictionary';
import { mapCustomerRow } from './customer-mapper';

export interface Issue {
  field: string;
  code: string;
  message: string;
}
export interface RowResult {
  ok: boolean;
  value?: Record<string, unknown>;
  issues: Issue[]; // block the row
  warnings: Issue[]; // keep the row, flag it
}
export type Outcome = 'imported' | 'updated' | 'duplicate';
export type ImportPersistenceClient = Pick<PrismaService, 'party' | 'store' | 'product'>;

export interface ImportContext {
  sourceSystem: string;
  isMachine: boolean;
  neutralProduct?: boolean;
}

export interface EntityImporter {
  mapRow(mapped: Record<string, string>, context?: ImportContext): RowResult;
  persist(
    prisma: ImportPersistenceClient,
    org: string,
    storeId: string | undefined,
    value: Record<string, unknown>,
    /**
     * CaratOS Phase A7 — the ImportBatch this row came from.
     *
     * Stamped on every row an importer CREATES, so a file-imported record is
     * distinguishable from a hand-entered one. Without it, `purgeDemo`'s rule
     * ("no legacyId means this is seeded demo data") deletes every customer and
     * product a client imported from their own spreadsheet — the exact
     * destructive path a documented go-live operation walks.
     *
     * Deliberately NOT applied on update: a row that already existed keeps
     * whatever provenance it had. An import that touches a hand-entered customer
     * does not retroactively make them imported.
     */
    batchId: string,
  ): Promise<Outcome>;
}

const clean = (v: unknown): string => String(v ?? '').trim();

/**
 * Validate against the actual PostgreSQL Decimal(p,s) column before preview is
 * allowed to call a row valid. This also prevents implicit database rounding.
 */
function boundedNonNegativeDecimal(
  value: string,
  maximumIntegerDigits: number,
  maximumScale: number,
): number | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return null;
  const integer = match[1].replace(/^0+(?=\d)/, '');
  const fraction = match[2] ?? '';
  if (integer.length > maximumIntegerDigits || fraction.length > maximumScale) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/* --------------------------------------------------------------- customers */

const customers: EntityImporter = {
  mapRow(mapped) {
    const r = mapCustomerRow(mapped);
    return { ok: r.ok, value: r.value ?? undefined, issues: r.issues, warnings: r.warnings };
  },
  async persist(prisma, org, storeId, value, batchId) {
    const v = value as { name: string; code: string | null; phone: string | null; email: string | null; city: string | null; gstin: string | null; birthday: string | null; anniversary: string | null };
    const dates = {
      birthday: v.birthday ? new Date(v.birthday) : undefined,
      anniversary: v.anniversary ? new Date(v.anniversary) : undefined,
    };
    // A stable external code wins. Phone/name are shared business attributes,
    // not safe identities for machine upserts.
    // Restricted principals may update only rows in their concrete branch.
    // Organisation-wide/null rows are not visible through the store-scoped read
    // path, so treating them as writable here would create a write-only escape.
    const storeScope = storeId ? { storeId } : {};
    const candidates = await prisma.party.findMany({
      where: {
        organisationId: org,
        ...storeScope,
        ...(v.code
          ? { code: v.code }
          : v.phone
            ? { phone: v.phone, types: { has: 'customer' as const } }
            : { name: v.name, types: { has: 'customer' as const } }),
      },
      select: { id: true, types: true },
      take: 2,
    });
    // A repeated phone/name or a code already owned by a non-customer Party is
    // a merge candidate. Never mutate whichever findFirst happened to return.
    if (
      candidates.length > 1 ||
      (candidates[0] && !candidates[0].types.includes('customer'))
    ) {
      return 'duplicate';
    }
    const existing = candidates[0];
    if (existing) {
      await prisma.party.update({
        where: { id: existing.id },
        data: { name: v.name, code: v.code ?? undefined, phone: v.phone ?? undefined, email: v.email ?? undefined, city: v.city ?? undefined, gstin: v.gstin ?? undefined, ...dates },
      });
      return 'updated';
    }
    await prisma.party.create({
      data: { organisationId: org, name: v.name, code: v.code, phone: v.phone, email: v.email, city: v.city, gstin: v.gstin, ...dates, storeId: storeId ?? null, types: ['customer'], importBatchId: batchId },
    });
    return 'imported';
  },
};

/* ------------------------------------------------------------------ stores */

const stores: EntityImporter = {
  mapRow(mapped) {
    const name = clean(mapped.name);
    const issues: Issue[] = [];
    if (!name) issues.push({ field: 'name', code: 'missing_required', message: 'Store name is required' });
    if (issues.length) return { ok: false, issues, warnings: [] };
    return {
      ok: true,
      issues: [],
      warnings: [],
      value: {
        name,
        city: clean(mapped.city) || null,
        code: clean(mapped.code) || null,
        gstin: clean(mapped.gstin).toUpperCase() || null,
        phone: clean(mapped.phone) || null,
        email: clean(mapped.email).toLowerCase() || null,
        addressLine1: clean(mapped.addressLine1) || null,
        state: clean(mapped.state) || null,
        pincode: clean(mapped.pincode) || null,
      },
    };
  },
  async persist(prisma, org, _storeId, value, batchId) {
    const v = value as Record<string, string | null>;
    // Dedup within the org by code (preferred) or name.
    const where: Prisma.StoreWhereInput = v.code
      ? { organisationId: org, code: v.code, isAggregate: false }
      : { organisationId: org, name: v.name!, isAggregate: false };
    const existing = await prisma.store.findFirst({ where, select: { id: true } });
    if (existing) {
      await prisma.store.update({
        where: { id: existing.id },
        data: {
          name: v.name!,
          city: v.city ?? undefined,
          gstin: v.gstin ?? undefined,
          phone: v.phone ?? undefined,
          email: v.email ?? undefined,
          addressLine1: v.addressLine1 ?? undefined,
          state: v.state ?? undefined,
          pincode: v.pincode ?? undefined,
        },
      });
      return 'updated';
    }
    // Imported stores land `pending` (no geofence/region yet) — same rule as a
    // Gati-detected branch; HO activates them after setting coordinates.
    await prisma.store.create({
      data: {
        organisationId: org,
        importBatchId: batchId,
        name: v.name!,
        city: v.city ?? '',
        code: v.code ?? undefined,
        gstin: v.gstin,
        phone: v.phone,
        email: v.email,
        addressLine1: v.addressLine1,
        state: v.state,
        pincode: v.pincode,
        status: 'pending',
        isActive: false,
      },
    });
    return 'imported';
  },
};

/* ---------------------------------------------------------------- products */

/** Map a source metal string + karat to a canonical MetalKind. NEVER assumes 22K. */
function toMetal(metalRaw: string, karat: number | null, neutralDefault: boolean): MetalKind {
  const m = metalRaw.toLowerCase();
  if (m.includes('silver')) return MetalKind.silver;
  if (m.includes('plat')) return MetalKind.platinum;
  // Gold (explicit, or implied by a karat) resolves by karat; unknown karat =>
  // gold_unspecified — an honest "we don't know the purity", not a silent 22K.
  const isGold = m.includes('gold') || (!m && karat != null);
  if (isGold) {
    if ((m.includes('rose') || m.includes('pink')) && karat === 18) {
      return MetalKind.rose_gold_18k;
    }
    switch (karat) {
      case 24: return MetalKind.gold_24k;
      case 22: return MetalKind.gold_22k;
      case 18: return MetalKind.gold_18k;
      case 14: return MetalKind.gold_14k;
      case 12: return MetalKind.gold_12k;
      case 10: return MetalKind.gold_10k;
      case 9: return MetalKind.gold_9k;
      default: return MetalKind.gold_unspecified;
    }
  }
  if (!m && !neutralDefault) return MetalKind.gold_unspecified;
  return MetalKind.unspecified;
}

const products: EntityImporter = {
  mapRow(mapped, context) {
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const sku = clean(mapped.sku);
    const name = clean(mapped.name);
    if (!sku) issues.push({ field: 'sku', code: 'missing_required', message: 'SKU is required (not fabricated)' });
    if (!name) issues.push({ field: 'name', code: 'missing_required', message: 'Product name is required' });

    let karat: number | null = null;
    const karatRaw = clean(mapped.karat);
    if (karatRaw) {
      const digits = parseInt(karatRaw.replace(/[^0-9]/g, ''), 10);
      if (Number.isFinite(digits) && digits > 0 && digits <= 24) karat = digits;
      else warnings.push({ field: 'karat', code: 'invalid_karat', message: `"${karatRaw}" is not a recognised karat — purity left unspecified` });
    }
    const metalRaw = clean(mapped.metal);
    const neutralDefault = Boolean(
      context?.neutralProduct ||
      (context?.isMachine && ['busy', 'tally', 'odbc', 'gati'].includes(context.sourceSystem)),
    );
    if (!metalRaw && karat == null && !neutralDefault) {
      warnings.push({ field: 'metal', code: 'unknown_purity', message: 'No metal/purity given — imported as unspecified (never assumed 22K)' });
    }

    let price: number | null = null;
    const priceRaw = clean(mapped.price).replace(/[₹,\s]/g, '');
    if (priceRaw) {
      // Product.price is Decimal(14,2): at most 12 integer and 2 fraction digits.
      const n = boundedNonNegativeDecimal(priceRaw, 12, 2);
      if (n != null) price = n;
      else warnings.push({ field: 'price', code: 'invalid_price', message: `"${clean(mapped.price)}" is not a valid price — imported without price` });
    }
    let weight: number | null = null;
    const weightInput = clean(mapped.weightGrams);
    const wtRaw = weightInput
      .replace(/,/g, '')
      .replace(/\s*(?:g|gm|gms|gram|grams)\s*$/i, '')
      .trim();
    if (wtRaw) {
      // Product.weightGrams is Decimal(12,3): at most 9 integer and 3 fraction digits.
      const n = boundedNonNegativeDecimal(wtRaw, 9, 3);
      if (n != null) weight = n;
      else warnings.push({ field: 'weightGrams', code: 'invalid_weight', message: `"${weightInput}" is not a valid weight — imported without weight` });
    }

    if (issues.length) return { ok: false, issues, warnings };
    const category = clean(mapped.category);
    const unitOfMeasure = clean(mapped.unitOfMeasure);
    // The DESIGN, above the SKU. Blank rather than falling back to the SKU: a
    // style number that is secretly the SKU makes every "how is this design
    // selling" answer a per-piece answer wearing a design's label.
    const styleNumber = clean(mapped.styleNumber);
    const stockClassRaw = clean(mapped.stockClass);
    const stockClass = parseStockClass(stockClassRaw);
    if (stockClassRaw && !stockClass) {
      warnings.push({
        field: 'stockClass',
        code: 'invalid_stock_class',
        message: `"${stockClassRaw}" is not a recognised classification (standard, customised/made to order, non-stock/display/sample) — left as it was`,
      });
    }
    return {
      ok: true,
      issues: [],
      warnings,
      value: {
        sku,
        name,
        styleNumber: styleNumber || null,
        styleNumberSupplied: Boolean(styleNumber),
        stockClass,
        metal: toMetal(metalRaw, karat, neutralDefault),
        materialLabel: metalRaw || null,
        karat: karat ?? 0,
        price,
        weight,
        category: category || null,
        unitOfMeasure: unitOfMeasure || null,
        materialSupplied: Boolean(metalRaw || karat != null),
        categorySupplied: Boolean(category),
        unitOfMeasureSupplied: Boolean(unitOfMeasure),
      },
    };
  },
  async persist(prisma, org, storeId, value, batchId) {
    const v = value as {
      sku: string;
      name: string;
      metal: MetalKind;
      materialLabel: string | null;
      karat: number;
      price: number | null;
      weight: number | null;
      category: string | null;
      unitOfMeasure: string | null;
      styleNumber: string | null;
      styleNumberSupplied: boolean;
      /** Null when the file did not carry a recognisable one — never a default. */
      stockClass: StockClass | null;
      materialSupplied: boolean;
      categorySupplied: boolean;
      unitOfMeasureSupplied: boolean;
    };
    // SKU is unique per organisation. A branch-bound machine may mutate only a
    // product owned by that exact branch; global/sibling rows are conflicts.
    const existing = await prisma.product.findFirst({
      where: {
        organisationId: org,
        sku: v.sku,
      },
      select: { id: true, storeId: true },
    });
    const updateData = {
      name: v.name,
      ...(v.materialSupplied
        ? { metal: v.metal, karat: v.karat, materialLabel: v.materialLabel }
        : {}),
      ...(v.categorySupplied ? { categoryLabel: v.category } : {}),
      ...(v.unitOfMeasureSupplied ? { unitOfMeasure: v.unitOfMeasure } : {}),
      // Only when the file carried the column. A source that does not send style
      // numbers must not blank the ones a person typed in by hand.
      ...(v.styleNumberSupplied ? { styleNumber: v.styleNumber } : {}),
      // Same rule: a file without the column, or with a word we could not read,
      // must not turn a made-to-order design back into ordinary stock.
      ...(v.stockClass ? { stockClass: v.stockClass } : {}),
      ...(v.price != null ? { price: new Prisma.Decimal(v.price) } : {}),
      ...(v.weight != null ? { weightGrams: new Prisma.Decimal(v.weight) } : {}),
      ...(v.price != null ? { priceKnown: true } : {}),
      ...(v.weight != null ? { weightKnown: true } : {}),
    };
    if (existing) {
      if (storeId && existing.storeId !== storeId) return 'duplicate';
      const updated = await prisma.product.updateMany({
        where: {
          id: existing.id,
          organisationId: org,
          ...(storeId ? { storeId } : {}),
        },
        data: updateData,
      });
      if (updated.count !== 1) return 'duplicate';
      return 'updated';
    }
    await prisma.product.create({
      data: {
        organisationId: org,
        sku: v.sku,
        storeId: storeId ?? null,
        embedding: [],
        importBatchId: batchId,
        priceKnown: v.price != null,
        weightKnown: v.weight != null,
        name: v.name,
        metal: v.metal,
        karat: v.karat,
        categoryLabel: v.category,
        materialLabel: v.materialLabel,
        unitOfMeasure: v.unitOfMeasure,
        styleNumber: v.styleNumber,
        ...(v.stockClass ? { stockClass: v.stockClass } : {}),
        ...(v.price != null ? { price: new Prisma.Decimal(v.price) } : {}),
        ...(v.weight != null ? { weightGrams: new Prisma.Decimal(v.weight) } : {}),
      },
    });
    return 'imported';
  },
};

export const IMPORTERS: Record<ImportEntity, EntityImporter> = { customers, stores, products };
