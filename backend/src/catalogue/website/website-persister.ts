import { Prisma } from '@prisma/client';

import { websiteComposition } from '../../products/composition';
import { applyImageOrder } from '../image-order';
import {
  NormalizedWebsiteProduct,
  WEBSITE_NORMALIZER_VERSION,
  canonicalJson,
  normaliseCode,
  normalizeWebsiteProduct,
  payloadHash,
} from './website-normalizer';

/**
 * Writes one normalised website product, respecting source ownership
 * (docs/modules/05-catalogue-sources.md):
 *
 *   - a Gati-matched Product gets ONLY websiteCode, websiteSyncedAt and — when
 *     Gati has none — composition. Its name, sku, price, metal, karat, category
 *     and stock are Gati's and are never written here;
 *   - everything else lands in website-owned rows: listing, variants, size
 *     options, labelled prices, pictures + their colour/shape associations;
 *   - a website-only design gets its own Product (legacyId WEB-<code>).
 *
 * Nothing is deleted or tombstoned here. Removals are decided only at the end of
 * a COMPLETE run (`reconcileRemovals`, `tombstoneGone`), so a partial run can
 * never make a design or a picture disappear.
 */

type Db = Prisma.TransactionClient;
export const WEBSITE = 'website';

export interface PersistContext {
  runId: string;
  now: Date;
  /** Category enum from free text (the sync's shared classifier). */
  categoryOf: (row: Record<string, unknown>) => string;
}

export interface PersistResult {
  action: 'created' | 'updated' | 'unchanged';
  productId: string;
  externalId: string;
  productCode: string;
  match: 'gati' | 'linked' | 'none' | 'ambiguous';
  changes: string[];
  conflicts: number;
  imagesExpected: number;
  /** Pictures that are new or came back, to be queued for indexing after commit. */
  newImageIds: string[];
}

interface Target {
  gatiId: string | null;
  match: PersistResult['match'];
  candidates: { id: string; sku: string; name: string; styleNumber: string | null; matchedOn: string }[];
}

export const matchKey = (code: string) => `website:${normaliseCode(code)}`;

/**
 * Website productCode → Gati design: styleNumber, then sku, then name (StyleCode),
 * each normalised. The first tier with any hit decides: one hit joins, several
 * are ambiguous and nothing is guessed. A head-office link (resolved ambiguous
 * conflict with `resolution.productId`) overrides.
 */
export async function resolveTarget(db: Db, organisationId: string, productCode: string): Promise<Target> {
  const norm = normaliseCode(productCode);
  if (!norm) return { gatiId: null, match: 'none', candidates: [] };
  const linked = await db.catalogueConflict.findFirst({
    where: { organisationId, kind: 'gati_match_ambiguous', key: matchKey(productCode), status: 'resolved' },
    select: { resolution: true },
  });
  const linkedId = (linked?.resolution as { productId?: unknown } | null)?.productId;
  if (typeof linkedId === 'string') {
    const p = await db.product.findFirst({ where: { id: linkedId, organisationId }, select: { id: true } });
    if (p) return { gatiId: p.id, match: 'linked', candidates: [] };
  }
  const rows = await db.$queryRaw<{ id: string; sku: string; name: string; styleNumber: string | null }[]>`
    SELECT "id", "sku", "name", "styleNumber" FROM "Product"
    WHERE "organisationId" = ${organisationId}
      AND "legacyId" IS NOT NULL AND "legacyId" NOT LIKE 'WEB-%'
      AND (regexp_replace(upper(coalesce("styleNumber", '')), '[[:space:]_/.-]', '', 'g') = ${norm}
        OR regexp_replace(upper("sku"), '[[:space:]_/.-]', '', 'g') = ${norm}
        OR regexp_replace(upper("name"), '[[:space:]_/.-]', '', 'g') = ${norm})
    ORDER BY "id"`;
  for (const field of ['styleNumber', 'sku', 'name'] as const) {
    const hits = rows.filter((r) => normaliseCode(r[field]) === norm);
    const candidates = hits.map((h) => ({ ...h, matchedOn: field }));
    if (hits.length === 1) return { gatiId: hits[0].id, match: 'gati', candidates };
    if (hits.length > 1) return { gatiId: null, match: 'ambiguous', candidates };
  }
  return { gatiId: null, match: 'none', candidates: [] };
}

