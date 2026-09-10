import { Injectable } from '@nestjs/common';

import type {
  FieldOwnership,
  OwnershipContext,
  SourceOwnershipPolicy,
} from '../contracts/provenance';

/**
 * FieldOwnershipService — who is allowed to write which field (Phase A10 of the
 * connector work; implements the `SourceOwnershipPolicy` contract).
 *
 * This does NOT invent rules. It encodes the one real, load-bearing rule the
 * codebase already enforces, so that a second connector cannot quietly violate it:
 *
 *   A StockItem that has been through a CaratOS stock transfer owns its own
 *   `storeId` and `status`. Everything else on that piece stays source-owned.
 *
 * That rule exists because Gati does not know about CaratOS transfers. Without it,
 * the next sync moves a transferred piece back to the branch it left — the stock
 * is physically in Bandra and the system says Borivali, and every total still
 * adds up, so nobody notices until someone goes looking for the piece.
 *
 * WHERE THE RULE IS ENFORCED TODAY: inline in SyncService's stock upsert. That
 * enforcement is deliberately left exactly where it is — moving working
 * protection during an integration refactor is how protection gets lost. This
 * service makes the rule *inspectable and reusable* for connectors written later,
 * and `assertConsistentWithSync` documents the coupling so the two cannot drift
 * silently.
 *
 * UNKNOWN IS NOT PERMISSION. Any field with no stated rule returns UNKNOWN, and
 * `mayOverwrite` treats UNKNOWN as "do not auto-write". A connector that wants to
 * write a field must have an explicit reason to.
 */

/** Fields a transfer-controlled StockItem owns outright. */
const STOCK_ITEM_CARATOS_OWNED_AFTER_TRANSFER = ['storeId', 'status'] as const;

/**
 * Fields CaratOS owns on any entity regardless of source, because they describe
 * CaratOS's own bookkeeping rather than anything the source system knows about.
 */
const ALWAYS_CARATOS_OWNED = new Set([
  'organisationId',
  'id',
  'createdAt',
  'updatedAt',
  'importBatchId',
  'partyId',
  'approvalStatus',
  'isActive',
]);

@Injectable()
export class FieldOwnershipService implements SourceOwnershipPolicy {
  /**
   * Who owns `entity.field` right now?
   *
   * `context.lifecycleState === 'transfer_controlled'` is the signal that a stock
   * item has been moved by CaratOS. Callers that cannot determine the lifecycle
   * state must not pass one — the answer then correctly stays SOURCE_OWNED for
   * stock fields, matching the sync's own CREATE path.
   */
  ownershipOf(entity: string, field: string, context?: OwnershipContext): FieldOwnership {
    if (ALWAYS_CARATOS_OWNED.has(field)) return 'CARATOS_OWNED';

    if (entity === 'stockItem' || entity === 'StockItem') {
      const controlled = context?.lifecycleState === 'transfer_controlled';
      if (controlled && (STOCK_ITEM_CARATOS_OWNED_AFTER_TRANSFER as readonly string[]).includes(field)) {
        return 'CARATOS_OWNED';
      }
      return 'SOURCE_OWNED';
    }

    // Entities the connector sync mirrors wholesale. Their fields are the source's
    // to maintain; CaratOS edits to them are overwritten by design, which is the
    // documented behaviour of a mirrored record.
    if (['party', 'product', 'sale', 'saleLine', 'payment', 'ledgerEntry'].includes(entity)) {
      return 'SOURCE_OWNED';
    }

    // No stated rule. Deliberately not a guess — an unrecognised entity/field pair
    // is exactly where an invented ownership rule would do damage.
    return 'UNKNOWN';
  }

  /** May a sync write this field? Only SOURCE_OWNED is a yes. */
  mayOverwrite(entity: string, field: string, context?: OwnershipContext): boolean {
    return this.ownershipOf(entity, field, context) === 'SOURCE_OWNED';
  }

  /**
   * Strip the fields a connector is not allowed to write from an update payload.
   * The reusable form of what SyncService does inline for stock.
   */
  filterWritable<T extends Record<string, unknown>>(
    entity: string,
    data: T,
    context?: OwnershipContext,
  ): Partial<T> {
    const out: Partial<T> = {};
    for (const [field, value] of Object.entries(data)) {
      if (this.mayOverwrite(entity, field, context)) out[field as keyof T] = value as T[keyof T];
    }
    return out;
  }

  /**
   * The protected field list, for the admin UI and for the assertion below.
   * Exposed so "what will a sync not touch?" is answerable without reading code.
   */
  protectedFields(entity: string, context?: OwnershipContext): string[] {
    if (entity === 'stockItem' && context?.lifecycleState === 'transfer_controlled') {
      return [...STOCK_ITEM_CARATOS_OWNED_AFTER_TRANSFER];
    }
    return [];
  }

  /**
   * Guard against drift between this policy and SyncService's inline stock
   * protection. If someone widens the protection in one place and not the other,
   * this fails loudly in a test rather than silently letting a sync overwrite a
   * transferred piece's location.
   */
  assertConsistentWithSync(syncProtectedFields: readonly string[]): void {
    const mine = this.protectedFields('stockItem', { lifecycleState: 'transfer_controlled' }).sort();
    const theirs = [...syncProtectedFields].sort();
    if (mine.join(',') !== theirs.join(',')) {
      throw new Error(
        `Field-ownership drift: SyncService protects [${theirs.join(', ')}] on a transferred ` +
          `stock item but FieldOwnershipService declares [${mine.join(', ')}]. ` +
          `These must match, or a connector will overwrite what a transfer set.`,
      );
    }
  }
}
