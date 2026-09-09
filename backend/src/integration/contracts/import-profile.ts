/**
 * CaratOS integration contracts — IMPORT PROFILE & FIELD MAPPING.
 *
 * Contracts only. Powers the file/DB onboarding flow:
 *   detect columns → map fields → preview → validate → dedupe → import,
 * saving the mapping as a reusable profile so future uploads are automatic.
 *
 * Never assume a column's meaning — an unmapped/ambiguous column is surfaced to
 * the user with a confidence score, never auto-committed.
 */

import type { EntityKind, RecordIssue } from './sync-result';
import type { SourceSystem } from './provenance';

/** A discovered source (uploaded file, connected table, API endpoint). */
export interface ImportSource {
  sourceSystem: SourceSystem;
  /** e.g. file name, table name, endpoint — human label for the UI. */
  label: string;
  /** Columns/fields discovered in the source, in source order. */
  columns: SourceColumn[];
  /** Rows available (may be an estimate for large sources). */
  rowCount?: number;
}

export interface SourceColumn {
  name: string;
  /** A few example values to help the user (and suggestion engine) map it. */
  samples?: string[];
  inferredType?: 'string' | 'number' | 'date' | 'boolean' | 'unknown';
}

/** One column → canonical-field mapping within a profile. */
export interface FieldMapping {
  /** Source column name. */
  sourceColumn: string;
  /** Canonical target, e.g. 'product.sku' | 'customer.phone'. Empty => unmapped. */
  canonicalField?: string;
  /** Suggested by the engine (0–1) vs confirmed by a user. */
  confidence?: number;
  confirmed?: boolean;
  /** Optional named transform (e.g. 'normalizeIndianMobile'); never guessed silently. */
  transform?: string;
}

/**
 * A saved, reusable mapping for (organisation, source, entity). Applying a stored
 * profile makes repeat uploads one-click.
 */
export interface ImportProfile {
  id?: string;
  organisationId: string;
  entity: EntityKind;
  sourceSystem: SourceSystem;
  name: string;
  mappings: FieldMapping[];
  createdAt?: string;
  updatedAt?: string;
}

/** A suggestion the mapping engine offers; the user confirms/overrides it. */
export interface MappingSuggestion {
  sourceColumn: string;
  canonicalField: string;
  confidence: number;
  reason?: string;
}

/**
 * Dry-run preview of applying a profile to a source: a handful of transformed rows
 * plus the validation issues that would arise — shown BEFORE any import.
 */
export interface ImportPreview {
  entity: EntityKind;
  /** First N canonical rows as they WOULD be imported (no write performed). */
  sampleRows: Record<string, unknown>[];
  /** Columns with no confident mapping — the user must resolve these. */
  unmappedColumns: string[];
  issues: RecordIssue[];
}