// ── value comparison (Decimal columns vs source numbers) ─────────────────────
const sameNum = (a: unknown, b: number | null) =>
  a == null || a === '' ? b == null : b != null && Number(a).toFixed(3) === b.toFixed(3);
const sameJson = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
const sameList = (a: string[] | null | undefined, b: string[]) => sameJson(a ?? [], b);
const sameDate = (a: Date | null | undefined, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);

function diffFields<T extends Record<string, unknown>>(
  current: Record<string, unknown>,
  next: T,
  compare: Partial<Record<keyof T, (a: unknown, b: any) => boolean>> = {},
): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(next)) {
    const eq = compare[k as keyof T] ?? ((a: unknown, b: unknown) => (a instanceof Date || b instanceof Date ? sameDate(a as Date, b as Date) : sameJson(a, b)));
    if (!eq(current[k], v)) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

async function upsertConflict(
  db: Db,
  organisationId: string,
  now: Date,
  c: { kind: string; key: string; productId: string | null; externalId: string; summary: string; detail: unknown },
) {
  // A decision someone already made (resolved/ignored) stands when the same
  // problem is seen again; only its evidence and lastSeenAt refresh.
  await db.catalogueConflict.upsert({
    where: { organisationId_kind_key: { organisationId, kind: c.kind, key: c.key } },
    create: {
      organisationId,
      kind: c.kind,
      key: c.key,
      productId: c.productId,
      externalId: c.externalId,
      summary: c.summary,
      detail: c.detail as Prisma.InputJsonValue,
    },
    update: { productId: c.productId, externalId: c.externalId, summary: c.summary, detail: c.detail as Prisma.InputJsonValue, lastSeenAt: now },
  });
}

async function autoResolve(db: Db, organisationId: string, now: Date, where: Prisma.CatalogueConflictWhereInput) {
  await db.catalogueConflict.updateMany({
    where: { organisationId, status: 'open', ...where },
    data: { status: 'resolved', resolvedAt: now, resolution: { auto: 'no longer reported by the source' } },
  });
}

/** Website composition from the first variant that has a bill of material. */
function compositionOf(n: NormalizedWebsiteProduct) {
  const v = n.variants.find((x) => x.bom.length);
  return v
    ? websiteComposition(
        v.bom.map((l) => ({
          materialName: l.materialName,
          weight: l.weight,
          unit: l.unit,
          quantity: l.quantity,
          rate: l.rate,
          lineTotal: l.lineTotal,
          isDiamond: l.isDiamond,
        })),
      )
    : null;
}

/**
 * Remove a listing and its website-owned rows from a design it no longer
 * belongs to (a website-only design that has since been matched or linked to
 * a Gati design). Manual/inventory/CAD pictures are untouched; the website
 * pictures are tombstoned, not deleted. The emptied website-only Product is
 * deleted only when nothing else refers to it.
 */
async function detachWebsite(db: Db, organisationId: string, productId: string, now: Date) {
  await db.productPrice.deleteMany({ where: { productId, source: WEBSITE } });
  await db.productOption.deleteMany({ where: { productId, source: WEBSITE } });
  await db.productVariant.deleteMany({ where: { productId, source: WEBSITE } });
  await db.productImage.updateMany({
    where: { productId, source: WEBSITE, status: 'active' },
    data: { status: 'tombstoned', tombstonedAt: now },
  });
  await db.productWebsiteListing.deleteMany({ where: { productId } });
  const p = await db.product.findFirst({
    where: { id: productId, organisationId },
    select: {
      legacyId: true,
      _count: { select: { stockItems: true, quoteLines: true, saleLines: true } },
      images: { where: { source: { not: WEBSITE } }, select: { id: true }, take: 1 },
    },
  });
  if (!p) return;
  const unused = !p._count.stockItems && !p._count.quoteLines && !p._count.saleLines && !p.images.length;
  if (p.legacyId?.startsWith('WEB-') && unused) {
    await db.product.delete({ where: { id: productId } });
  } else {
    await db.product.update({ where: { id: productId }, data: { websiteCode: null } });
    await applyImageOrder(db, productId);
  }
}

export async function persistWebsiteProduct(
  db: Db,
  organisationId: string,
  ctx: PersistContext,
  payload: unknown,
): Promise<PersistResult> {
  const n = normalizeWebsiteProduct(payload);
  const hash = payloadHash(payload);
  const { now } = ctx;
  const code = n.productCode;
  const snap = await db.externalProductSnapshot.findUnique({
    where: { organisationId_source_externalId: { organisationId, source: WEBSITE, externalId: n.externalId } },
  });
  const target = await resolveTarget(db, organisationId, code);
  const webLegacyId = `WEB-${code}`;
  const webProduct = target.gatiId
    ? null
    : await db.product.findFirst({
        where: { organisationId, legacyId: webLegacyId },
        select: { id: true, name: true, category: true, metal: true, karat: true, price: true, caratWeight: true, description: true, websiteCode: true, composition: true },
      });
  const productIdBefore = target.gatiId ?? webProduct?.id ?? null;
  const matchConflicts = target.match === 'none' || target.match === 'ambiguous' ? 1 : 0;
  const base = { externalId: n.externalId, productCode: code, match: target.match, imagesExpected: new Set(n.images.map((i) => i.url)).size };

  // Hash no-op: the same payload, normalised by the same version, onto the same
  // design, already fully written. Only the sighting is recorded.
  if (
    snap &&
    productIdBefore &&
    snap.productId === productIdBefore &&
    snap.payloadHash === hash &&
    snap.schemaVersion === WEBSITE_NORMALIZER_VERSION &&
    snap.normalizationStatus !== 'error' &&
    !snap.goneAt
  ) {
    await db.externalProductSnapshot.update({ where: { id: snap.id }, data: { lastSeenAt: now, syncRunId: ctx.runId } });
    return { ...base, action: 'unchanged', productId: productIdBefore, changes: [], conflicts: n.conflicts.length + matchConflicts, newImageIds: [] };
  }

  const changes: string[] = [];
  let created = false;
  const composition = compositionOf(n);
  const lead = n.variants[0];
  const priceOf = (kind: string) => n.prices.find((p) => p.kind === kind && !p.variantKey)?.amount ?? null;

  // ── Product: only the columns this source owns ──────────────────────────
  let productId: string;
  if (target.gatiId) {
    productId = target.gatiId;
    const p = await db.product.findUniqueOrThrow({ where: { id: productId }, select: { websiteCode: true, composition: true } });
    const data: Prisma.ProductUpdateInput = { websiteSyncedAt: now };
    if (p.websiteCode !== code) {
      data.websiteCode = code;
      changes.push('product.websiteCode');
    }
    const owner = (p.composition as { source?: string } | null)?.source;
    if (composition && (!p.composition || owner === WEBSITE) && !sameJson(p.composition, composition)) {
      data.composition = composition as unknown as Prisma.InputJsonValue;
      changes.push('product.composition');
    }
    await db.product.update({ where: { id: productId }, data });
  } else {
    const fields = {
      name: n.listing.marketingName,
      category: ctx.categoryOf({ StyleCode: code, name: n.listing.marketingName, category: [...n.listing.categories, ...n.listing.subCategories].join(' ') }),
      metal: lead?.metal ?? 'gold_unspecified',
      karat: lead?.karat ?? 0,
      price: priceOf('indicative') ?? priceOf('min_variant') ?? 0,
      caratWeight: lead?.diamondWeight ?? 0,
      description: n.listing.description,
      websiteCode: code,
      composition: composition as unknown,
    };
    if (webProduct) {
      productId = webProduct.id;
      const diff = diffFields(webProduct, fields, { price: sameNum, caratWeight: sameNum });
      changes.push(...Object.keys(diff).map((k) => `product.${k}`));
      await db.product.update({
        where: { id: productId },
        data: { ...(diff as Prisma.ProductUpdateInput), composition: (diff.composition ?? undefined) as Prisma.InputJsonValue | undefined, websiteSyncedAt: now },
      });
    } else {
      // The website code is the SKU unless a Gati row already holds it.
      const skuTaken = await db.product.findFirst({ where: { organisationId, sku: code }, select: { id: true } });
      const fresh = await db.product.create({
        data: {
          organisationId,
          legacyId: webLegacyId,
          sku: skuTaken ? webLegacyId : code,
          ...fields,
          category: fields.category as never,
          composition: (composition ?? undefined) as Prisma.InputJsonValue | undefined,
          websiteSyncedAt: now,
          availability: 'lead_time',
          storeId: null,
        },
        select: { id: true },
      });
      productId = fresh.id;
      created = true;
    }
  }

  // ── Listing (moves with the join) ───────────────────────────────────────
  const moved = await db.productWebsiteListing.findFirst({
    where: { organisationId, externalId: n.externalId, productId: { not: productId } },
    select: { productId: true },
  });
  if (moved) {
    await detachWebsite(db, organisationId, moved.productId, now);
    changes.push('listing.moved');
  }
  const listingFields = { externalId: n.externalId, productCode: code, ...n.listing, seo: n.listing.seo as unknown };
  const listing = await db.productWebsiteListing.findUnique({ where: { productId } });
  if (!listing) {
    await db.productWebsiteListing.create({
      data: { organisationId, productId, ...listingFields, seo: (n.listing.seo ?? undefined) as Prisma.InputJsonValue | undefined, lastSeenAt: now },
    });
    changes.push('listing.created');
  } else {
    const diff = diffFields(listing, listingFields, {
      categories: sameList,
      subCategories: sameList,
      features: sameList,
      tags: sameList,
      countries: sameList,
    });
    changes.push(...Object.keys(diff).map((k) => `listing.${k}`));
    if (listing.tombstonedAt) changes.push('listing.restored');
    await db.productWebsiteListing.update({
      where: { productId },
      data: { ...(diff as Prisma.ProductWebsiteListingUpdateInput), seo: (diff.seo ?? undefined) as Prisma.InputJsonValue | undefined, lastSeenAt: now, tombstonedAt: null },
    });
  }

  // ── Variants ─────────────────────────────────────────────────────────────
  const oldVariants = await db.productVariant.findMany({ where: { productId, source: WEBSITE } });
  const variantId = new Map<string, string>();
  let vAdded = 0;
  let vChanged = 0;
  for (const v of n.variants) {
    const data = {
      sku: v.sku,
      metalType: v.metalType,
      karat: v.karat,
      metal: v.metal,
      diamondType: v.diamondType,
      colour: v.colour,
      weightType: v.weightType,
      goldWeight: v.goldWeight,
      diamondWeight: v.diamondWeight,
      stoneWeight: v.stoneWeight,
      totalWeight: v.totalWeight,
      price: v.price,
      priceWithMargin: v.priceWithMargin,
      marginPercentage: v.marginPercentage,
      makingCharge: v.makingCharge,
      currency: v.currency,
      bom: v.bom as unknown,
      attributes: v.attributes as unknown,
      status: 'active',
      tombstonedAt: null as Date | null,
    };
    const old = oldVariants.find((o) => o.sourceKey === v.sourceKey);
    if (!old) {
      const row = await db.productVariant.create({
        data: { ...data, organisationId, productId, source: WEBSITE, sourceKey: v.sourceKey, bom: v.bom as unknown as Prisma.InputJsonValue, attributes: v.attributes as Prisma.InputJsonValue },
        select: { id: true },
      });
      variantId.set(v.sourceKey, row.id);
      vAdded++;
      continue;
    }
    variantId.set(v.sourceKey, old.id);
    const num = { goldWeight: sameNum, diamondWeight: sameNum, stoneWeight: sameNum, totalWeight: sameNum, price: sameNum, priceWithMargin: sameNum, marginPercentage: sameNum, makingCharge: sameNum };
    const diff = diffFields(old, data, num);
    if (Object.keys(diff).length) {
      await db.productVariant.update({
        where: { id: old.id },
        data: { ...(diff as Prisma.ProductVariantUpdateInput), bom: (diff.bom ?? undefined) as Prisma.InputJsonValue | undefined, attributes: (diff.attributes ?? undefined) as Prisma.InputJsonValue | undefined },
      });
      vChanged++;
    }
  }
  if (vAdded) changes.push(`variants +${vAdded}`);
  if (vChanged) changes.push(`variants ~${vChanged}`);

  // ── Sizes ────────────────────────────────────────────────────────────────
  const oldOptions = await db.productOption.findMany({ where: { productId, source: WEBSITE, kind: 'size' } });
  let oAdded = 0;
  for (const [i, value] of n.sizes.entries()) {
    const old = oldOptions.find((o) => o.value === value);
    if (!old) {
      await db.productOption.create({ data: { organisationId, productId, source: WEBSITE, kind: 'size', value, sortOrder: i } });
      oAdded++;
    } else if (old.sortOrder !== i || old.tombstonedAt) {
      await db.productOption.update({ where: { id: old.id }, data: { sortOrder: i, tombstonedAt: null } });
    }
  }
  if (oAdded) changes.push(`sizes +${oAdded}`);

  // ── Prices, each labelled ────────────────────────────────────────────────
  const oldPrices = await db.productPrice.findMany({ where: { productId, source: WEBSITE } });
  let pChanged = 0;
  for (const pr of n.prices) {
    const vk = pr.variantKey ? (variantId.get(pr.variantKey) ?? '') : '';
    const old = oldPrices.find((o) => o.variantKey === vk && o.kind === pr.kind);
    if (old && sameNum(old.amount, pr.amount) && old.currency === pr.currency) continue;
    await db.productPrice.upsert({
      where: { productId_variantKey_source_kind: { productId, variantKey: vk, source: WEBSITE, kind: pr.kind } },
      create: { organisationId, productId, variantKey: vk, source: WEBSITE, kind: pr.kind, amount: pr.amount, currency: pr.currency, capturedAt: now },
      update: { amount: pr.amount, currency: pr.currency, capturedAt: now },
    });
    pChanged++;
  }
  if (pChanged) changes.push(`prices ~${pChanged}`);

  // ── Pictures: one row per URL (or per content hash), many placements ────
  const imgChanges = await writeImages(db, organisationId, productId, n, variantId, now);
  changes.push(...imgChanges.changes);

  // ── Conflicts: recorded, never resolved by guessing ─────────────────────
  for (const c of n.conflicts) await upsertConflict(db, organisationId, now, { ...c, productId, externalId: n.externalId });
  await autoResolve(db, organisationId, now, {
    externalId: n.externalId,
    kind: { in: ['spec_mismatch', 'unit_mismatch'] },
    key: { notIn: n.conflicts.map((c) => c.key) },
  });
  const mKey = matchKey(code);
  if (target.match === 'none') {
    await upsertConflict(db, organisationId, now, {
      kind: 'gati_match_none',
      key: mKey,
      productId,
      externalId: n.externalId,
      summary: `Website design ${code} matches no Gati design; kept as a website-only design.`,
      detail: { productCode: code, normalised: normaliseCode(code) },
    });
  } else if (target.match === 'ambiguous') {
    await upsertConflict(db, organisationId, now, {
      kind: 'gati_match_ambiguous',
      key: mKey,
      productId,
      externalId: n.externalId,
      summary: `Website design ${code} matches ${target.candidates.length} Gati designs; choose one to link.`,
      detail: { productCode: code, normalised: normaliseCode(code), candidates: target.candidates },
    });
  }
  if (target.match === 'gati' || target.match === 'linked') {
    await autoResolve(db, organisationId, now, { key: mKey, kind: 'gati_match_none' });
    if (target.match === 'gati') await autoResolve(db, organisationId, now, { key: mKey, kind: 'gati_match_ambiguous' });
  }

  // ── Snapshot: the payload verbatim, and where it went ──────────────────
  const snapData = {
    productCode: code,
    schemaVersion: WEBSITE_NORMALIZER_VERSION,
    payload: payload as Prisma.InputJsonValue,
    payloadHash: hash,
    sourceUpdatedAt: n.listing.sourceUpdatedAt,
    lastSeenAt: now,
    goneAt: null,
    syncRunId: ctx.runId,
    normalizationStatus: n.conflicts.length || target.match === 'ambiguous' ? 'conflict' : 'ok',
    normalizationError: null,
    productId,
  };
  await db.externalProductSnapshot.upsert({
    where: { organisationId_source_externalId: { organisationId, source: WEBSITE, externalId: n.externalId } },
    create: { organisationId, source: WEBSITE, externalId: n.externalId, ...snapData },
    update: snapData,
  });

  await applyImageOrder(db, productId);
  return {
    ...base,
    action: created || changes.includes('listing.created') ? 'created' : changes.length ? 'updated' : 'unchanged',
    productId,
    changes,
    conflicts: n.conflicts.length + matchConflicts,
    newImageIds: imgChanges.newImageIds,
  };
}

/** Record a payload the normaliser or the writer refused, so the run still "saw" it. */
export async function recordFailedSnapshot(
  db: Db,
  organisationId: string,
  ctx: PersistContext,
  payload: unknown,
  error: string,
): Promise<string> {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const code = typeof p.productCode === 'string' ? p.productCode.trim() : '';
  const externalId = String(p._id ?? p.id ?? code ?? '').trim() || `hash:${payloadHash(payload).slice(0, 32)}`;
  const data = {
    productCode: code || null,
    payload: (payload ?? null) as Prisma.InputJsonValue,
    payloadHash: payloadHash(payload),
    lastSeenAt: ctx.now,
    syncRunId: ctx.runId,
    normalizationStatus: 'error',
    normalizationError: error.slice(0, 500),
  };
  await db.externalProductSnapshot.upsert({
    where: { organisationId_source_externalId: { organisationId, source: WEBSITE, externalId } },
    create: { organisationId, source: WEBSITE, externalId, ...data },
    update: data,
  });
  await upsertConflict(db, organisationId, ctx.now, {
    kind: 'normalization_error',
    key: `website:${externalId}`,
    productId: null,
    externalId,
    summary: `Website product ${code || externalId} could not be imported: ${error.slice(0, 200)}`,
    detail: { error: error.slice(0, 500) },
  });
  return externalId;
}

async function writeImages(
  db: Db,
  organisationId: string,
  productId: string,
  n: NormalizedWebsiteProduct,
  variantId: Map<string, string>,
  now: Date,
): Promise<{ changes: string[]; newImageIds: string[] }> {
  const rows = await db.productImage.findMany({
    where: { productId },
    select: { id: true, url: true, source: true, sourceUrl: true, status: true, contentHash: true, sourceOrder: true, sourceImageId: true },
  });
  const newImageIds: string[] = [];
  let changed = 0;
  const urls = [...new Map(n.images.map((i) => [i.url, i])).values()];
  const idByUrl = new Map<string, string>();

  for (const img of urls) {
    // Adopt a picture the previous website import filed without provenance.
    const row =
      rows.find((r) => r.source === WEBSITE && r.sourceUrl === img.url) ??
      rows.find((r) => !r.sourceUrl && r.url === img.url && (r.source === 'other' || r.source === WEBSITE));
    if (!row) {
      const created = await db.productImage.create({
        data: {
          organisationId,
          productId,
          url: img.url,
          source: WEBSITE,
          sourceUrl: img.url,
          sourceImageId: img.sourceImageId,
          sourceOrder: img.globalOrder,
          contentHash: img.contentHash,
          angle: img.angle,
        },
        select: { id: true },
      });
      rows.push({ id: created.id, url: img.url, source: WEBSITE, sourceUrl: img.url, status: 'active', contentHash: img.contentHash, sourceOrder: img.globalOrder, sourceImageId: img.sourceImageId });
      idByUrl.set(img.url, created.id);
      newImageIds.push(created.id);
      changed++;
      continue;
    }
    idByUrl.set(img.url, row.id);
    // A picture tombstoned as a byte-identical duplicate stays merged.
    const hashTwin =
      row.contentHash && rows.find((r) => r.id !== row.id && r.source === WEBSITE && r.status === 'active' && r.contentHash === row.contentHash);
    const revive = row.status === 'tombstoned' && !hashTwin;
    const data: Prisma.ProductImageUpdateInput = {};
    if (row.source !== WEBSITE) data.source = WEBSITE;
    if (row.sourceUrl !== img.url) data.sourceUrl = img.url;
    if (row.sourceOrder !== img.globalOrder) data.sourceOrder = img.globalOrder;
    if (img.sourceImageId && row.sourceImageId !== img.sourceImageId) data.sourceImageId = img.sourceImageId;
    if (img.contentHash && row.contentHash !== img.contentHash) data.contentHash = img.contentHash;
    if (revive) Object.assign(data, { status: 'active', tombstonedAt: null });
    if (Object.keys(data).length) {
      await db.productImage.update({ where: { id: row.id }, data });
      Object.assign(row, { source: WEBSITE, sourceUrl: img.url, sourceOrder: img.globalOrder, status: revive ? 'active' : row.status, contentHash: img.contentHash ?? row.contentHash });
      changed++;
      if (revive) newImageIds.push(row.id);
    }
  }

  // Same bytes under different URLs are one picture: keep the earliest, move
  // the placements onto it, tombstone the rest.
  const keeperOf = new Map<string, string>();
  const byHash = new Map<string, typeof rows>();
  for (const r of rows.filter((x) => x.source === WEBSITE && x.contentHash && x.status === 'active')) {
    byHash.set(r.contentHash!, [...(byHash.get(r.contentHash!) ?? []), r]);
  }
  for (const group of byHash.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.sourceOrder - b.sourceOrder || a.id.localeCompare(b.id));
    for (const dup of group.slice(1)) {
      keeperOf.set(dup.id, group[0].id);
      await db.productImage.update({ where: { id: dup.id }, data: { status: 'tombstoned', tombstonedAt: now } });
      await db.productImageAssociation.deleteMany({ where: { imageId: dup.id } });
      dup.status = 'tombstoned';
      changed++;
    }
  }
  for (const r of rows) {
    if (r.status === 'tombstoned' && r.contentHash) {
      const keeper = rows.find((k) => k.source === WEBSITE && k.status === 'active' && k.contentHash === r.contentHash && k.id !== r.id);
      if (keeper) keeperOf.set(r.id, keeper.id);
    }
  }
  const imageFor = (url: string) => {
    const id = idByUrl.get(url)!;
    return keeperOf.get(id) ?? id;
  };

  // Placements: colour group × shape × position.
  const imageIds = [...new Set(urls.map((u) => imageFor(u.url)))];
  const oldAssoc = await db.productImageAssociation.findMany({ where: { imageId: { in: imageIds }, source: WEBSITE } });
  let aChanged = 0;
  for (const img of n.images) {
    const imageId = imageFor(img.url);
    const vId = img.variantKey ? (variantId.get(img.variantKey) ?? null) : null;
    const old = oldAssoc.find((a) => a.imageId === imageId && a.colour === img.colour && a.shape === img.shape && a.sourceOrder === img.order);
    if (old && old.variantId === vId && old.angle === img.angle && !old.tombstonedAt) continue;
    await db.productImageAssociation.upsert({
      where: { imageId_source_colour_shape_sourceOrder: { imageId, source: WEBSITE, colour: img.colour, shape: img.shape, sourceOrder: img.order } },
      create: { organisationId, imageId, source: WEBSITE, colour: img.colour, shape: img.shape, sourceOrder: img.order, variantId: vId, angle: img.angle },
      update: { variantId: vId, angle: img.angle, tombstonedAt: null },
    });
    aChanged++;
  }
  const changes: string[] = [];
  if (newImageIds.length) changes.push(`images +${newImageIds.length}`);
  if (changed - newImageIds.length > 0) changes.push(`images ~${changed - newImageIds.length}`);
  if (aChanged) changes.push(`placements ~${aChanged}`);
  return { changes, newImageIds };
}

