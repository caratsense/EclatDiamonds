/**
 * CaratOS integration contracts — CANONICAL MODEL.
 *
 * Source-agnostic shapes that a Gati/Tally/BUSY/Excel/… connector maps INTO.
 * These are contracts only — the existing Prisma models stay the persistence
 * layer; canonical types are what connectors produce and the mapping engine
 * validates before an upsert. The core app depends on these, never on a source
 * system's structures.
 *
 * Rules encoded here:
 *  - purity/metal is OPTIONAL and may be 'unspecified' — never invent it.
 *  - money/weight fields are optional; a missing value stays missing (no 0 fill).
 *  - every entity carries a `Provenance` envelope (organisation + source).
 */

import type { Provenance } from './provenance';

/** Base every canonical entity extends: provenance + a canonical id (assigned by CaratOS). */
export interface CanonicalBase {
  /** CaratOS id once persisted; absent for a not-yet-imported preview row. */
  id?: string;
  provenance: Provenance;
}

/* ------------------------------------------------------------------ org / store */

export interface Organisation extends CanonicalBase {
  name: string;
  slug?: string;
  gstin?: string;
  legalName?: string;
}

export type StoreKind =
  | 'retail'
  | 'head_office'
  | 'warehouse'
  | 'manufacturing'
  | 'online';

export interface Store extends CanonicalBase {
  name: string;
  city?: string;
  code?: string;
  kinds?: StoreKind[];
  gstin?: string;
  timezone?: string;
}

/* ------------------------------------------------------------------ people */

export interface CanonicalStaff extends CanonicalBase {
  name: string;
  phone?: string;
  email?: string;
  designation?: string;
  employeeCode?: string;
  joiningDate?: string;
  /** Store assignments — canonical ids or source-store refs resolved at map time. */
  storeIds?: string[];
  status?: 'active' | 'inactive';
}

export interface CanonicalCustomer extends CanonicalBase {
  name: string;
  phone?: string;
  email?: string;
  gstin?: string;
  city?: string;
  birthday?: string;
  anniversary?: string;
}

/* ------------------------------------------------------------------ catalogue / stock */

/** Purity is optional; 'unspecified' is a first-class value — never guessed. */
export type CanonicalMetal =
  | 'gold_24k'
  | 'gold_22k'
  | 'gold_20k'
  | 'gold_18k'
  | 'gold_14k'
  | 'gold_9k'
  | 'silver'
  | 'platinum'
  | 'other'
  | 'unspecified';

export interface CanonicalProduct extends CanonicalBase {
  sku?: string;
  name?: string;
  category?: string;
  subcategory?: string;
  collection?: string;
  metal?: CanonicalMetal;
  /** Original non-jewellery material wording (steel, cotton, medicine, etc.). */
  materialLabel?: string;
  unitOfMeasure?: string;
  karat?: number;
  grossWeight?: number;
  netWeight?: number;
  stoneWeight?: number;
  diamondCount?: number;
  diamondCarat?: number;
  makingCharges?: number;
  stoneCharges?: number;
  metalRate?: number;
  cost?: number;
  mrp?: number;
  sellingPrice?: number;
  hallmark?: string;
  huid?: string;
  certification?: string;
  /** Media references resolved by the image pipeline; may be empty. */
  media?: CanonicalMedia[];
}

export type CanonicalStockStatus =
  | 'in_stock'
  | 'reserved'
  | 'sold'
  | 'transferred'
  | 'melted'
  | 'aging'
  | 'dead_stock'
  | 'unknown';

export interface CanonicalStockItem extends CanonicalBase {
  sku?: string;
  barcode?: string;
  huid?: string;
  productId?: string;
  grossWeight?: number;
  netWeight?: number;
  tagPrice?: number;
  status?: CanonicalStockStatus;
  /** Location/holding store — NEVER defaulted; unattributable => held UNASSIGNED. */
  storeId?: string;
}

export interface CanonicalStockMovement extends CanonicalBase {
  stockItemId?: string;
  fromStoreId?: string;
  toStoreId?: string;
  reason?: string;
  occurredAt?: string;
}

/* ------------------------------------------------------------------ sales / payments */

export interface CanonicalSaleLine {
  productId?: string;
  sku?: string;
  description?: string;
  quantity?: number;
  weight?: number;
  amount?: number;
}

export interface CanonicalSale extends CanonicalBase {
  docNumber?: string;
  docType?: 'sale' | 'estimate' | 'return' | 'exchange';
  customerId?: string;
  storeId?: string;
  docDate?: string;
  totalAmount?: number;
  lines?: CanonicalSaleLine[];
}

export type CanonicalPaymentMode =
  | 'cash'
  | 'card'
  | 'upi'
  | 'net_banking'
  | 'online'
  | 'cheque'
  | 'gold_exchange'
  | 'old_gold'
  | 'other';

export interface CanonicalPayment extends CanonicalBase {
  saleId?: string;
  customerId?: string;
  storeId?: string;
  mode?: CanonicalPaymentMode;
  amount?: number;
  paidAt?: string;
}

/* ------------------------------------------------------------------ orders / manufacturing */

export interface CanonicalOrderItem {
  productId?: string;
  description?: string;
  quantity?: number;
}

export interface CanonicalOrder extends CanonicalBase {
  orderNumber?: string;
  customerId?: string;
  storeId?: string;
  status?: string;
  items?: CanonicalOrderItem[];
}

export interface CanonicalManufacturingOrder extends CanonicalBase {
  reference?: string;
  storeId?: string;
  status?: string;
}

export interface CanonicalProductionBag extends CanonicalBase {
  bagNumber?: string;
  manufacturingOrderId?: string;
  status?: string;
}

/* ------------------------------------------------------------------ media */

export interface CanonicalMedia extends CanonicalBase {
  /** Where the bytes live once ingested (object-store key / URL). */
  storageKey?: string;
  /** Original source path/URL before ingestion — never fetched during discovery. */
  sourceLocation?: string;
  mimeType?: string;
  /** Content hash for dedupe. */
  sha256?: string;
  /** The record this image belongs to, matched by the image pipeline. */
  productId?: string;
  stockItemId?: string;
}
