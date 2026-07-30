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
  stockStatusFromInward,
} from './sync.util';

export interface SyncResult {
  entity: string;
  received: number;
  upserted: number;
  skipped: number;
  /** Highest legacy UpdateDate/EntryDate in this batch (the agent's next watermark). */
  watermark: string | null;
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
   * Single-branch legacy install -> one Eclat store (override via SYNC_DEFAULT_STORE_ID).
   * NOTE: the single-defaultStoreId path below is intentionally kept AS-IS so existing
   * single-branch installs keep working. Multi-store installs will instead stamp each
   * transaction row's store via `resolveStoreByLegacyId(LocationId)` — the next step is
   * threading the Gati LocationId onto each synced transaction row so per-row location
   * stamping can replace this default.
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

    for (const r of records) {
      const legacyId = String(r.legacyId);
      const existing = await this.prisma.store.findUnique({
        where: { legacyId },
        select: { id: true },
      });

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
    return { created, updated, pendingCount, missingGeo };
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

  // ── PartyMst -> Party ────────────────────────────────────────────────────────
  async syncParties(records: Rec[]): Promise<SyncResult> {
    const storeId = await this.assertStore();
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
    return this.result('parties', records, upserted, skipped);
  }

  // ── StyleMst (+Summary) -> Product ───────────────────────────────────────────
  async syncProducts(records: Rec[]): Promise<SyncResult> {
    const storeId = await this.assertStore();
    let upserted = 0;
    let skipped = 0;
    for (const r of records) {
      if (r.StyleId == null) {
        skipped++;
        continue;
      }
      const metal = metalFromTone(r.ToneFor, r.ToneCode);
      const sku = str(r.StyleSKUNo) || str(r.StyleCode) || `STYLE-${r.StyleId}`;
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
    return this.result('products', records, upserted, skipped);
  }

  // ── Inward (+Summary) -> StockItem ───────────────────────────────────────────
  async syncStock(records: Rec[]): Promise<SyncResult> {
    const storeId = await this.assertStore();
    const productByStyle = await this.idMap(
      'product',
      records.map((r) => r.StyleId),
    );
    let upserted = 0;
    let skipped = 0;
    for (const r of records) {
      if (r.JewelId == null) {
        skipped++;
        continue;
      }
      const metal = metalFromTone(r.ToneFor, r.ToneCode);
      const data = {
        storeId,
        productId: productByStyle.get(String(r.StyleId)) ?? null,
        sku: str(r.InwardSKUNo) || str(r.JewelCode),
        name: str(r.JewelCode),
        metal: metal as any,
        karat: karatFromMetal(metal),
        status: stockStatusFromInward(r) as any,
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
    return this.result('stock', records, upserted, skipped);
  }

  // ── JewelTrans -> Sale ───────────────────────────────────────────────────────
  async syncSales(records: Rec[]): Promise<SyncResult> {
    const storeId = await this.assertStore();
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
    return this.result('sales', records, upserted, skipped);
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
    const storeId = await this.assertStore();
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
    return this.result('orders', records, upserted, skipped);
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

  private result(entity: string, records: Rec[], upserted: number, skipped: number): SyncResult {
    this.logger.log(
      `sync ${entity}: received=${records.length} upserted=${upserted} skipped=${skipped}`,
    );
    return { entity, received: records.length, upserted, skipped, watermark: maxWatermark(records) };
  }
}
