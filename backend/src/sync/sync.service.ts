import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { AuditService } from '../common/audit.service';
import { StaffSyncRowDto, StoreSyncRowDto } from './dto/sync.dto';
import {
  bool,
  dec,
  docTypeFromTranType,
  dt,
  int,
  karatFromMetal,
  maxWatermark,
  metalFromTone,
  str,
  KNOWN_INWARD_STATUSES,
  stockStatusFromInward,
} from './sync.util';

export interface SyncResult {
  entity: string;
  received: number;
  upserted: number;
  skipped: number;
  /** Highest legacy UpdateDate/EntryDate in this batch (the agent's next watermark). */
  watermark: string | null;
  /**
   * How many rows were attributed to a real branch vs. fell back to the default
   * store. Surfaced so a multi-branch install can see at a glance that its data
   * is actually being split, rather than all landing in one place unnoticed.
   */
  attribution?: {
    attributed: number;
    fellBackToDefault: number;
    unknownBranchIds: string[];
    branchColumns: string[];
  };
  /**
   * Stock only — how many pieces landed in each Eclat status. "How much stock is
   * there" is the first number the client checks and the one a wrong status
   * mapping silently doubles, so the batch reports it rather than leaving it to
   * be discovered on the shop floor.
   */
  availability?: Record<string, number>;
  /** Website import only — designs newly added vs. existing ones given a photo/price. */
  created?: number;
  enriched?: number;
  /**
   * Stock only — `Inward.Status` letters this build does not recognise, with
   * counts. Their pieces are deliberately withheld from the available set, and
   * this is how that decision surfaces instead of quietly hiding stock.
   */
  unknownStatuses?: Record<string, number>;
}

type Rec = Record<string, any>;

/**
 * Production order of the OrderStatus enum, used to decide whether a bag
 * movement moves an order FORWARD. Rework sends a bag back to an earlier
 * department all the time; that must not un-finish an order that is further on.
 * `cancelled` is deliberately -1 so it never wins a "furthest stage" comparison.
 */
const STAGE_RANK: Record<string, number> = {
  booked: 0,
  designing: 1,
  casting: 2,
  stone_setting: 3,
  polishing: 4,
  qc: 5,
  ready: 6,
  delivered: 7,
  cancelled: -1,
};

/**
 * Live legacy-sync sink (the production target the on-site sync_sjep.py agent
 * pushes to). Each method bulk-upserts one entity on its unique `legacyId`, using
 * the SAME mapping as the one-time backfill — so live sync and backfill converge
 * on identical Eclat rows. Idempotent: re-sending a record refreshes it, never
 * duplicates. Foreign keys (sale/order/stock) are resolved by looking up rows
 * already synced in an earlier entity (the agent pushes in dependency order).
 */
