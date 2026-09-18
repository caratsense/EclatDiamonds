import { createHash } from 'node:crypto';
import { MetalKind } from '@prisma/client';

import { karatToMetal, parseKarat } from '../metal';

/**
 * The website product payload → Eclat's lossless shape. PURE: no I/O, no clock,
 * no randomness, so the same payload always normalises to the same result and a
 * dry run, a resume and a replay all agree.
 *
 * Lossless means: every list, every variant, every price (labelled by what it
 * is), every picture in every colour group, every BOM line. Values are never
 * "corrected" — when the specification text and the bill of material disagree
 * the disagreement is returned as a conflict and both values stay as they were.
 * The raw payload itself is kept verbatim in ExternalProductSnapshot.
 */

/** Bump when the mapping changes, so an unchanged payload is re-persisted once. */
export const WEBSITE_NORMALIZER_VERSION = 1;

type Raw = Record<string, unknown>;

export interface NormalizedListing {
  marketingName: string;
  slug: string | null;
  categories: string[];
  subCategories: string[];
  features: string[];
  tags: string[];
  countries: string[];
  isActive: boolean;
  isDeleted: boolean;
  description: string | null;
  specifications: string | null;
  sizeGuide: string | null;
  seo: Raw | null;
  sourceCreatedAt: Date | null;
  sourceUpdatedAt: Date | null;
}

export interface NormalizedBomLine {
  rawMaterialId: string | null;
  materialName: string | null;
  weight: number | null;
  unit: string | null;
  quantity: number | null;
  rate: number | null;
  lineTotal: number | null;
  isDiamond: boolean;
  /** Everything else the source put on the line. */
  extra: Raw;
}

export interface NormalizedVariant {
  sourceKey: string;
  sku: string | null;
  metalType: string | null;
  karat: number | null;
  metal: MetalKind;
  diamondType: string | null;
  colour: string | null;
  weightType: string | null;
  goldWeight: number | null;
  diamondWeight: number | null;
  stoneWeight: number | null;
  totalWeight: number | null;
  price: number | null;
  priceWithMargin: number | null;
  marginPercentage: number | null;
  makingCharge: number | null;
  currency: string;
  bom: NormalizedBomLine[];
  /** Unmapped variant fields, verbatim. */
  attributes: Raw;
}

export interface NormalizedPrice {
  kind: 'indicative' | 'min_variant' | 'natural_diamond' | 'variant' | 'variant_with_margin';
  amount: number;
  /** The variant's sourceKey for variant prices, '' for product-level ones. */
  variantKey: string;
  currency: string;
}

/** One place a picture appears: colour group × shape × position. */
export interface NormalizedImage {
  url: string;
  colour: string;
  shape: string;
  /** Position inside its colour/shape group. */
  order: number;
  /** Position of the picture's first appearance across the whole product. */
  globalOrder: number;
  variantKey: string | null;
  sourceImageId: string | null;
  contentHash: string | null;
  angle: string | null;
}

export interface NormalizedConflict {
  kind: 'spec_mismatch' | 'unit_mismatch';
  key: string;
  summary: string;
  detail: Raw;
}

export interface NormalizedWebsiteProduct {
  externalId: string;
  productCode: string;
  listing: NormalizedListing;
  variants: NormalizedVariant[];
  sizes: string[];
  prices: NormalizedPrice[];
  images: NormalizedImage[];
  conflicts: NormalizedConflict[];
}

export class WebsiteNormalizationError extends Error {}

/** Stable hash of a payload: key order does not matter, values do. */
export function payloadHash(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Raw;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/** Website code / Gati style normalisation for the join: upper, no spaces - _ / . */
export function normaliseCode(code: unknown): string {
  return String(code ?? '')
    .toUpperCase()
    .replace(/[\s\-_/.]/g, '');
}

const text = (v: unknown): string | null => {
  if (v == null || typeof v === 'object') return null;
  const s = String(v).trim();
  return s ? s : null;
};

const num = (v: unknown): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
};

