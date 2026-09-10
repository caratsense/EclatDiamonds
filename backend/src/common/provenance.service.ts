import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import type { SourceSystem } from '../integration/contracts/provenance';

/**
 * ProvenanceService — THE answer to "where did this row come from?" (Phase A7/A9).
 *
 * There are exactly two provenance markers in this schema today, and they arrived
 * years apart:
 *
 *   `legacyId`       — the row came from a connector (Gati, via the on-site agent).
 *   `importBatchId`  — the row came from a file upload (CSV/XLSX import engine).
 *
 * Before this service, the rule that read them lived privately inside SyncService
 * as "no legacyId means seeded demo data" — which was true until the import engine
 * shipped, and then silently deleted every spreadsheet-imported customer during
 * the documented go-live purge. The lesson is not "add another marker"; it is that
 * the rule must live in ONE place that every destructive operation consults.
 *
 * So: no third mechanism. This service is the single reader of the two that exist,
 * and it is the seam a future unified `SourceLink` table slots into without any
 * caller changing. That migration is deliberately NOT done here — see
 * `REMAINING_MIGRATION` below.
 */

/**
 * The models that can carry file-import provenance. Driven by the importer
 * registry (entity-importers.ts), because those importers are the only code that
 * writes `importBatchId`. Prisma delegates do not advertise their fields at
 * runtime, so reflection is not an option and a hand-kept list is the honest one.
 */
const IMPORTABLE_MODELS = new Set(['party', 'product', 'store']);

/**
 * Models carrying `legacyId` that the connector sync writes. Used only to decide
 * which marker to test; a model absent from both sets simply has no provenance
 * and is treated as locally created.
 */
const CONNECTOR_MODELS = new Set([
  'party',
  'product',
  'store',
  'stockItem',
  'sale',
  'saleLine',
  'payment',
  'ledgerEntry',
  'manufacturingOrder',
  'manufacturingOrderItem',
  'productionBag',
  'stockMovement',
  'user',
  'metalRate',
]);

/**
 * The known gap, stated in code so it cannot be forgotten.
 *
 * A full `SourceLink` table would let one row cite several sources (Gati stock +
 * a Tally ledger reference + a spreadsheet correction) and record first-seen /
 * last-seen / the mapping that produced it. Today a row can cite at most one of
 * each kind, and no mapping is retained.
 *
 * The safe guard is in place (nothing is deleted for lacking a Gati id), so this
 * is a capability gap, not a data-loss risk — which is why it is reported rather
 * than rushed into a migration that would need a backfill across 14 models.
 */
export const REMAINING_MIGRATION =
  'SourceLink (multi-source provenance with first/last seen and mapping lineage) is not implemented. ' +
  'Rows carry at most one legacyId and one importBatchId, and transformation lineage is not retained.';

export interface ProvenanceDescriptor {
  hasProvenance: boolean;
  sourceSystem: SourceSystem | null;
  externalId: string | null;
  importBatchId: string | null;
  /** Human sentence for the UI. Never blank — "entered in CaratOS" is an answer. */
  description: string;
}

@Injectable()
export class ProvenanceService {
  constructor(private readonly prisma: PrismaService) {}

  /** Can this model carry file-import provenance? */
  supportsImportBatch(model: string): boolean {
    return IMPORTABLE_MODELS.has(model);
  }

  /** Can this model carry connector provenance? */
  supportsLegacyId(model: string): boolean {
    return CONNECTOR_MODELS.has(model);
  }

  /**
   * A `where` fragment matching rows that came FROM THE CUSTOMER — by any route.
   *
   * This is the predicate every destructive operation must use to decide what it
   * is not allowed to touch. "Came from the customer" means a connector brought
   * it in OR they uploaded it; both are irreplaceable by CaratOS.
   */
  fromCustomerWhere(model: string, organisationId: string): Prisma.PartyWhereInput {
    const markers: Record<string, unknown>[] = [];
    if (this.supportsLegacyId(model)) markers.push({ legacyId: { not: null } });
    if (this.supportsImportBatch(model)) markers.push({ importBatchId: { not: null } });
    // A model with no provenance columns can have no customer-sourced rows. `id:
    // { in: [] }` matches nothing, which is the correct fail-closed answer — the
    // alternative (an empty filter) would match EVERYTHING.
    if (!markers.length) return { organisationId, id: { in: [] } } as Prisma.PartyWhereInput;
    return { organisationId, OR: markers } as Prisma.PartyWhereInput;
  }

