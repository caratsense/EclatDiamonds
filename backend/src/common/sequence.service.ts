import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * SequenceService — atomic, human-readable document references.
 *
 * ## The problem this replaces
 *
 * Refs were minted as `prisma.<model>.count() + 1`. That is unsafe twice over:
 *
 *  1. **Race.** Two salespeople booking at the same moment both read count = 41
 *     and both mint `-0042`. Nothing in the schema stops the duplicate, so two
 *     different orders ship with the same customer-facing number.
 *  2. **Reuse.** Delete or cancel-and-purge a row and the count drops, so the
 *     next document collides with a ref that is already in circulation.
 *
 * Here the counter lives in its own row and is bumped inside a single
 * `UPDATE … RETURNING`, which Postgres executes under a row lock. Concurrent
 * callers serialise on that lock and each receives a distinct number.
 */
@Injectable()
export class SequenceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Reserve and return the next integer for `scope`, creating the counter on
   * first use. `ON CONFLICT DO UPDATE` makes the create-or-bump a single
   * statement, so there is no read-then-write window for a second caller to slip
   * into.
   */
  async next(scope: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ next: number }[]>`
      INSERT INTO "DocSequence" ("scope", "next", "updatedAt")
      VALUES (${scope}, 2, CURRENT_TIMESTAMP)
      ON CONFLICT ("scope") DO UPDATE
        SET "next" = "DocSequence"."next" + 1,
            "updatedAt" = CURRENT_TIMESTAMP
      RETURNING "DocSequence"."next" - 1 AS "next"
    `;
    return Number(rows[0]?.next ?? 1);
  }

  /**
   * A formatted reference: `<PREFIX>-<SUFFIX>-<0000>`.
   *
   * @param prefix    Document type, e.g. `CO`, `SO`, `DR`.
   * @param partition Counter partition — pass the store code (and period) so each
   *                  store reads its own unbroken series rather than a shared
   *                  global one that jumps between branches.
   * @param pad       Digits to zero-pad the running number to.
   */
  async nextRef(prefix: string, partition: string, pad = 4): Promise<string> {
    const scope = `${prefix}:${partition}`;
    const n = await this.next(scope);
    return `${prefix}-${partition}-${String(n).padStart(pad, '0')}`;
  }
}