const date = (v: unknown): Date | null => {
  const s = text(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

const bool = (v: unknown, fallback: boolean): boolean =>
  typeof v === 'boolean' ? v : v == null ? fallback : /^(true|1|yes)$/i.test(String(v).trim());

/** `[{name}]`, `['x']`, `'x'` → trimmed names, source order, no repeats. */
function names(v: unknown): string[] {
  const list = Array.isArray(v) ? v : v == null ? [] : [v];
  const out: string[] = [];
  for (const item of list) {
    const n =
      item && typeof item === 'object'
        ? text((item as Raw).name ?? (item as Raw).label ?? (item as Raw).value ?? (item as Raw).code ?? (item as Raw).title)
        : text(item);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

function first(o: Raw, keys: string[]): unknown {
  for (const k of keys) if (o[k] != null && o[k] !== '') return o[k];
  return undefined;
}

const VARIANT_KEYS = new Set([
  '_id', 'id', 'sku', 'metalType', 'metal', 'karat', 'purity', 'diamondType', 'colour', 'color', 'weightType',
  'goldWeight', 'metalWeight', 'diamondWeight', 'caratWeight', 'stoneWeight', 'totalWeight', 'grossWeight',
  'price', 'priceWithMargin', 'marginPercentage', 'makingCharge', 'makingCharges', 'currency', 'billOfMaterial',
]);
const BOM_KEYS = new Set([
  'rawMaterialId', 'materialName', 'weight', 'unit', 'quantity', 'rate', '_lineTotal', 'lineTotal', '_isDiamond', 'isDiamond',
]);

function normaliseBom(v: unknown): NormalizedBomLine[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((m): m is Raw => !!m && typeof m === 'object')
    .map((m) => ({
      rawMaterialId: text(m.rawMaterialId),
      materialName: text(m.materialName),
      weight: num(m.weight),
      unit: text(m.unit),
      quantity: num(m.quantity),
      rate: num(m.rate),
      lineTotal: num(m._lineTotal ?? m.lineTotal),
      // The live feed has no diamond flag on a line; the material name says it.
      isDiamond: bool(m._isDiamond ?? m.isDiamond, /diamond|solitaire|lgd/i.test(String(m.materialName ?? ''))),
      extra: Object.fromEntries(Object.entries(m).filter(([k]) => !BOM_KEYS.has(k))),
    }));
}

function normaliseVariant(v: Raw): NormalizedVariant {
  const metalType = text(first(v, ['metalType', 'metal']));
  const karatRaw = first(v, ['karat', 'purity']);
  const karat = parseKarat(karatRaw);
  const diamondType = text(v.diamondType);
  const id = text(v._id ?? v.id);
  const bom = normaliseBom(v.billOfMaterial);
  // The live feed carries weights on the BOM lines, not the variant.
  const metalLine = bom.find((l) => !l.isDiamond && /gold|platinum|silver|metal/i.test(l.materialName ?? ''));
  const diamondLines = bom.filter((l) => l.isDiamond && l.weight != null);
  const diamondSum = diamondLines.length ? Math.round(diamondLines.reduce((s, l) => s + l.weight!, 0) * 1000) / 1000 : null;
  return {
    // No variant id in the live feed: metal|karat|diamond, normalised like codes.
    sourceKey: id ?? [metalType, text(karatRaw), diamondType].map((s) => normaliseCode(s ?? '')).join('|'),
    sku: text(v.sku),
    metalType,
    karat,
    metal: karatToMetal(metalType, karatRaw),
    diamondType,
    colour: text(first(v, ['colour', 'color'])),
    weightType: text(v.weightType),
    goldWeight: num(first(v, ['goldWeight', 'metalWeight'])) ?? metalLine?.weight ?? null,
    diamondWeight: num(first(v, ['diamondWeight', 'caratWeight'])) ?? diamondSum,
    stoneWeight: num(v.stoneWeight),
    totalWeight: num(first(v, ['totalWeight', 'grossWeight'])),
    price: num(v.price),
    priceWithMargin: num(v.priceWithMargin),
    marginPercentage: num(v.marginPercentage),
    makingCharge: num(first(v, ['makingCharge', 'makingCharges'])),
    currency: text(v.currency) ?? 'INR',
    bom,
    attributes: Object.fromEntries(Object.entries(v).filter(([k]) => !VARIANT_KEYS.has(k))),
  };
}

function imageRef(img: unknown): { url: string; id: string | null; hash: string | null; angle: string | null } | null {
  const o = img && typeof img === 'object' ? (img as Raw) : null;
  const url = text(o ? first(o, ['url', 'src', 'image', 'imageUrl']) : img);
  if (!url || !/^https?:\/\//i.test(url)) return null;
  return {
    url,
    id: o ? text(o._id ?? o.id) : null,
    hash: o ? text(o.contentHash ?? o.sha256) : null,
    angle: o ? text(o.angle ?? o.view) : null,
  };
}

function normaliseImages(p: Raw): NormalizedImage[] {
  const out: NormalizedImage[] = [];
  const firstSeen = new Map<string, number>();
  const push = (colour: string, shape: string, list: unknown, variantKey: string | null) => {
    if (!Array.isArray(list)) return;
    let order = 0;
    for (const img of list) {
      const ref = imageRef(img);
      if (!ref) continue;
      // The same picture twice in one group is one placement.
      if (out.some((o) => o.url === ref.url && o.colour === colour && o.shape === shape)) continue;
      if (!firstSeen.has(ref.url)) firstSeen.set(ref.url, firstSeen.size);
      out.push({
        url: ref.url,
        colour,
        shape,
        order: order++,
        globalOrder: firstSeen.get(ref.url)!,
        variantKey,
        sourceImageId: ref.id,
        contentHash: ref.hash,
        angle: ref.angle,
      });
    }
  };
  const groups = Array.isArray(p.variantType) ? p.variantType : [];
  for (const g of groups) {
    if (!g || typeof g !== 'object') continue;
    const vt = g as Raw;
    const colour = text(first(vt, ['color', 'colour', 'name', 'metalColor', 'metalColour', 'type'])) ?? '';
    const variantKey = text(vt.variantId);
    for (const s of Array.isArray(vt.shapes) ? vt.shapes : []) {
      if (!s || typeof s !== 'object') continue;
      const shape = text(first(s as Raw, ['name', 'shape', 'type'])) ?? '';
      push(colour, shape, (s as Raw).images, variantKey);
    }
    push(colour, text(vt.shape) ?? '', vt.images, variantKey);
  }
  push('', '', p.images, null);
  return out;
}

function normalisePrices(p: Raw, variants: NormalizedVariant[]): NormalizedPrice[] {
  const out: NormalizedPrice[] = [];
  const currency = text(p.currency) ?? 'INR';
  const add = (kind: NormalizedPrice['kind'], v: unknown, variantKey: string, cur = currency) => {
    const amount = num(v);
    // A zero is the feed saying "no price", not a free ring.
    if (amount != null && amount > 0) out.push({ kind, amount, variantKey, currency: cur });
  };
  add('indicative', p.indicativePrice, '');
  add('min_variant', p.minVariantPrice, '');
  add('natural_diamond', p.naturalDiamondPrice, '');
  for (const v of variants) {
    add('variant', v.price, v.sourceKey, v.currency);
    add('variant_with_margin', v.priceWithMargin, v.sourceKey, v.currency);
  }
  return out;
}

/**
 * Where the customer-facing specification text disagrees with the structured
 * data. The text is split into clauses; a clause naming one karat and a gram
 * weight is compared with that karat's metal line; a clause stating carats is
 * compared with the diamond lines, and a diamond line measured in grams while
 * the text says carats is a unit mismatch. Nothing is corrected.
 */
function specConflicts(externalId: string, spec: string | null, variants: NormalizedVariant[]): NormalizedConflict[] {
  if (!spec) return [];
  const out: NormalizedConflict[] = [];
  const clauses = spec.split(/\r?\n|[;|]/).map((c) => c.trim()).filter(Boolean);
  const GRAMS = /(\d+(?:\.\d+)?)\s*(?:g|gm|gms|gram|grams)\b/i;
  const CARATS = /(\d+(?:\.\d+)?)\s*(?:ct|cts|carat|carats)\b/i;
  const KARAT = /\b(\d{1,2})\s*(?:kt|k|karat)\b/gi;
  let specSaysCarats = false;
  for (const clause of clauses) {
    const karats = [...clause.matchAll(KARAT)].map((m) => Number(m[1]));
    const grams = GRAMS.exec(clause);
    if (grams && new Set(karats).size === 1) {
      const specWeight = Number(grams[1]);
      for (const v of variants.filter((x) => x.karat === karats[0])) {
        const metalLine = v.bom.find((l) => !l.isDiamond && /gold|platinum|silver|metal/i.test(l.materialName ?? ''));
        const bomWeight = metalLine?.weight ?? v.goldWeight;
        if (bomWeight != null && Math.abs(bomWeight - specWeight) > 0.005) {
          out.push({
            kind: 'spec_mismatch',
            key: `${externalId}:spec_mismatch:${v.sourceKey}:metal_weight`,
            summary: `Specification says ${specWeight} g for ${karats[0]}KT; the bill of material says ${bomWeight} g.`,
            detail: { field: 'metal_weight', karat: karats[0], variantKey: v.sourceKey, spec: specWeight, bom: bomWeight, specText: clause },
          });
        }
      }
    }
    const carats = CARATS.exec(clause);
    if (carats) {
      specSaysCarats = true;
      const specCt = Number(carats[1]);
      for (const v of variants) {
        const bomCt = v.bom.filter((l) => l.isDiamond).reduce((s, l) => s + (l.weight ?? 0), 0) || v.diamondWeight;
        if (bomCt != null && Math.abs(bomCt - specCt) > 0.005) {
          out.push({
            kind: 'spec_mismatch',
            key: `${externalId}:spec_mismatch:${v.sourceKey}:diamond_weight`,
            summary: `Specification says ${specCt} ct of diamond; the bill of material says ${bomCt}.`,
            detail: { field: 'diamond_weight', variantKey: v.sourceKey, spec: specCt, bom: bomCt, specText: clause },
          });
        }
      }
    }
  }
  if (specSaysCarats) {
    const gramLines = variants.flatMap((v) =>
      v.bom
        .filter((l) => l.isDiamond && /^(g|gm|gms|gram|grams)$/i.test(l.unit ?? ''))
        .map((l) => ({ variantKey: v.sourceKey, materialName: l.materialName, weight: l.weight, unit: l.unit })),
    );
    if (gramLines.length) {
      out.push({
        kind: 'unit_mismatch',
        key: `${externalId}:unit_mismatch:diamond_unit`,
        summary: `Specification states diamond weight in carats; ${gramLines.length} bill-of-material diamond line(s) say "${gramLines[0].unit}".`,
        detail: { field: 'diamond_unit', spec: 'ct', lines: gramLines },
      });
    }
  }
  return out;
}

/** SEO: the live feed's top-level metaTitle/metaDescription/metaKeywords, else a `seo` object. */
function seoOf(p: Raw): Raw | null {
  const top = Object.fromEntries(
    (['metaTitle', 'metaDescription', 'metaKeywords'] as const).filter((k) => p[k] != null && p[k] !== '').map((k) => [k, p[k]]),
  );
  const nested = p.seo && typeof p.seo === 'object' && !Array.isArray(p.seo) ? (p.seo as Raw) : {};
  const seo = { ...nested, ...top };
  return Object.keys(seo).length ? seo : null;
}

export function normalizeWebsiteProduct(payload: unknown): NormalizedWebsiteProduct {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new WebsiteNormalizationError('product payload is not an object');
  }
  const p = payload as Raw;
  const productCode = text(p.productCode);
  if (!productCode) throw new WebsiteNormalizationError('product has no productCode');
  const externalId = text(p._id ?? p.id) ?? productCode;

  const variants = (Array.isArray(p.variants) ? p.variants : [])
    .filter((v): v is Raw => !!v && typeof v === 'object')
    .map(normaliseVariant);
  // Two variants the source failed to tell apart keep both, suffixed in order.
  const seen = new Map<string, number>();
  for (const v of variants) {
    const n = seen.get(v.sourceKey) ?? 0;
    seen.set(v.sourceKey, n + 1);
    if (n) v.sourceKey = `${v.sourceKey}#${n + 1}`;
  }

  const specifications = text(p.specifications ?? p.specification);
  const listing: NormalizedListing = {
    marketingName: text(p.name) ?? productCode,
    slug: text(p.slug),
    categories: names(p.category ?? p.categories),
    subCategories: names(p.subCategory ?? p.subCategories),
    features: names(p.feature ?? p.features),
    tags: names(p.tags ?? p.tag),
    countries: names(p.countries ?? p.country),
    isActive: bool(p.isActive ?? p.active ?? p.isPublished, true),
    isDeleted: bool(p.isDeleted ?? p.deleted, false),
    description: text(p.description),
    specifications,
    sizeGuide: text(p.sizeGuide),
    seo: seoOf(p),
    sourceCreatedAt: date(p.createdAt),
    sourceUpdatedAt: date(p.updatedAt),
  };

  return {
    externalId,
    productCode,
    listing,
    variants,
    sizes: names(p.size ?? p.sizes),
    prices: normalisePrices(p, variants),
    images: normaliseImages(p),
    conflicts: specConflicts(externalId, specifications, variants),
  };
}