  /**
   * The inverse: rows CaratOS itself created (seeded demo data, or typed in by a
   * person). The predicate a demo purge is allowed to delete.
   *
   * The bug this replaces tested only `legacyId: null`. Every marker the model
   * supports is now required to be absent before a row counts as unowned.
   */
  locallyCreatedWhere(model: string, organisationId: string): Prisma.PartyWhereInput {
    const clauses: Record<string, unknown> = { organisationId };
    if (this.supportsLegacyId(model)) clauses.legacyId = null;
    if (this.supportsImportBatch(model)) clauses.importBatchId = null;
    return clauses as Prisma.PartyWhereInput;
  }

  /** Describe one row's origin, for the UI and for support questions. */
  describe(row: {
    legacyId?: string | null;
    legacyUpdatedAt?: Date | null;
    importBatchId?: string | null;
  }): ProvenanceDescriptor {
    if (row.legacyId) {
      return {
        hasProvenance: true,
        sourceSystem: 'gati',
        externalId: row.legacyId,
        importBatchId: null,
        description: `Synced from the connected source (id ${row.legacyId}).`,
      };
    }
    if (row.importBatchId) {
      return {
        hasProvenance: true,
        sourceSystem: 'csv',
        externalId: null,
        importBatchId: row.importBatchId,
        description: 'Imported from an uploaded file.',
      };
    }
    return {
      hasProvenance: false,
      sourceSystem: 'manual',
      externalId: null,
      importBatchId: null,
      description: 'Entered in CaratOS.',
    };
  }

  /**
   * Full origin of one record, including the import batch it arrived in.
   * Organisation-scoped: a provenance lookup must never reach across tenants.
   */
  async describeRecord(
    organisationId: string,
    model: 'party' | 'product' | 'store',
    id: string,
  ): Promise<(ProvenanceDescriptor & { batch?: unknown }) | null> {
    const delegate = this.prisma[model] as unknown as {
      findFirst(args: unknown): Promise<Record<string, unknown> | null>;
    };
    const row = await delegate.findFirst({
      where: { id, organisationId },
      select: { legacyId: true, legacyUpdatedAt: true, importBatchId: true },
    });
    if (!row) return null;

    const descriptor = this.describe(row as never);
    if (!descriptor.importBatchId) return descriptor;

    const batch = await this.prisma.importBatch.findFirst({
      where: { id: descriptor.importBatchId, organisationId },
      select: {
        id: true,
        sourceSystem: true,
        entity: true,
        fileName: true,
        status: true,
        createdAt: true,
        createdById: true,
      },
    });
    if (!batch) return { ...descriptor, batch: null };
    const sourceSystem = batch.sourceSystem as SourceSystem;
    const connected = batch.createdById?.startsWith('agent:') ?? false;
    const sourceLabel = sourceSystem === 'excel'
      ? 'Excel'
      : sourceSystem === 'csv'
        ? 'CSV'
        : sourceSystem.toUpperCase();
    return {
      ...descriptor,
      sourceSystem,
      description: connected
        ? `Synced from ${sourceLabel} through CaratOS Connect.`
        : `Imported from a ${sourceLabel} file.`,
      batch,
    };
  }

  /** Counts of customer-sourced vs locally-created rows, for the go-live board. */
  async summary(organisationId: string, models: string[] = ['party', 'product', 'store']) {
    const out: Record<string, { fromCustomer: number; local: number }> = {};
    for (const model of models) {
      const delegate = (this.prisma as unknown as Record<string, { count?: (a: unknown) => Promise<number> }>)[model];
      if (!delegate?.count) continue;
      try {
        out[model] = {
          fromCustomer: await delegate.count({ where: this.fromCustomerWhere(model, organisationId) }),
          local: await delegate.count({ where: this.locallyCreatedWhere(model, organisationId) }),
        };
      } catch {
        // A model whose shape does not match this schema version is skipped
        // rather than reported as zero, which would read as "nothing there".
      }
    }
    return { counts: out, remainingMigration: REMAINING_MIGRATION };
  }
}
