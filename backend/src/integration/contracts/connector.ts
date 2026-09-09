/**
 * CaratOS integration contracts — CONNECTOR INTERFACE.
 *
 * The single abstraction the core app depends on instead of Gati/Tally/BUSY code.
 * Contracts only: no implementation lives here. The existing `sync/` Gati logic
 * remains behind its specialised adapter. Tally/BUSY/other ODBC sources use the
 * profile-driven outbound agent for universal master data; transaction mappings
 * stay blocked until reconciled against each real installation.
 *
 * Lifecycle:  discover → inspect → preview → extract → transform
 *                     → validate → reconcile → sync
 */

import type { EntityKind, DiscoveryReport, ReconciliationReport, SyncOptions } from './sync-result';
import type { ImportSource, ImportPreview, ImportProfile } from './import-profile';
import type { SourceSystem } from './provenance';
import type { CanonicalBase } from './canonical';

/** Which entities a connector can move — lets an org mix sources per entity. */
export interface ConnectorCapabilities {
  supportsCustomers: boolean;
  supportsProducts: boolean;
  supportsStock: boolean;
  supportsSales: boolean;
  supportsPayments: boolean;
  supportsStaff: boolean;
  supportsManufacturing: boolean;
  supportsImages: boolean;
  supportsOrders: boolean;
  /** True when the source can be polled incrementally (watermark), not full-only. */
  supportsIncremental: boolean;
}

/** Per-connector runtime status for the observability board. */
export type ConnectorStatus =
  | 'connected'
  | 'needs_attention'
  | 'failed'
  | 'not_configured';

export interface ConnectorHealth {
  status: ConnectorStatus;
  lastSuccessfulSyncAt?: string;
  lastAttemptedSyncAt?: string;
  lastError?: string;
  watermark?: string;
}

/**
 * A source connector. Every method is read-oriented against the customer's data;
 * a connector MUST NOT modify the customer's source system. Credentials are held
 * server-side / in the local agent and never surface to the frontend.
 */
export interface IntegrationConnector {
  readonly sourceSystem: SourceSystem;
  readonly capabilities: ConnectorCapabilities;

  /** Probe connectivity + return current health. No writes. */
  discover(): Promise<ConnectorHealth>;

  /** Enumerate the tables/files/endpoints and their columns. Read-only. */
  inspect(): Promise<ImportSource[]>;

  /** Dry-run a mapping profile against a bounded sample; no writes. */
  preview(entity: EntityKind, profile: ImportProfile): Promise<ImportPreview>;

  /**
   * Read raw source records for an entity (bounded by options). Returns
   * source-shaped rows — transform() maps them to canonical.
   */
  extract(entity: EntityKind, options?: SyncOptions): Promise<unknown[]>;

  /** Map source rows → canonical entities using a profile. Pure; no writes. */
  transform(entity: EntityKind, rows: unknown[], profile: ImportProfile): Promise<CanonicalBase[]>;

  /** Validate canonical rows (phone/GSTIN/purity/store attribution). No writes. */
  validate(entity: EntityKind, rows: CanonicalBase[]): Promise<ImportPreview>;

  /** Read-only count/diff of source vs CaratOS for an entity — the discovery report. */
  reconcile(options?: SyncOptions): Promise<DiscoveryReport>;

  /**
   * Perform the sync (sample or full). Honours dryRun. Idempotent + resumable via
   * the watermark in options. Returns a full reconciliation with per-record issues.
   * Never overwrites CARATOS_OWNED fields (see SourceOwnershipPolicy).
   */
  sync(options?: SyncOptions): Promise<ReconciliationReport>;
}

/** A connector declaring no configured capabilities — the safe default stub. */
export const UNCONFIGURED_CAPABILITIES: ConnectorCapabilities = {
  supportsCustomers: false,
  supportsProducts: false,
  supportsStock: false,
  supportsSales: false,
  supportsPayments: false,
  supportsStaff: false,
  supportsManufacturing: false,
  supportsImages: false,
  supportsOrders: false,
  supportsIncremental: false,
};