export interface RemovalCounts {
  imageIds: string[];
  variants: number;
  sizes: number;
  prices: number;
  images: number;
  placements: number;
}

/**
 * After a COMPLETE run: whatever the source no longer publishes for a design it
 * still carries — a variant, a size, a price, a picture, a placement — is
 * tombstoned (prices, which are values rather than records, are removed).
 */
export async function reconcileRemovals(
  db: Db,
  productId: string,
  n: NormalizedWebsiteProduct,
  now: Date,
): Promise<RemovalCounts> {
  const counts: RemovalCounts = { imageIds: [], variants: 0, sizes: 0, prices: 0, images: 0, placements: 0 };
  const variants = await db.productVariant.findMany({ where: { productId, source: WEBSITE }, select: { id: true, sourceKey: true, status: true } });
  const keep = new Set(n.variants.map((v) => v.sourceKey));
  const gone = variants.filter((v) => !keep.has(v.sourceKey) && v.status !== 'tombstoned').map((v) => v.id);
  if (gone.length) {
    counts.variants = (await db.productVariant.updateMany({ where: { id: { in: gone } }, data: { status: 'tombstoned', tombstonedAt: now } })).count;
  }
  counts.sizes = (
    await db.productOption.updateMany({
      where: { productId, source: WEBSITE, kind: 'size', tombstonedAt: null, value: { notIn: n.sizes } },
      data: { tombstonedAt: now },
    })
  ).count;
  const idOf = new Map(variants.map((v) => [v.sourceKey, v.id]));
  const livePrices = new Set(n.prices.map((p) => `${p.variantKey ? (idOf.get(p.variantKey) ?? '?') : ''}|${p.kind}`));
  const prices = await db.productPrice.findMany({ where: { productId, source: WEBSITE }, select: { id: true, variantKey: true, kind: true } });
  const stalePrices = prices.filter((p) => !livePrices.has(`${p.variantKey}|${p.kind}`)).map((p) => p.id);
  if (stalePrices.length) counts.prices = (await db.productPrice.deleteMany({ where: { id: { in: stalePrices } } })).count;

  const urls = new Set(n.images.map((i) => i.url));
  const images = await db.productImage.findMany({
    where: { productId, source: WEBSITE },
    select: { id: true, sourceUrl: true, status: true, contentHash: true },
  });
  const staleImages = images.filter((i) => i.status === 'active' && !(i.sourceUrl && urls.has(i.sourceUrl))).map((i) => i.id);
  if (staleImages.length) {
    counts.imageIds = staleImages;
    counts.images = (await db.productImage.updateMany({ where: { id: { in: staleImages } }, data: { status: 'tombstoned', tombstonedAt: now } })).count;
  }
  // Placement → the picture it should point at (URL, or its hash keeper).
  const active = images.filter((i) => i.status === 'active' && !staleImages.includes(i.id));
  const idForUrl = (url: string) => {
    const row = images.find((i) => i.sourceUrl === url);
    if (!row) return null;
    if (row.status === 'active' && !staleImages.includes(row.id)) return row.id;
    return active.find((k) => row.contentHash && k.contentHash === row.contentHash)?.id ?? null;
  };
  const wanted = new Set(n.images.map((i) => `${idForUrl(i.url)}|${i.colour}|${i.shape}|${i.order}`));
  const assocs = await db.productImageAssociation.findMany({
    where: { image: { productId }, source: WEBSITE, tombstonedAt: null },
    select: { id: true, imageId: true, colour: true, shape: true, sourceOrder: true },
  });
  const staleAssoc = assocs.filter((a) => !wanted.has(`${a.imageId}|${a.colour}|${a.shape}|${a.sourceOrder}`)).map((a) => a.id);
  if (staleAssoc.length) {
    counts.placements = (await db.productImageAssociation.updateMany({ where: { id: { in: staleAssoc } }, data: { tombstonedAt: now } })).count;
  }
  if (counts.images) await applyImageOrder(db, productId);
  return counts;
}

/** After a COMPLETE run: a design the website no longer lists at all. */
export async function tombstoneGone(db: Db, snapshotId: string, productId: string | null, now: Date): Promise<number> {
  await db.externalProductSnapshot.update({ where: { id: snapshotId }, data: { goneAt: now } });
  if (!productId) return 0;
  await db.productWebsiteListing.updateMany({ where: { productId, tombstonedAt: null }, data: { tombstonedAt: now, isActive: false } });
  await db.productVariant.updateMany({ where: { productId, source: WEBSITE, status: 'active' }, data: { status: 'tombstoned', tombstonedAt: now } });
  await db.productOption.updateMany({ where: { productId, source: WEBSITE, tombstonedAt: null }, data: { tombstonedAt: now } });
  const images = await db.productImage.updateMany({ where: { productId, source: WEBSITE, status: 'active' }, data: { status: 'tombstoned', tombstonedAt: now } });
  await db.productImageAssociation.updateMany({ where: { image: { productId }, source: WEBSITE, tombstonedAt: null }, data: { tombstonedAt: now } });
  if (images.count) await applyImageOrder(db, productId);
  return 1;
}
