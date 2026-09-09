/**
 * CaratOS integration contracts — PROVENANCE & SOURCE OWNERSHIP.
 *
 * Contracts only: these are TypeScript types that describe the shape connectors
 * produce and the mapping/sync engine validates against. Nothing here is a Nest
 * provider or touches the request path — the existing Prisma models remain the
 * runtime persistence. This file exists so core business logic can depend on a
 * source-agnostic envelope instead of Gati-specific structures.
 *
 * Do NOT invent Gati/Tally/BUSY field mappings here. Unknown source => the record
 * carries `sourceSystem` + `externalId` and the mapping stays explicit.
 */

/** Every system a canonical record can originate from. `manual` = entered in CaratOS. */
export type SourceSystem =
  | 'gati'
  | 'tally'
  | 'busy'
  | 'excel'
  | 'csv'
  | 'xml'
  | 'json'
  | 'odbc'
  | 'sqlserver'
  | 'mysql'
  | 'postgres'
  | 'api'
  | 'manual';

/**
 * Pointer back to the exact source record a canonical row was derived from.
 * Mirrors the existing `legacyId`/`legacyUpdatedAt` pattern but is multi-source:
 * a canonical record may accumulate several `SourceRef`s (e.g. Gati stock + Tally
 * ledger) rather than a single `legacyId`.
 */
export interface SourceRef {
  sourceSystem: SourceSystem;
  /** Stable id in the source (Gati JewelId, Tally GUID, Excel row key, …). */
  externalId: string;
  /** Optional finer-grained origin, when known — never guessed. */
  sourceTable?: string;
  sourceField?: string;
  /** 0–1 confidence that this mapping is correct; < 1 => surface for confirmation. */
  confidence?: number;
}

/** Who currently owns a field's value — decides whether a sync may overwrite it. */
export type FieldOwnership =
  | 'SOURCE_OWNED' // the external system is authoritative; sync may update.
  | 'CARATOS_OWNED' // CaratOS operational decision; sync must NOT overwrite.
  | 'CONFLICT' // source and CaratOS disagree; needs reconciliation, no auto-write.
  | 'UNKNOWN'; // ownership not yet classified; treat as no-auto-write.

/**
 * Field-level source-of-truth policy. Generalises the existing Module-9 rule
 * (post-transfer `stock.storeId` becomes CaratOS-owned and is protected from Gati
 * overwrite) into a reusable, per-entity/per-field policy.
 *
 * A sync engine consults `ownershipOf(entity, field, record)` before writing and
 * skips anything that is not `SOURCE_OWNED`.
 */
export interface SourceOwnershipPolicy {
  ownershipOf(entity: string, field: string, context?: OwnershipContext): FieldOwnership;
}

/** Minimal context a policy may need — kept generic, no Gati specifics. */
export interface OwnershipContext {
  /** e.g. a stock item whose transfer lifecycle flips storeId to CaratOS-owned. */
  lifecycleState?: string;
  organisationId?: string;
  storeId?: string;
}

/** Sync/audit metadata carried alongside an imported record. */
export interface SyncMeta {
  syncedAt?: string;
  /** Incremental watermark this record was seen at (source-defined). */
  watermark?: string;
  /** Import/sync batch this record belonged to. */
  batchId?: string;
}

/**
 * The envelope every externally-sourced canonical record carries. Tenant/store
 * attribution is REQUIRED at the organisation level; `storeId` is optional
 * because some entities (e.g. company-wide product designs) are org-scoped, not
 * store-scoped. Attribution is never guessed — an unattributable record is held
 * as UNASSIGNED for reconciliation, not defaulted to a store.
 */
export interface Provenance {
  organisationId: string;
  storeId?: string;
  /** One or more source pointers. Empty only for `sourceSystem: 'manual'`. */
  sources: SourceRef[];
  sync?: SyncMeta;
  createdAt?: string;
  updatedAt?: string;
}