@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The store a row lands in when it names no branch we recognise.
   *
   * This is now a FALLBACK, not the destination: rows are stamped per-row by
   * `branchResolver`, so a multi-branch install splits correctly. It still
   * matters for two cases — a single-branch install where no row carries a
   * location, and a row whose branch has not synced yet — and for those the
   * fallback keeps data flowing rather than rejecting it. Every use is counted
   * and reported as `attribution.fellBackToDefault` so it can never be the silent
   * default it used to be.
   */
  private get defaultStoreId(): string {
    return this.config.get<string>('SYNC_DEFAULT_STORE_ID') ?? 'surat-main';
  }

  private async assertStore(): Promise<string> {
    const id = this.defaultStoreId;
    const store = await this.prisma.store.findUnique({ where: { id } });
    if (!store) {
      throw new BadRequestException(
        `Sync target store '${id}' not found — seed it or set SYNC_DEFAULT_STORE_ID.`,
      );
    }
    return id;
  }

  /**
   * Map a Gati branch/location legacyId -> Eclat Store id (or null if unmapped).
   * For future per-row location stamping of transaction rows.
   */
  async resolveStoreByLegacyId(legacyId: string | number | null | undefined): Promise<string | null> {
    if (legacyId == null) return null;
    const store = await this.prisma.store.findUnique({
      where: { legacyId: String(legacyId) },
      select: { id: true },
    });
    return store?.id ?? null;
  }

  // ── Gati branches -> Store (auto-detect new branches) ────────────────────────
  /**
   * Upsert Gati branches on `legacyId`. New branches are created `pending`
   * (isActive=false, no geo/region — HO/AM fills those on activation). Known
   * branches refresh their name/address/contact; their status, geo, region and
   * manager are never touched, so an activated store can't be reverted by a
   * re-sync.
   *
   * The response carries `missingGeo` because the legacy system holds no
   * coordinates at all. Geo-attendance silently refuses to work for a store
   * without them, so the sync has to say so out loud rather than let someone
   * discover it when a salesperson can't clock in.
   */
  async syncStores(user: AuthUser, records: StoreSyncRowDto[]) {
    const created: { id: string; legacyId: string; name: string }[] = [];
    const updated: { id: string; legacyId: string; name: string }[] = [];

    const adoptions = await this.planAdoptions(records);
    const adopted: { id: string; legacyId: string; name: string; was: string }[] = [];

    for (const r of records) {
      const legacyId = String(r.legacyId);
      let existing = await this.prisma.store.findUnique({
        where: { legacyId },
        select: { id: true },
      });

      // Not known by legacyId, but an existing Eclat branch is plainly the same
      // shop — claim it rather than creating a second one. See planAdoptions().
      const adopt = !existing ? adoptions.get(legacyId) : undefined;
      if (adopt) {
        const claimed = await this.prisma.store.update({
          where: { id: adopt.storeId },
          data: { legacyId },
          select: { id: true },
        });
        existing = claimed;
        adopted.push({ id: adopt.storeId, legacyId, name: r.name, was: adopt.wasNamed });
        await this.audit.record(user, {
          action: 'store.linked_to_gati',
          entityType: 'store',
          entityId: adopt.storeId,
          storeId: adopt.storeId,
          summary: `Linked existing branch "${adopt.wasNamed}" to Gati branch "${r.name}"`,
          metadata: { legacyId, matchedOn: adopt.why },
        });
      }

      // `?? undefined` (not `?? null`) throughout: a field the source omits must
      // leave the stored value alone, not blank out something a manager typed in
      // by hand. Only a value actually present in the feed overwrites.
      const details = {
        addressLine1: r.addressLine1 ?? undefined,
        addressLine2: r.addressLine2 ?? undefined,
        state: r.state ?? undefined,
        pincode: r.pincode ?? undefined,
        country: r.country ?? undefined,
        phone: r.phone ?? undefined,
        email: r.email ?? undefined,
        gstin: r.gstin ?? undefined,
      };

      if (existing) {
        const store = await this.prisma.store.update({
          where: { legacyId },
          data: {
            name: r.name,
            city: r.city ?? undefined,
            code: r.code ?? undefined,
            ...details,
          },
          select: { id: true, name: true },
        });
        updated.push({ id: store.id, legacyId, name: store.name });
      } else {
        const store = await this.prisma.store.create({
          data: {
            legacyId,
            name: r.name,
            city: r.city ?? '',
            code: r.code ?? null,
            status: 'pending',
            isActive: false,
            ...details,
          },
          select: { id: true, name: true },
        });
        created.push({ id: store.id, legacyId, name: store.name });
        await this.audit.record(user, {
          action: 'store.auto_detected',
          entityType: 'store',
          entityId: store.id,
          storeId: store.id,
          summary: `Auto-detected branch ${store.name} from Gati`,
          metadata: { legacyId, city: r.city ?? null, code: r.code ?? null },
        });
      }
    }

    const pendingCount = await this.prisma.store.count({
      where: { status: 'pending', isAggregate: false },
    });

    // Real branches still missing a geofence centre. Excludes the synthetic
    // "All Stores" aggregate, which has no physical location by definition.
    const missingGeo = await this.prisma.store.findMany({
      where: {
        isAggregate: false,
        OR: [{ latitude: null }, { longitude: null }],
      },
      select: { id: true, name: true, city: true, addressLine1: true, pincode: true },
      orderBy: { name: 'asc' },
    });

    this.logger.log(
      `sync stores: received=${records.length} created=${created.length} ` +
        `updated=${updated.length} pending=${pendingCount} missingGeo=${missingGeo.length}`,
    );
    if (missingGeo.length) {
      this.logger.warn(
        `${missingGeo.length} store(s) have no latitude/longitude — geo-attendance ` +
          `will not work for them until coordinates are set: ` +
          missingGeo.map((s) => s.name).join(', '),
      );
    }
    if (adopted.length) {
      this.logger.log(
        `sync stores: linked ${adopted.length} existing branch(es) to Gati — ` +
          adopted.map((a) => `"${a.was}" -> "${a.name}"`).join(', '),
      );
    }
    return { created, updated, adopted, pendingCount, missingGeo };
  }

  /**
   * Decide which incoming Gati branches are branches Eclat ALREADY has under a
   * different name, so they update that store instead of creating a twin.
   *
   * This exists because the two systems name the same shop differently. Eclat was
   * set up with "Mumbai — Bandra"; Gati calls it "MUMBAI BANDRA". Matching on
   * legacyId alone, the sync creates a second Bandra — and then the salespeople
   * who are assigned to the first one open the app on go-live morning and see an
   * empty shop, while their stock sits in a store nobody is looking at. Every
   * number still adds up, which is what makes it the dangerous kind of wrong.
   *
   * The match is on words, not characters, so punctuation and spacing differences
   * ("Mumbai - Kala Ghoda" vs "MUMBAI KALAGHODA") do not matter — but note that
   * concatenation is handled by comparing the joined form too. A branch is
   * adopted when the existing store's words are all present in the Gati name:
   * "Delhi" is adopted by "DELHI ROHINI" because Gati simply says which Delhi.
   *
   * Two deliberate restraints:
   *   - Only stores with NO legacyId are candidates. A store already linked to a
   *     Gati branch is never re-pointed; that would silently move a shop's data.
   *   - Each store is claimed once, best match first. "MUMBAI BANDRA" and
   *     "MUMBAI BANDRA BROADWAY" both fit "Mumbai — Bandra"; the exact one wins
   *     and Broadway is created as the separate branch it is.
   * Anything ambiguous is left alone and arrives as a new pending store, which a
   * human then looks at. Guessing wrong here is worse than an extra row.
   */
  private async planAdoptions(
    records: StoreSyncRowDto[],
  ): Promise<Map<string, { storeId: string; wasNamed: string; why: string }>> {
    const words = (s: string): string[] =>
      (s || '')
        .toUpperCase()
        .split(/[^A-Z0-9]+/)
        .filter(Boolean);

    const candidates = (
      await this.prisma.store.findMany({
        where: { legacyId: null, isAggregate: false },
        select: { id: true, name: true },
      })
    ).map((s) => ({ ...s, words: words(s.name), joined: words(s.name).join('') }));
    if (!candidates.length) return new Map();

    const knownLegacyIds = new Set(
      (
        await this.prisma.store.findMany({
          where: { legacyId: { not: null } },
          select: { legacyId: true },
        })
      ).map((s) => s.legacyId as string),
    );

    type Proposal = { legacyId: string; storeId: string; wasNamed: string; why: string; score: number };
    const proposals: Proposal[] = [];

    for (const r of records) {
      const legacyId = String(r.legacyId);
      if (knownLegacyIds.has(legacyId)) continue; // already linked to its own store
      const incoming = words(r.name);
      if (!incoming.length) continue;
      const incomingJoined = incoming.join('');

      for (const c of candidates) {
        if (!c.words.length) continue;
        // Exact same words (order-insensitive), or the same string once spacing
        // is removed — "MUMBAI KALAGHODA" vs "Mumbai - Kala Ghoda".
        const exact =
          c.joined === incomingJoined ||
          (c.words.length === incoming.length &&
            [...c.words].sort().join('|') === [...incoming].sort().join('|'));
        // Otherwise: every word of the existing store appears in the Gati name.
        const subset = c.words.every((w) => incoming.includes(w));
        if (!exact && !subset) continue;
        proposals.push({
          legacyId,
          storeId: c.id,
          wasNamed: c.name,
          why: exact ? `name matches "${r.name}"` : `"${c.name}" is contained in "${r.name}"`,
          // Exact wins outright. Among partial matches, prefer the one that
          // leaves fewest unexplained words, so the closest name wins the store.
          score: exact ? 1000 : 100 - (incoming.length - c.words.length),
        });
      }
    }

    proposals.sort((a, b) => b.score - a.score || a.legacyId.localeCompare(b.legacyId));
    const takenStores = new Set<string>();
    const plan = new Map<string, { storeId: string; wasNamed: string; why: string }>();
    for (const p of proposals) {
      if (plan.has(p.legacyId) || takenStores.has(p.storeId)) continue;
      plan.set(p.legacyId, { storeId: p.storeId, wasNamed: p.wasNamed, why: p.why });
      takenStores.add(p.storeId);
    }
    return plan;
  }

  // ── Staff import ────────────────────────────────────────────────────────────
  /**
   * Import the client's people (PartyMst salesmen / SPM_Users logins) as User
   * rows, upserted on `legacyId`.
   *
   * Imported staff are deliberately created **inactive with no passwordHash**:
   * they can be seen, reviewed and assigned to a store, but cannot sign in until
   * head office activates them and issues credentials. Minting working logins
   * straight from a legacy master would create accounts whose role is guessed and
   * whose owner may have left the business years ago — a standing security hole
   * in exchange for saving a few minutes of setup.
   *
   * Re-running only refreshes name/phone/store on already-imported people. An
   * activated account is never deactivated, re-roled, or stripped of its password
   * by a later sync.
   */
  async syncStaff(user: AuthUser, records: StaffSyncRowDto[]) {
    let created = 0;
    let updated = 0;
    let skipped = 0;
    const conflicts: { legacyId: string; reason: string }[] = [];

    for (const r of records) {
      const legacyId = String(r.legacyId).trim();
      const name = String(r.name ?? '').trim();
      if (!legacyId || !name) {
        skipped++;
        continue;
      }

      const storeId = r.storeLegacyId
        ? (
            await this.prisma.store.findUnique({
              where: { legacyId: String(r.storeLegacyId) },
              select: { id: true },
            })
          )?.id ?? null
        : null;

      const existing = await this.prisma.user.findUnique({
        where: { legacyId },
        select: { id: true, isActive: true },
      });

      if (existing) {
        await this.prisma.user.update({
          where: { legacyId },
          data: {
            name,
            phone: r.phone ?? undefined,
            legacyUpdatedAt: r.updatedAt ? new Date(r.updatedAt) : undefined,
          },
        });
        if (storeId) await this.linkUserStore(existing.id, storeId);
        updated++;
        continue;
      }

      // Email is the login identity and is unique. The legacy master often has
      // none, and the ones it does have are frequently shared or stale — so an
      // address already in use belongs to a different person and must not be
      // hijacked. Report it and move on rather than merging two humans.
      const email = (r.email ?? '').trim().toLowerCase();
      if (email) {
        const clash = await this.prisma.user.findUnique({
          where: { email },
          select: { id: true, legacyId: true },
        });
        if (clash) {
          conflicts.push({
            legacyId,
            reason: `email ${email} already belongs to another account`,
          });
          skipped++;
          continue;
        }
      }

      // Synthetic placeholder when the source has no email: the row must exist to
      // be reviewed, and head office sets a real address on activation. The
      // `imported.invalid` domain cannot receive mail, so it can never silently
      // become a working login.
      const loginEmail = email || `staff-${legacyId}@imported.invalid`;

      const createdUser = await this.prisma.user.create({
        data: {
          legacyId,
          legacyUpdatedAt: r.updatedAt ? new Date(r.updatedAt) : null,
          name,
          email: loginEmail,
          phone: r.phone ?? null,
          role: 'salesperson',
          isActive: false,
          passwordHash: null,
        },
        select: { id: true, name: true },
      });
      if (storeId) await this.linkUserStore(createdUser.id, storeId);
      created++;

      await this.audit.record(user, {
        action: 'staff.imported',
        entityType: 'user',
        entityId: createdUser.id,
        storeId: storeId ?? undefined,
        summary: `Imported staff ${createdUser.name} from Gati (inactive, no login)`,
        metadata: {
          legacyId,
          designation: r.designation ?? null,
          emailSource: email ? 'legacy' : 'placeholder',
        },
      });
    }

    const pendingStaff = await this.prisma.user.count({
      where: { legacyId: { not: null }, isActive: false },
    });

    this.logger.log(
      `sync staff: received=${records.length} created=${created} updated=${updated} ` +
        `skipped=${skipped} pendingActivation=${pendingStaff}`,
    );
    return { received: records.length, created, updated, skipped, conflicts, pendingStaff };
  }

  // ── Demo-data purge ─────────────────────────────────────────────────────────
  /**
   * Remove seeded demo data once the client's real data has landed.
   *
   * Provenance is the whole basis: every synced row carries a `legacyId`, seeded
   * rows do not. So "demo" means `legacyId IS NULL` in a mirrored table, plus the
   * net-new tables the sync never fills at all.
   *
   * Destructive and irreversible, so four guards stand in front of it:
   *
   *  1. **Dry run by default.** Nothing is deleted unless `confirm` is exactly
   *     PURGE_CONFIRM_PHRASE. Without it you get the plan and counts.
   *  2. **Refuses to run before real data exists.** Purging an empty system would
   *     leave the client staring at nothing and blame the migration.
   *  3. **Never deletes a store that holds real rows.** This is the sharp edge:
   *     synced transactions are all stamped with SYNC_DEFAULT_STORE_ID (default
   *     `surat-main`), which is itself a seeded store with no legacyId. Deleting
   *     "demo stores" naively would cascade every record that just synced into
   *     oblivion. Such stores are kept and reported.
   *  4. **Never deletes the caller, and never deletes a head_office account** —
   *     otherwise the operation can lock everyone out of the system it just
   *     cleaned.
   */
  /**
   * Throw away everything the sync has ever imported, so the next run can
   * rebuild it from scratch.
   *
   * Needed because a mapping bug is not repairable by a normal sync. The agent
   * is incremental: it only re-sends rows whose `UpdateDate` has moved since its
   * watermark, so rows already imported under a wrong rule are never revisited
   * and stay wrong forever. That is exactly what happened here — 4,071 pieces
   * were written before per-branch attribution worked, so every one of them
   * landed in the fallback store, and all of them were marked in_stock because
   * the status letters had not been decoded yet. Both bugs are fixed; neither
   * fix reaches a row that is never sent again.
   *
   * It also clears rows that no longer exist upstream. Testing against a copy of
   * the client's database left ~600 stock rows in Eclat with no counterpart in
   * the live one: they carry a `legacyId`, so `purgeDemo` correctly refuses to
   * touch them, and no sync will ever refresh or remove them. A reset is the
   * only thing that can.
   *
   * Deliberately the mirror image of `purgeDemo`: that one keeps everything with
   * a `legacyId` and drops the rest; this one drops everything with a `legacyId`
   * and keeps the rest. Seeded demo data is untouched — the two operations
   * compose, in either order.
   *
   * Nothing here is unrecoverable: every row deleted came from the client's own
   * system and is upserted back on its original id by the next full sync. What
   * IS destroyed is anything a person typed in Eclat *about* a synced row, which
   * is why it needs the confirm phrase and reports first.
   *
   * Stores are never deleted — they hold the branch links, geofences and staff
   * assignments that were set up by hand. Their `legacyUpdatedAt` is cleared so
   * the next sync refreshes them, and their `legacyId` is kept so the link
   * survives.
   */
  async resetSyncedData(user: AuthUser, confirm?: string) {
    const RESET_CONFIRM_PHRASE = 'DELETE SYNCED DATA';
    const armed = confirm === RESET_CONFIRM_PHRASE;

    // Children before parents, so foreign keys stay satisfied at every step.
    // Payments and ledger entries hang off sales; bags hang off orders.
    const tables = [
      'payment',
      'ledgerEntry',
      'saleLine',
      'sale',
      'productionBag',
      'manufacturingOrderItem',
      'manufacturingOrder',
      'stockMovement',
      'stockItem',
      'product',
      'party',
    ] as const;

    const counts: Record<string, number> = {};
    for (const t of tables) {
      const model = (this.prisma as any)[t];
      if (!model?.count) continue; // model renamed or not in this build
      try {
        counts[t] = await model.count({ where: { legacyId: { not: null } } });
      } catch {
        // Not every table has a legacyId column; those simply do not apply.
      }
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);

    if (!armed) {
      return {
        dryRun: true,
        message:
          `This would delete ${total} imported record(s) — everything the sync has ` +
          `ever brought in. Demo/seeded data is NOT touched, and stores are kept ` +
          `(their Gati link, geofence and staff assignments survive). The next full ` +
          `sync rebuilds all of it from the client's system. To go ahead, send ` +
          `{ "confirm": "${RESET_CONFIRM_PHRASE}" }.`,
        wouldDelete: counts,
        afterwards:
          'Delete sync_state.json on the sync agent so it re-pulls from the ' +
          'beginning, then run: 5_first_sync.bat all',
      };
    }

    // One transaction for the whole thing. A synced row can be referenced by a
    // row this list does not delete — a demo quote naming an imported product, a
    // return against an imported sale — and that reference makes the delete fail
    // partway through. Half-cleared is the one state worse than either end of
    // this operation: the counts would be wrong in a way nobody could see, and
    // the obvious response (run it again) would not fix it.
    //
    // Timeout raised well past the default 5s because this is thousands of rows
    // on a shared instance, and a reset that times out halfway is exactly the
    // failure the transaction exists to prevent.
    let deleted: Record<string, number> = {};
    let storesReset = 0;
    try {
      const outcome = await this.prisma.$transaction(
        async (tx) => {
          const d: Record<string, number> = {};
          for (const t of tables) {
            const model = (tx as any)[t];
            if (!model?.deleteMany) continue;
            d[t] = (await model.deleteMany({ where: { legacyId: { not: null } } })).count;
          }
          // Stores survive — they hold the branch links, geofences and staff
          // assignments set up by hand — but must look un-synced so the next run
          // refreshes them.
          const s = await tx.store.updateMany({
            where: { legacyId: { not: null } },
            data: { legacyUpdatedAt: null },
          });
          return { d, s: s.count };
        },
        { timeout: 120_000, maxWait: 20_000 },
      );
      deleted = outcome.d;
      storesReset = outcome.s;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.error(`reset: rolled back, nothing deleted: ${detail}`);
      throw new BadRequestException(
        'Reset was rolled back — NOTHING was deleted. Something still refers to ' +
          'the imported rows; the usual cause is demo data pointing at real ' +
          'records, so run POST /sync/purge-demo first and try again. ' +
          `Database said: ${detail.split('\n').slice(0, 3).join(' ')}`,
      );
    }

    const totalDeleted = Object.values(deleted).reduce((a, b) => a + b, 0);
    await this.audit.record(user, {
      action: 'sync.reset',
      entityType: 'system',
      entityId: 'sync-reset',
      summary: `Cleared ${totalDeleted} imported record(s) for a clean re-sync`,
      metadata: { deleted, storesReset },
    });
    this.logger.warn(`SYNC RESET by ${user.id}: removed ${totalDeleted} record(s)`);

    return {
      dryRun: false,
      message: `Cleared ${totalDeleted} imported record(s). Stores kept and unstamped.`,
      deleted,
      storesReset,
      next:
        'On the sync agent: delete sync_state.json, then run 5_first_sync.bat all',
    };
  }

  /**
   * Remove imported branches that turned out not to be branches.
   *
   * The client's `PartyMst.IsLocation` flag returns supplier firms, two holding
   * companies and a test row called "abc". A branch on this install is a party
   * the data actually records against, and the agent now identifies them that
   * way — but a run that used the old rule leaves the wrong ones behind, and a
   * store picker offering "APRS HO" is how someone files a sale against a
   * supplier. This has now needed clearing up twice, so it is a callable
   * operation rather than a third one-shot migration.
   *
   * Only ever removes a store that is **still pending** (never activated) and
   * holds **no row that belongs to it**. "Belongs to" means a foreign key: a
   * table with an FK to Store holds the branch's real data, whereas a bare
   * `storeId` with no FK — an audit entry, a notification — is a note *about* a
   * store and must not keep it alive. Counting those was why the first attempt
   * deleted nothing: creating a store writes an audit entry, so every store
   * protected itself by existing.
   *
   * Nothing is lost: these are upserted on their original id, so anything that
   * really is a branch comes straight back on the next sync.
   */
  async pruneEmptyStores(user: AuthUser, confirm?: string) {
    const PRUNE_CONFIRM_PHRASE = 'DELETE EMPTY BRANCHES';
    const armed = confirm === PRUNE_CONFIRM_PHRASE;

    // Tables holding rows that belong to a store, discovered from the schema so
    // a model added later is covered without anyone remembering to add it.
    const owning: { table: string; column: string }[] = await this.prisma.$queryRaw`
      SELECT DISTINCT kcu.table_name AS "table", kcu.column_name AS "column"
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name
       AND kcu.constraint_schema = tc.constraint_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
       AND ccu.constraint_schema = tc.constraint_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = current_schema()
        AND ccu.table_name = 'Store'`;

    const candidates = await this.prisma.store.findMany({
      where: { legacyId: { not: null }, isAggregate: false, status: 'pending' },
      select: { id: true, name: true, legacyId: true },
      orderBy: { name: 'asc' },
    });

    const empty: typeof candidates = [];
    const inUse: { name: string; legacyId: string | null; rows: number }[] = [];
    for (const s of candidates) {
      let rows = 0;
      for (const o of owning) {
        const [{ n }] = await this.prisma.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*)::int AS n FROM "${o.table}" WHERE "${o.column}" = $1`,
          s.id,
        );
        rows += Number(n);
        if (rows > 0) break;
      }
      if (rows > 0) inUse.push({ name: s.name, legacyId: s.legacyId, rows });
      else empty.push(s);
    }

    if (!armed) {
      return {
        dryRun: true,
        message:
          `${empty.length} pending branch(es) hold no data and would be removed; ` +
          `${inUse.length} hold real data and would be kept. To go ahead, send ` +
          `{ "confirm": "${PRUNE_CONFIRM_PHRASE}" }.`,
        wouldDelete: empty.map((s) => ({ name: s.name, legacyId: s.legacyId })),
        wouldKeep: inUse,
      };
    }

    const ids = empty.map((s) => s.id);
    const deleted = ids.length
      ? (await this.prisma.store.deleteMany({ where: { id: { in: ids } } })).count
      : 0;

    await this.audit.record(user, {
      action: 'store.pruned_empty',
      entityType: 'system',
      entityId: 'store-prune',
      summary: `Removed ${deleted} imported branch(es) that held no data`,
      metadata: { removed: empty.map((s) => `${s.name} (${s.legacyId})`), kept: inUse.length },
    });

    return {
      dryRun: false,
      message: `Removed ${deleted} empty imported branch(es).`,
      removed: empty.map((s) => ({ name: s.name, legacyId: s.legacyId })),
      kept: inUse,
    };
  }

  async purgeDemo(user: AuthUser, confirm?: string) {
    const PURGE_CONFIRM_PHRASE = 'DELETE DEMO DATA';
    const armed = confirm === PURGE_CONFIRM_PHRASE;

    // Guard 2 — is there any real data at all?
    const realCounts = {
      parties: await this.prisma.party.count({ where: { legacyId: { not: null } } }),
      products: await this.prisma.product.count({ where: { legacyId: { not: null } } }),
      stockItems: await this.prisma.stockItem.count({ where: { legacyId: { not: null } } }),
      sales: await this.prisma.sale.count({ where: { legacyId: { not: null } } }),
      orders: await this.prisma.manufacturingOrder.count({ where: { legacyId: { not: null } } }),
    };
    const realTotal = Object.values(realCounts).reduce((a, b) => a + b, 0);
    if (realTotal === 0) {
      throw new BadRequestException(
        'No synced data found, so there is nothing to switch over to. Run the sync ' +
          'agent first — purging now would leave the system empty.',
      );
    }

    // Net-new tables the sync never populates: everything in them is demo.
    // Children first so foreign keys stay satisfied.
    const demoOnlyTables = [
      'leadNote',
      'leadFollowUp',
      'occasionReminder',
      'lead',
      'quoteLine',
      'quote',
      'checkIn',
      'attendanceRecord',
      'leaveRequest',
      'commission',
      'ticketMessage',
      'ticket',
      'returnPhoto',
      'returnRecord',
      'discountRequest',
      'marketingAsset',
      'campaignStore',
      'marketingCampaign',
      'newStoreChecklistItem',
      'newStoreMilestone',
      'newStoreVendor',
      'newStoreProject',
      'schemeInstallment',
      'schemeMember',
      'customOrderEvent',
      'customOrder',
      'task',
      'payment',
      'ledgerEntry',
    ] as const;

    // Mirrored tables: drop the seeded rows, keep everything with a legacyId.
    const mirroredTables = [
      'saleLine',
      'sale',
      'manufacturingOrderItem',
      'manufacturingOrder',
      'stockMovement',
      'stockItem',
      'product',
      'party',
      'metalRate',
    ] as const;

    // Guard 3 — which seeded stores are safe to remove?
    //
    // The set of store-scoped tables is derived from the Prisma schema rather
    // than hand-listed: 27 models carry a storeId today, several with RESTRICT
    // foreign keys, and a hand-maintained list would silently rot the first time
    // someone adds a model — turning this into a 500 mid-cutover.
    const storeScoped = this.storeScopedModels();
    const demoStores = await this.prisma.store.findMany({
      where: { legacyId: null, isAggregate: false },
      select: { id: true, name: true },
    });
    const storesToDelete: { id: string; name: string }[] = [];
    const storesKept: { id: string; name: string; reason: string }[] = [];
    for (const s of demoStores) {
      if (s.id === this.defaultStoreId) {
        storesKept.push({ ...s, reason: 'it is the sync target for all imported data' });
        continue;
      }
      // Any imported row anywhere under this store makes it untouchable.
      let holdsReal = 0;
      for (const { model, hasLegacyId } of storeScoped) {
        if (!hasLegacyId) continue;
        const m = (this.prisma as any)[model];
        if (!m) continue;
        try {
          holdsReal += await m.count({ where: { storeId: s.id, legacyId: { not: null } } });
        } catch {
          /* model without the expected shape — ignore */
        }
        if (holdsReal > 0) break;
      }
      if (holdsReal > 0) {
        storesKept.push({ ...s, reason: `holds ${holdsReal} imported record(s)` });
      } else {
        storesToDelete.push(s);
      }
    }

    // Guard 4 — which seeded users are safe to remove?
    const demoUsers = await this.prisma.user.findMany({
      where: { legacyId: null },
      select: { id: true, name: true, email: true, role: true },
    });
    const usersToDelete: { id: string; name: string; email: string }[] = [];
    const usersKept: { id: string; email: string; reason: string }[] = [];
    for (const u of demoUsers) {
      if (u.id === user.id) {
        usersKept.push({ id: u.id, email: u.email, reason: 'this is you' });
      } else if (u.role === 'head_office') {
        usersKept.push({ id: u.id, email: u.email, reason: 'head office account' });
      } else {
        usersToDelete.push({ id: u.id, name: u.name, email: u.email });
      }
    }

    // Build the plan (counts only — no writes yet).
    const plan: Record<string, number> = {};
    for (const m of demoOnlyTables) {
      const model = (this.prisma as any)[m];
      if (!model) continue;
      try {
        plan[m] = await model.count({});
      } catch {
        /* model absent in this schema version — skip silently */
      }
    }
    for (const m of mirroredTables) {
      const model = (this.prisma as any)[m];
      if (!model) continue;
      try {
        plan[m] = await model.count({ where: { legacyId: null } });
      } catch {
        /* ignore */
      }
    }
    plan['store'] = storesToDelete.length;
    plan['user'] = usersToDelete.length;

    const totalToDelete = Object.values(plan).reduce((a, b) => a + b, 0);

    if (!armed) {
      return {
        dryRun: true,
        message:
          `This would delete ${totalToDelete} demo record(s). Nothing has been ` +
          `changed. To go ahead, send { "confirm": "${PURGE_CONFIRM_PHRASE}" }.`,
        realDataFound: realCounts,
        wouldDelete: plan,
        storesToDelete,
        storesKept,
        usersToDelete: usersToDelete.map((u) => u.email),
        usersKept,
      };
    }

    // ── Armed: execute, children before parents. ──
    const deleted: Record<string, number> = {};
    for (const m of demoOnlyTables) {
      const model = (this.prisma as any)[m];
      if (!model) continue;
      try {
        deleted[m] = (await model.deleteMany({})).count;
      } catch (err) {
        this.logger.warn(`purge: skipped ${m}: ${err instanceof Error ? err.message : err}`);
      }
    }
    for (const m of mirroredTables) {
      const model = (this.prisma as any)[m];
      if (!model) continue;
      try {
        deleted[m] = (await model.deleteMany({ where: { legacyId: null } })).count;
      } catch (err) {
        this.logger.warn(`purge: skipped ${m}: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (usersToDelete.length) {
      deleted['user'] = (
        await this.prisma.user.deleteMany({
          where: { id: { in: usersToDelete.map((u) => u.id) } },
        })
      ).count;
    }

    if (storesToDelete.length) {
      const doomed = storesToDelete.map((s) => s.id);

      // Clear everything still hanging off the doomed stores — shifts, holidays,
      // targets, rosters and the like. Several of these have RESTRICT foreign
      // keys, so the store delete fails outright unless they go first.
      //
      // Order is resolved by repeated passes rather than a hand-written
      // dependency graph: a table that fails because something still references
      // it is retried on the next pass, and we stop as soon as a pass makes no
      // progress. That stays correct as the schema grows.
      let remaining = storeScoped.map((m) => m.model);
      for (let pass = 0; pass < 5 && remaining.length; pass++) {
        const stillFailing: string[] = [];
        for (const model of remaining) {
          const m = (this.prisma as any)[model];
          if (!m) continue;
          try {
            const n = (await m.deleteMany({ where: { storeId: { in: doomed } } })).count;
            if (n) deleted[model] = (deleted[model] ?? 0) + n;
          } catch {
            stillFailing.push(model);
          }
        }
        if (stillFailing.length === remaining.length) break; // no progress — give up
        remaining = stillFailing;
      }
      if (remaining.length) {
        this.logger.warn(
          `purge: could not clear ${remaining.join(', ')} for demo stores — ` +
            `those stores will be kept rather than half-deleted.`,
        );
      }

      try {
        deleted['store'] = (
          await this.prisma.store.deleteMany({ where: { id: { in: doomed } } })
        ).count;
      } catch (err) {
        // Better a demo store lingering than a partly-deleted one.
        this.logger.error(
          `purge: store delete failed, leaving them in place: ` +
            (err instanceof Error ? err.message : String(err)),
        );
        deleted['store'] = 0;
      }
    }

    const totalDeleted = Object.values(deleted).reduce((a, b) => a + b, 0);
    await this.audit.record(user, {
      action: 'demo.purged',
      entityType: 'system',
      entityId: 'demo-purge',
      summary: `Purged ${totalDeleted} demo record(s) after go-live`,
      metadata: {
        deleted,
        storesKept,
        usersKept,
        realDataFound: realCounts,
      },
    });
    this.logger.warn(`DEMO PURGE by ${user.id}: removed ${totalDeleted} record(s)`);

    return {
      dryRun: false,
      message: `Removed ${totalDeleted} demo record(s).`,
      deleted,
      storesKept,
      usersKept,
      realDataFound: realCounts,
    };
  }

  /**
   * Every model carrying a `storeId`, read off the generated Prisma schema, with
   * whether it also has a `legacyId` (i.e. can hold imported rows).
   *
   * Derived rather than hand-listed so the purge keeps working as models are
   * added — see the note in purgeDemo.
   */
  private storeScopedModels(): { model: string; hasLegacyId: boolean }[] {
    const models = (Prisma as any)?.dmmf?.datamodel?.models ?? [];
    return models
      .filter((m: any) => m.fields?.some((f: any) => f.name === 'storeId'))
      .map((m: any) => ({
        model: m.name.charAt(0).toLowerCase() + m.name.slice(1),
        hasLegacyId: m.fields.some((f: any) => f.name === 'legacyId'),
      }));
  }

  /** Idempotent user↔store link; the composite unique makes a re-run a no-op. */
  private async linkUserStore(userId: string, storeId: string): Promise<void> {
    try {
      await this.prisma.userStore.upsert({
        where: { userId_storeId: { userId, storeId } },
        create: { userId, storeId },
        update: {},
      });
    } catch (err) {
      this.logger.warn(
        `could not link user ${userId} to store ${storeId}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  // ── Per-row branch attribution ──────────────────────────────────────────────
  /**
   * Which legacy column names a row's branch, per entity.
   *
   * Ordered — the first column present and non-null on the row wins. The order
   * matters and is not arbitrary:
   *
   *  - `Inward` (stock) carries FOUR branch-ish columns. `LocationId` is tried
   *    first because for stock the question people actually ask is "where is
   *    this piece now", which is what location tracks; `BranchNo` (the owning
   *    branch) is the fallback, then `FirstLocationId` (where it first landed).
   *    `CompanyId` is the legal entity, not a shop, so it is last.
   *  - `JewelTrans` (sales) and `Spm_MfgOrder` (orders) have NO location column
   *    at all. In this schema every transaction hangs off `BookNo` -> BookMaster,
   *    and document series are kept per branch — so the agent resolves the book's
   *    branch on its side and sends it as `EclatBranchId`. That synthetic field
   *    is checked first everywhere, which also lets an install override the
   *    column choice without a backend change.
   *
   * Overridable per install via SYNC_BRANCH_COLUMNS, a JSON object of
   * entity -> string[], because these column names and their meaning vary
   * between APRS versions and must be confirmed against the live database
   * (discover.py profiles them).
   */
  private static readonly DEFAULT_BRANCH_COLUMNS: Record<string, string[]> = {
    parties: ['EclatBranchId', 'BranchNo', 'LocationId'],
    products: ['EclatBranchId', 'BranchNo', 'LocationId'],
    // `BranchNo` before `LocationId`, and **`CompanyId` deliberately absent**.
    //
    // Measured against the client's live database: LocationId and
    // FirstLocationId are 0% populated, while BranchNo resolves to real shops
    // (MUMBAI BANDRA, DELHI ROHINI, UDAIPUR ASHOK NAGAR …). CompanyId is 100%
    // populated, which makes it tempting — but its values are legal entities and
    // suppliers (APRS HO, DIAGEMCO, HARSH PRECIOUS PVT LTD), not shops. Including
    // it would have attributed every piece lacking a BranchNo to a supplier as
    // though it were a branch: 100% coverage, most of it wrong, and wrong in a
    // way that looks perfectly reasonable on a dashboard.
    //
    // Stock with no BranchNo therefore lands in "Unassigned", which is the
    // truthful answer — that stock genuinely is not recorded against a shop.
    stock: ['EclatBranchId', 'BranchNo', 'LocationId', 'FirstLocationId'],
    sales: ['EclatBranchId', 'BranchNo', 'LocationId'],
    orders: ['EclatBranchId', 'BranchNo', 'LocationId'],
    // No `bags` entry on purpose: ProductionBag has no storeId of its own and
    // hangs off ManufacturingOrder, so a bag inherits whichever branch its order
    // was attributed to. Listing it here would imply a stamping that never runs.
  };

  private branchColumnsFor(entity: string): string[] {
    const raw = this.config.get<string>('SYNC_BRANCH_COLUMNS');
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Record<string, string[]>;
        if (Array.isArray(parsed[entity])) return parsed[entity];
      } catch {
        this.logger.warn('SYNC_BRANCH_COLUMNS is not valid JSON — using defaults.');
      }
    }
    return SyncService.DEFAULT_BRANCH_COLUMNS[entity] ?? ['EclatBranchId'];
  }

  /** Stable id of the holding store for rows we cannot attribute to a branch. */
  static readonly UNASSIGNED_STORE_ID = 'unassigned';

  /**
   * Where a row goes when it names no branch we recognise.
   *
   * On a MULTI-BRANCH install this is a dedicated holding store, not one of the
   * real shops. The reasoning is the same as a suspense account in bookkeeping:
   * a wrong number that looks right is worse than a visibly missing one. Orphans
   * dumped into (say) Mumbai just make Mumbai read high, and nobody investigates
   * a plausible figure. Sitting in "Unassigned", they are obviously wrong and get
   * fixed — and no real branch's sales or stock are ever inflated by rows that
   * may belong to a different shop.
   *
   * On a SINGLE-BRANCH install the opposite is true: no row carries a location,
   * so everything would land in a holding store and the client would see an empty
   * shop next to a full "Unassigned". So the holding store is used only once more
   * than one real (synced) branch exists. Set SYNC_UNATTRIBUTED=default to force
   * the old behaviour.
   *
   * Created lazily — an install that attributes everything never grows the extra
   * store.
   */
  private async unattributedStoreId(): Promise<string> {
    const mode = (this.config.get<string>('SYNC_UNATTRIBUTED') ?? 'holding').toLowerCase();
    if (mode === 'default') return this.assertStore();

    const realBranches = await this.prisma.store.count({
      where: { legacyId: { not: null }, isAggregate: false },
    });
    if (realBranches <= 1) return this.assertStore();

    const id = SyncService.UNASSIGNED_STORE_ID;
    const existing = await this.prisma.store.findUnique({ where: { id }, select: { id: true } });
    if (existing) return id;

    // Deliberately has no legacyId: it is ours, not a branch of theirs, so the
    // demo purge treats it as non-imported and the sync never tries to update it.
    await this.prisma.store.create({
      data: {
        id,
        name: 'Unassigned — needs a branch',
        city: '',
        status: 'pending',
        isActive: false,
      },
    });
    this.logger.warn(
      'Created the "Unassigned" holding store: some imported rows name no branch ' +
        'we recognise. They are parked there rather than inflating a real branch.',
    );
    return id;
  }

  /**
   * Resolve one batch's rows to store ids, caching lookups.
   *
   * Returns a resolver plus counters, so a caller can both stamp rows and report
   * how much of the batch was actually attributed. Silence here would be the
   * worst outcome: everything quietly landing on the default store is exactly the
   * bug this replaces, and it looks identical to "this client has one branch".
   */
  /**
   * Entities that are company-wide by nature rather than owned by a branch.
   *
   * The design catalogue (`StyleMst`) is the case that matters: a ring design is
   * not "Mumbai's design", every shop sells from the same book. Confirmed against
   * the client's restored database, where 753 of 753 designs carry no branch at
   * all — correctly, because the column does not mean anything there.
   *
   * These fall back to the default store instead of the "Unassigned" holding
   * store, so the whole catalogue does not get parked in a quarantine bucket and
   * flagged as a problem it isn't.
   */
  private static readonly GLOBAL_ENTITIES = new Set(['products']);

  private async branchResolver(entity: string) {
    // A global entity resolves to NULL, not to a store.
    //
    // `Product.storeId` is nullable precisely to mean "the whole company sells
    // this", and the catalogue query treats null as visible everywhere. Stamping
    // designs onto the default branch instead made them invisible to every other
    // branch — a salesperson in Bandra could not see the design book at all,
    // which is the opposite of what a catalogue is for.
    //
    // Whether a design can be SOLD today is a separate question, answered per
    // store from actual stock (see ProductsService.stockPresence). Ownership and
    // availability are different things and only availability varies by branch.
    const isGlobal = SyncService.GLOBAL_ENTITIES.has(entity);
    const fallbackStoreId = isGlobal ? null : await this.unattributedStoreId();
    const columns = this.branchColumnsFor(entity);
    const cache = new Map<string, string | null>();
    let attributed = 0;
    let fellBack = 0;
    const unknownBranchIds = new Set<string>();

    const resolve = async (r: Rec): Promise<string | null> => {
      for (const col of columns) {
        const raw = r[col];
        if (raw == null || String(raw).trim() === '') continue;
        const key = String(raw).trim();
        if (!cache.has(key)) {
          cache.set(key, await this.resolveStoreByLegacyId(key));
        }
        const hit = cache.get(key);
        if (hit) {
          attributed++;
          return hit;
        }
        // A branch id we have never seen as a Store. Record it rather than
        // silently pretending the row belongs to the default branch — an
        // unsynced branch is a fixable problem, but only if someone is told.
        unknownBranchIds.add(key);
      }
      fellBack++;
      return fallbackStoreId;
    };

    /**
     * For entities that MUST live in a store. Only global entities (the design
     * catalogue) may resolve to null, so this asserts what the caller already
     * knows and keeps the nullable case out of their types.
     */
    const resolveRequired = async (r: Rec): Promise<string> => {
      const id = await resolve(r);
      if (id === null) {
        // Unreachable unless someone adds an entity to GLOBAL_ENTITIES without
        // making its Prisma storeId nullable — better a clear error than a
        // silent null landing in the database.
        throw new BadRequestException(
          `Internal: '${entity}' resolved to no store, but its rows require one.`,
        );
      }
      return id;
    };

    const report = () => ({
      attributed,
      fellBackToDefault: fellBack,
      unknownBranchIds: [...unknownBranchIds].slice(0, 20),
      branchColumns: columns,
    });

    return { resolve, resolveRequired, report };
  }

  /** Log + shape the attribution summary consistently across entities. */
  private logAttribution(entity: string, report: ReturnType<Awaited<ReturnType<SyncService['branchResolver']>>['report']>) {
    if (report.fellBackToDefault > 0 || report.unknownBranchIds.length > 0) {
      this.logger.warn(
        `sync ${entity}: ${report.fellBackToDefault} row(s) had no usable branch and ` +
          `went to the default store` +
          (report.unknownBranchIds.length
            ? `; unknown branch ids: ${report.unknownBranchIds.join(', ')}`
            : '') +
          ` (columns tried: ${report.branchColumns.join(' -> ')})`,
      );
    }
    return report;
  }

  // ── PartyMst -> Party ────────────────────────────────────────────────────────
  async syncParties(records: Rec[]): Promise<SyncResult> {
    const branch = await this.branchResolver('parties');
    let upserted = 0;
    let skipped = 0;
    for (const r of records) {
      if (r.PartyNo == null) {
        skipped++;
        continue;
      }
      const types: string[] = [];
      if (bool(r.IsCustomer)) types.push('customer');
      if (bool(r.IsSupplier)) types.push('supplier');
      if (bool(r.IsSalesMan)) types.push('salesperson');
      if (bool(r.IsLocation) || bool(r.IsFactory)) types.push('branch');
      if (bool(r.IsAccount)) types.push('account');

      const storeId = await branch.resolveRequired(r);
      const data = {
        storeId,
        name: str(r.FirmName) || str(r.LegalName) || str(r.PartyCode) || String(r.PartyNo),
        legalName: str(r.LegalName),
        code: str(r.PartyCode),
        types: types as any,
        phone: str(r.FirmTele) || str(r.OwnerMobile),
        whatsapp: str(r.WhatsAppNo),
        email: str(r.FirmEmail),
        addressLine1: str(r.FirmAdd1),
        addressLine2: str(r.FirmAdd2),
        city: str(r.FirmCity),
        state: str(r.FirmState),
        country: str(r.FirmCountry) || 'India',
        pincode: str(r.FirmPinCode),
        gstin: str(r.AccGst),
        pan: str(r.FirmPan),
        aadhaar: str(r.AadhaarNo),
        birthday: dt(r.FirmBirthDate),
        anniversary: dt(r.FirmAnniversaryDate),
        creditLimit: dec(r.CreditLimit),
        isBlacklisted: bool(r.IsBlackList),
        legacyUpdatedAt: dt(r.UpdateDate),
      };
      const legacyId = String(r.PartyNo);
      await this.prisma.party.upsert({
        where: { legacyId },
        create: { legacyId, ...data },
        update: data,
      });
      upserted++;
    }
    return this.result('parties', records, upserted, skipped, branch.report());
  }

  // ── StyleMst (+Summary) -> Product ───────────────────────────────────────────
  async syncProducts(records: Rec[]): Promise<SyncResult> {
    const branch = await this.branchResolver('products');
    let upserted = 0;
    let skipped = 0;
    for (const r of records) {
      if (r.StyleId == null) {
        skipped++;
        continue;
      }
      const metal = metalFromTone(r.ToneFor, r.ToneCode);
      const sku = str(r.StyleSKUNo) || str(r.StyleCode) || `STYLE-${r.StyleId}`;
      const storeId = await branch.resolve(r);
      const data = {
        storeId,
        sku,
        name: str(r.StyleCode) || sku,
        metal: metal as any,
        karat: karatFromMetal(metal),
        weightGrams: dec(r.GrossWt ?? r.ModelWt) ?? '0',
        caratWeight: dec(r.TotDiaWt) ?? '0',
        price: dec(r.MRP ?? r.TagPrice ?? r.EndClientPrice) ?? '0',
        description: str(r.WebDescription),
        bestSeller: bool(r.BestSeller),
      };
      const legacyId = String(r.StyleId);
      await this.prisma.product.upsert({
        where: { legacyId },
        create: { legacyId, ...data },
        update: data,
      });
      upserted++;
    }
    return this.result('products', records, upserted, skipped, branch.report());
  }

  // ── Inward (+Summary) -> StockItem ───────────────────────────────────────────
  async syncStock(records: Rec[]): Promise<SyncResult> {
    const branch = await this.branchResolver('stock');
    const productByStyle = await this.idMap(
      'product',
      records.map((r) => r.StyleId),
    );
    let upserted = 0;
    let skipped = 0;
    // What each batch decided about availability, because "how much stock is
    // there" is the number the client will check first and the one a wrong
    // status silently doubles. Also collects any status letter this build does
    // not know, so an install with an extra code is noticed rather than quietly
    // having its pieces hidden.
    const byStatus: Record<string, number> = {};
    const unknownStatuses: Record<string, number> = {};

    for (const r of records) {
      if (r.JewelId == null) {
        skipped++;
        continue;
      }
      const metal = metalFromTone(r.ToneFor, r.ToneCode);
      const storeId = await branch.resolveRequired(r);
      const rawStatus = String(r.Status ?? '').trim().toUpperCase();
      if (rawStatus && !KNOWN_INWARD_STATUSES.has(rawStatus)) {
        unknownStatuses[rawStatus] = (unknownStatuses[rawStatus] ?? 0) + 1;
      }
      const stockStatus = stockStatusFromInward(r);
      byStatus[stockStatus] = (byStatus[stockStatus] ?? 0) + 1;
      const data = {
        storeId,
        productId: productByStyle.get(String(r.StyleId)) ?? null,
        sku: str(r.InwardSKUNo) || str(r.JewelCode),
        name: str(r.JewelCode),
        metal: metal as any,
        karat: karatFromMetal(metal),
        status: stockStatus as any,
        grossWeight: dec(r.GrossWt),
        netWeight: dec(r.NetWt),
        pureWeight: dec(r.PureWt),
        metalLossWeight: dec(r.MetalLossWt),
        diamondWeightCt: dec(r.TotDiaWt),
        diamondPieces: int(r.TotDiaPc),
        stoneWeightCt: dec(r.TotCZWt),
        metalAmount: dec(r.TotMtlAmt),
        diamondAmount: dec(r.TotDiaAmt),
        stoneAmount: dec(r.TotCZAmt),
        makingAmount: dec(r.TotHandlingAmt),
        cpfAmount: dec(r.TotCPFAmt),
        cost: dec(r.COST),
        mrp: dec(r.MRP),
        tagPrice: dec(r.TagPrice),
        hallmarkNo: str(r.HallMarkId),
        certificateNo: str(r.Jewelry_CertificateNo),
        inwardDate: dt(r.InwardDate),
        legacyUpdatedAt: dt(r.UpdateDate),
      };
      const legacyId = String(r.JewelId);
      await this.prisma.stockItem.upsert({
        where: { legacyId },
        create: { legacyId, ...data },
        update: data,
      });
      upserted++;
    }

    if (Object.keys(unknownStatuses).length) {
      this.logger.warn(
        `sync stock: unrecognised Inward.Status code(s) — ` +
          Object.entries(unknownStatuses)
            .map(([c, n]) => `${c}=${n}`)
            .join(', ') +
          `. These pieces are deliberately NOT shown as available; add them to ` +
          `INWARD_STATUS in sync.util.ts once their meaning is confirmed against ` +
          `the client's Const_InwardStatus table.`,
      );
    }
    this.logger.log(
      `sync stock: ${Object.entries(byStatus)
        .map(([s, n]) => `${s}=${n}`)
        .join(' ')}`,
    );

    return {
      ...this.result('stock', records, upserted, skipped, branch.report()),
      // Surfaced rather than logged only: "how many pieces do we actually have"
      // is the first thing the client checks, and the number that a wrong status
      // mapping silently doubles.
      availability: byStatus,
      unknownStatuses,
    };
  }

  // ── JewelTrans -> Sale ───────────────────────────────────────────────────────
  async syncSales(records: Rec[]): Promise<SyncResult> {
    const branch = await this.branchResolver('sales');
    const partyByLegacy = await this.idMap(
      'party',
      records.map((r) => r.PartyNo),
    );
    let upserted = 0;
    let skipped = 0;
    for (const r of records) {
      if (r.JewelTransId == null) {
        skipped++;
        continue;
      }
      const docType = docTypeFromTranType(r.TranType);
      const baseNo = `${str(r.JewelTransPrefix) || ''}${r.JewelTransNo ?? r.JewelTransId}`;
      const docNo = `${baseNo}#${r.JewelTransId}`;
      const storeId = await branch.resolveRequired(r);
      const data = {
        storeId,
        partyId: partyByLegacy.get(String(r.PartyNo)) ?? null,
        docNo,
        docType: docType as any,
        docDate: dt(r.JewelTransDate) || new Date(),
        grossAmount: dec(r.GrossAmount) ?? '0',
        totalAmount: dec(r.Amount) ?? '0',
        remarks: str(r.Remarks),
        isCancelled: bool(r.isCancel),
        legacyUpdatedAt: dt(r.UpdateDate),
      };
      const legacyId = String(r.JewelTransId);
      await this.prisma.sale.upsert({
        where: { legacyId },
        create: { legacyId, ...data },
        update: data,
      });
      upserted++;
    }
    return this.result('sales', records, upserted, skipped, branch.report());
  }

  // ── JewelTransInward (+Summary) -> SaleLine ──────────────────────────────────
  async syncSaleLines(records: Rec[]): Promise<SyncResult> {
    const saleByLegacy = await this.idMap(
      'sale',
      records.map((r) => r.JewelTransId),
    );
    const stockByLegacy = await this.idMap(
      'stockItem',
      records.map((r) => r.JewelId),
    );
    let upserted = 0;
    let skipped = 0;
    for (const r of records) {
      const saleId = saleByLegacy.get(String(r.JewelTransId));
      if (!saleId) {
        skipped++; // line for a non-imported / cancelled header
        continue;
      }
      const legacyId = `${r.JewelTransId}:${r.JewelId}:${r.SrNo ?? 0}`;
      const data = {
        saleId,
        stockItemId: stockByLegacy.get(String(r.JewelId)) ?? null,
        netWeight: dec(r.NetWt),
        metalAmount: dec(r.TotMtlAmt),
        makingAmount: dec(r.TotHandlingAmt),
        stoneAmount: dec(r.TotDiaAmt),
        discountAmount: dec(r.DiscountAmt),
        lineTotal: dec(r.MRP) ?? '0',
      };
      await this.prisma.saleLine.upsert({
        where: { legacyId },
        create: { legacyId, ...data },
        update: data,
      });
      upserted++;
    }
    return this.result('sale-lines', records, upserted, skipped);
  }

  // ── Spm_MfgOrder -> ManufacturingOrder ───────────────────────────────────────
  async syncOrders(records: Rec[]): Promise<SyncResult> {
    const branch = await this.branchResolver('orders');
    const partyByLegacy = await this.idMap(
      'party',
      records.flatMap((r) => [r.MadeFor_PartyNo, r.CustomerId]),
    );
    let upserted = 0;
    let skipped = 0;
    for (const r of records) {
      if (r.OrderId == null) {
        skipped++;
        continue;
      }
      const partyId =
        partyByLegacy.get(String(r.MadeFor_PartyNo)) ??
        partyByLegacy.get(String(r.CustomerId)) ??
        null;
      const storeId = await branch.resolveRequired(r);
      const data = {
        storeId,
        partyId,
        orderNo: `${str(r.OrderPrefix) || ''}${r.OrderNo ?? r.OrderId}`,
        orderDate: dt(r.OrderDate) || new Date(),
        // `EclatStage` is decoded agent-side from the install's own OrderStatus
        // codes (stage_map.json) — those ints are per-install, so guessing them
        // here would silently mislabel every order. Absent or unrecognised, the
        // order stays "booked" and the bag sync below advances it from the actual
        // shop-floor movements, which are far more reliable than the header int.
        status: (STAGE_RANK[str(r.EclatStage) ?? ''] != null
          ? str(r.EclatStage)
          : 'booked') as any,
        amount: dec(r.Amount ?? r.GrossAmount) ?? '0',
        poNo: str(r.PoNo),
        legacyUpdatedAt: dt(r.UpdateDate),
      };
      const legacyId = String(r.OrderId);
      await this.prisma.manufacturingOrder.upsert({
        where: { legacyId },
        create: { legacyId, ...data },
        update: data,
      });
      upserted++;
    }
    return this.result('orders', records, upserted, skipped, branch.report());
  }

  // ── SPM_MfgOrderItem -> ManufacturingOrderItem ───────────────────────────────
  async syncOrderItems(records: Rec[]): Promise<SyncResult> {
    const orderByLegacy = await this.idMap(
      'manufacturingOrder',
      records.map((r) => r.OrderId),
    );
    const stockByLegacy = await this.idMap(
      'stockItem',
      records.map((r) => r.Inward_JewelId),
    );
    let upserted = 0;
    let skipped = 0;
    for (const r of records) {
      const orderId = orderByLegacy.get(String(r.OrderId));
      if (!orderId || r.OrderItemId == null) {
        skipped++;
        continue;
      }
      const data = {
        orderId,
        styleSku: str(r.SKUNo),
        description: str(r.SpecialRemarks),
        orderQty: int(r.OrderQty) ?? 1,
        status: (bool(r.Completed) ? 'ready' : 'booked') as any,
        expectedDelivery: dt(r.ExpDelDate),
        producedStockItemId: r.Inward_JewelId
          ? stockByLegacy.get(String(r.Inward_JewelId)) ?? null
          : null,
      };
      const legacyId = String(r.OrderItemId);
      await this.prisma.manufacturingOrderItem.upsert({
        where: { legacyId },
        create: { legacyId, ...data },
        update: data,
      });
      upserted++;
    }
    return this.result('order-items', records, upserted, skipped);
  }

  // ── Generic full mirror: ANY APRS-SJEP table -> LegacyRow ────────────────────
  // Stores every row verbatim (JSON), keyed by (sourceTable, rowKey). The agent
  // sends `_rowKey` (the source PK) + optional `_updatedAt`. This is the
  // "extract-everything-once" sink: future needs read LegacyRow, no code change.
  async syncRaw(table: string, records: Rec[]): Promise<SyncResult> {
    let upserted = 0;
    let skipped = 0;
    let watermark: string | null = null;
    for (const r of records) {
      const rowKey = r._rowKey != null ? String(r._rowKey) : null;
      if (!table || rowKey === null) {
        skipped++;
        continue;
      }
      const legacyUpdatedAt = dt(r._updatedAt);
      if (legacyUpdatedAt) {
        const iso = legacyUpdatedAt.toISOString();
        if (!watermark || iso > watermark) watermark = iso;
      }
      const { _rowKey, _updatedAt, ...data } = r;
      void _rowKey;
      void _updatedAt;
      await this.prisma.legacyRow.upsert({
        where: { sourceTable_rowKey: { sourceTable: table, rowKey } },
        create: { sourceTable: table, rowKey, data: data as any, legacyUpdatedAt },
        update: { data: data as any, legacyUpdatedAt, syncedAt: new Date() },
      });
      upserted++;
    }
    this.logger.log(
      `sync raw:${table}: received=${records.length} upserted=${upserted} skipped=${skipped}`,
    );
    return { entity: `raw:${table}`, received: records.length, upserted, skipped, watermark };
  }

  /**
   * Build a legacyId -> Eclat id map for a model, batched to avoid huge `IN`
   * clauses. Used to resolve foreign keys against already-synced entities.
   */
  // ── SPM_BagMaster -> ProductionBag (the manufacturing timeline) ─────────────
  /**
   * Shop-floor bags are what actually moves through the factory, so their
   * department + status IS the manufacturing timeline. `Spm_MfgOrder.OrderStatus`
   * is a single int on the header and says nothing about where a piece has got
   * to; the bag rows do.
   *
   * The agent has already decoded `DepartmentId` to a department NAME and mapped
   * it to an Eclat stage (see stage_map.json on the agent side) — the codes are
   * per-install, so that decode is configuration, not something to hardcode here.
   * `stage` is optional: an unmapped department still records the movement, it
   * just doesn't advance the order.
   */
  async syncBags(records: Rec[]): Promise<SyncResult> {
    const orderByLegacy = await this.idMap(
      'manufacturingOrder',
      records.map((r) => r.OrderId),
    );
    let upserted = 0;
    let skipped = 0;
    /** Furthest stage seen per order, so the header can follow the shop floor. */
    const furthest = new Map<string, { stage: string; at: Date | null }>();

    for (const r of records) {
      if (r.BagId == null) {
        skipped++;
        continue;
      }
      const orderId = orderByLegacy.get(String(r.OrderId)) ?? null;
      const bagDate = dt(r.BagDate);
      const data = {
        orderId,
        bagNo: str(r.BagNo) || String(r.BagId),
        barcode: str(r.BagBarcode),
        department: str(r.DepartmentName) || str(r.DepartmentId),
        status: str(r.BagStatus),
        grossWeight: dec(r.GrossWt),
        netWeight: dec(r.NetWt),
        isComplete: bool(r.IsBagComplete) ?? false,
        bagDate,
        legacyUpdatedAt: dt(r.UpdateDate),
      };
      const legacyId = String(r.BagId);
      await this.prisma.productionBag.upsert({
        where: { legacyId },
        create: { legacyId, ...data },
        update: data,
      });
      upserted++;

      const stage = str(r.EclatStage);
      if (orderId && stage && STAGE_RANK[stage] != null) {
        const seen = furthest.get(orderId);
        if (!seen || STAGE_RANK[stage] > STAGE_RANK[seen.stage]) {
          furthest.set(orderId, { stage, at: bagDate });
        }
      }
    }

    // Advance each order header to the furthest stage its bags have reached.
    // Never moves an order BACKWARDS — a bag returning to an earlier department
    // for rework must not un-finish an order that is already further along.
    for (const [orderId, { stage, at }] of furthest) {
      const current = await this.prisma.manufacturingOrder.findUnique({
        where: { id: orderId },
        select: { status: true },
      });
      const currentRank = current ? (STAGE_RANK[current.status] ?? -1) : -1;
      if (STAGE_RANK[stage] > currentRank) {
        await this.prisma.manufacturingOrder.update({
          where: { id: orderId },
          data: { status: stage as any, expectedDelivery: undefined },
        });
        this.logger.log(`order ${orderId} -> ${stage}${at ? ` (${at.toISOString()})` : ''}`);
      }
    }

    return this.result('bags', records, upserted, skipped);
  }

  // ── Inward.ImageName / StyleMst image -> Product.imageUrl, StockItem photo ───
  /**
   * Attach already-uploaded image URLs to the rows they belong to.
   *
   * Deliberately takes URLs, not bytes: the agent uploads each photo straight
   * from the shop PC to Cloudinary and sends only the resulting link. Routing
   * tens of GB of catalogue photography through the API would be slow, would
   * count twice against Railway egress, and would run into request-size limits.
   *
   * `kind` selects the target table because the legacy image lives on both the
   * design master (StyleMst -> Product) and the physical piece (Inward -> StockItem).
   */
  /**
   * Designs from the client's own website -> Product.
   *
   * Two things the shop system cannot give us:
   *
   *   - A CLEAN PHOTOGRAPH. Gati's picture folder is the working library, and a
   *     large share of it has the measurements and specification printed across
   *     the image. That is right for the workshop and wrong for a customer: a
   *     buyer shown "18.5 mm" written over a ring learns nothing and trusts it
   *     less. The website photos are the retouched shots the client already
   *     publishes, and they are already on a public CDN — so we store the URL
   *     and upload nothing.
   *
   *   - A PRICE for designs held as stock nowhere. `StyleMstSummary.MRP` is
   *     filled on under half the designs, while every website design carries
   *     one.
   *
   * Matching is on the design code (website `productCode` == Gati `StyleCode`,
   * which is what `Product.name` holds), falling back to the SKU prefix, since
   * Gati's SKU is the code plus a specification tail:
   *   09987RG-050  ->  09987RG-050-G-14KT-YG-LG-VVS-VS-E-F
   *
   * A design that matches is only ENRICHED — its photo and web price are added,
   * and nothing that came from the shop system is overwritten, because Gati is
   * the authority on anything it actually holds. A design that matches nothing
   * is created as company-wide (`storeId: null`, like every other design) and
   * `made_to_order`, which is the honest state: the shop sells it, no branch has
   * one on the shelf, and a salesperson can raise it to head office.
   */
  async syncWebsiteProducts(records: Rec[]): Promise<SyncResult> {
    // Website taxonomy -> our enum. Ordered: the first hit wins, so
    // "Pendants & Necklace" resolves before the looser "necklace" test.
    const CATEGORY: [RegExp, string][] = [
      [/mangalsutra|necklace/i, 'necklace'],
      [/pendant/i, 'pendant'],
      [/earring|stud/i, 'earrings'],
      [/bangle/i, 'bangle'],
      [/bracelet/i, 'bracelet'],
      [/chain/i, 'chain'],
      [/ring|solitaire/i, 'ring'],
    ];
    // Karat -> MetalKind. 9k and 14k have no member of their own; they are gold
    // and the karat number is kept exactly on Product.karat, so nothing is lost
    // by filing them under the nearest bucket.
    const METAL: Record<string, string> = {
      '24': 'gold_24k',
      '22': 'gold_22k',
      '18': 'gold_18k',
      '14': 'gold_18k',
      '9': 'gold_18k',
    };

    let upserted = 0;
    let skipped = 0;
    let created = 0;
    let enriched = 0;

    for (const r of records) {
      const code = str(r.productCode);
      if (!code) {
        skipped++;
        continue;
      }
      const imageUrl = str(r.imageUrl) || null;
      const price = dec(r.price);
      const karat = int(r.karat) ?? 0;

      // By our own marker first, so a re-run finds what it created last time
      // rather than colliding on the unique SKU.
      const existing =
        (await this.prisma.product.findUnique({
          where: { legacyId: `WEB-${code}` },
          select: { id: true, imageUrl: true, price: true, legacyId: true },
        })) ??
        (await this.prisma.product.findFirst({
          where: { name: code },
          select: { id: true, imageUrl: true, price: true, legacyId: true },
        })) ??
        (await this.prisma.product.findFirst({
          where: { sku: { startsWith: `${code}-` } },
          select: { id: true, imageUrl: true, price: true, legacyId: true },
        }));

      if (existing) {
        // Only fill gaps. A photo already set by the media sync, or a price
        // Gati supplied, is left exactly as it is.
        const data: Record<string, unknown> = {};
        if (imageUrl && !existing.imageUrl) data.imageUrl = imageUrl;
        if (price != null && Number(existing.price) === 0) data.price = price;
        if (str(r.description)) data.description = str(r.description);
        // Repairs rows this import created before it stamped provenance. Without
        // it they read as demo data and the go-live purge deletes them.
        if (!existing.legacyId) data.legacyId = `WEB-${code}`;
        if (Object.keys(data).length) {
          await this.prisma.product.update({ where: { id: existing.id }, data });
          enriched++;
          upserted++;
        } else {
          skipped++;
        }
        continue;
      }

      const cat = CATEGORY.find(([re]) => re.test(str(r.category) + ' ' + str(r.name)));
      await this.prisma.product.create({
        data: {
          // Provenance, and it has to be set. `purgeDemo` decides what is seeded
          // demo data by `legacyId IS NULL`, so a website design created without
          // one is indistinguishable from a demo row and gets deleted at go-live
          // — which is exactly what happened the first time this ran. The `WEB-`
          // prefix keeps it clear of any Gati id and makes the import idempotent.
          legacyId: `WEB-${code}`,
          sku: code,
          name: str(r.name) || code,
          category: (cat?.[1] ?? 'other') as any,
          metal: (METAL[String(karat)] ?? 'gold_18k') as any,
          karat,
          price: price ?? 0,
          caratWeight: dec(r.caratWeight) ?? 0,
          description: str(r.description) || null,
          imageUrl,
          // `lead_time` is the enum's existing word for "we sell it, nobody has
          // one on the shelf" — the only other value is in_stock, which would be
          // a lie about every one of these.
          availability: 'lead_time' as any,
          storeId: null,
        },
      });
      created++;
      upserted++;
    }

    this.logger.log(
      `sync website-products: created=${created} enriched=${enriched} skipped=${skipped}`,
    );
    return {
      ...this.result('website-products', records, upserted, skipped),
      created,
      enriched,
    };
  }

  async syncProductImages(records: Rec[]): Promise<SyncResult> {
    let upserted = 0;
    let skipped = 0;
    for (const r of records) {
      const legacyId = r.legacyId == null ? null : String(r.legacyId);
      const url = str(r.imageUrl);
      if (!legacyId || !url) {
        skipped++;
        continue;
      }
      const kind = str(r.kind) === 'stock' ? 'stock' : 'product';
      try {
        if (kind === 'product') {
          await this.prisma.product.update({
            where: { legacyId },
            data: { imageUrl: url, ...(str(r.stlUrl) ? { stlUrl: str(r.stlUrl) } : {}) },
          });
        } else {
          await this.prisma.stockItem.update({
            where: { legacyId },
            data: { imageUrl: url },
          });
        }
        upserted++;
      } catch {
        // The row hasn't been synced yet (images can run ahead of a full pull).
        // Skipping is correct: the next media run re-sends it.
        skipped++;
      }
    }
    return this.result('product-images', records, upserted, skipped);
  }

  private async idMap(
    model: 'party' | 'product' | 'stockItem' | 'sale' | 'manufacturingOrder',
    legacyValues: unknown[],
  ): Promise<Map<string, string>> {
    const ids = [
      ...new Set(
        legacyValues.filter((v) => v !== null && v !== undefined).map((v) => String(v)),
      ),
    ];
    const map = new Map<string, string>();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = await (this.prisma[model] as any).findMany({
        where: { legacyId: { in: chunk } },
        select: { id: true, legacyId: true },
      });
      for (const row of rows) map.set(row.legacyId, row.id);
    }
    return map;
  }

  private result(
    entity: string,
    records: Rec[],
    upserted: number,
    skipped: number,
    /** Branch-attribution summary, when the entity is store-scoped. */
    attribution?: ReturnType<Awaited<ReturnType<SyncService['branchResolver']>>['report']>,
  ): SyncResult {
    this.logger.log(
      `sync ${entity}: received=${records.length} upserted=${upserted} skipped=${skipped}` +
        (attribution
          ? ` attributed=${attribution.attributed} default=${attribution.fellBackToDefault}`
          : ''),
    );
    if (attribution) this.logAttribution(entity, attribution);
    return {
      entity,
      received: records.length,
      upserted,
      skipped,
      watermark: maxWatermark(records),
      ...(attribution ? { attribution } : {}),
    };
  }
}
