/**
 * CaratOS integration contracts — DISCOVERY, SYNC & RECONCILIATION REPORTS.
 *
 * Contracts only. Every discovery/import/sync must produce these so no records are
 * ever silently skipped. "sync successful" is never reported when records were
 * skipped/failed/unmapped without an accounting.
 */

/** The independently-importable entity categories. Each import is optional. */
export type EntityKind =
  | 'customers'
  | 'products'
  | 'stock'
  | 'sales'
  | 'payments'
  | 'staff'
  | 'suppliers'
  | 'orders'
  | 'manufacturing'
  | 'images';

/** Per-record failure/hold, surfaced so every non-imported record is visible. */
export interface RecordIssue {
  entity: EntityKind;
  /** Source id if known, else a stable row locator. */
  externalId?: string;
  reason: string;
  /** Machine code for grouping: 'duplicate' | 'unmapped' | 'missing_store' | … */
  code:
    | 'duplicate'
    | 'unmapped'
    | 'missing_store'
    | 'missing_purity'
    | 'invalid_phone'
    | 'invalid_gstin'
    | 'invalid_price'
    | 'negative_weight'
    | 'needs_review'
    | 'transform_error'
    | 'validation_error'
    | 'unassigned';
}

/** Counts that must reconcile: discovered === imported+updated+skipped+failed+held. */
export interface SyncCounts {
  discovered: number;
  imported: number;
  updated: number;
  skipped: number;
  failed: number;
  duplicated: number;
  unmapped: number;
  missingStore: number;
  needsReview: number;
}

/**
 * Read-only discovery output produced BEFORE any write. Powers the pre-import
 * report ("Products 8,421 · Potential duplicates 417 · Missing store 12 · …").
 */
export interface DiscoveryReport {
  organisationId: string;
  perEntity: Partial<Record<EntityKind, number>>;
  issues: RecordIssue[];
  /** True when the report is a bounded sample, not the whole source. */
  sampled: boolean;
  sampleLimit?: number;
}

/** Result of an actual (sample or full) sync — includes the reconciliation. */
export interface ReconciliationReport {
  organisationId: string;
  entity: EntityKind;
  counts: SyncCounts;
  issues: RecordIssue[];
  /** Was this a dry run (no writes performed)? */
  dryRun: boolean;
  startedAt?: string;
  finishedAt?: string;
}

/** Bounded-run controls available where technically applicable. */
export interface SyncOptions {
  sample?: boolean;
  limit?: number;
  storeId?: string;
  entity?: EntityKind;
  dryRun?: boolean;
  /** Incremental watermark to resume from; absent => initial import. */
  since?: string;
}
