import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import { BadRequestException, ForbiddenException, Injectable, Logger, Optional } from '@nestjs/common';
import { MetalKind, Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { gatiComposition, websiteComposition } from '../products/composition';
import { CatalogueIndexService } from '../products/catalogue-index.service';
import { karatToMetal } from '../catalogue/metal';
import { applyImageOrder } from '../catalogue/image-order';
import type { WebsiteCatalogueService } from '../catalogue/website/website-catalogue.service';
import type { WebsiteRawDto } from '../catalogue/website/website.dto';
import { AuthUser } from '../common/auth-user';
import { AuditService } from '../common/audit.service';
import { ProvenanceService } from '../common/provenance.service';
import { StaffSyncRowDto, StoreSyncRowDto } from './dto/sync.dto';
import { GatiIngestionContext, GatiRoutingPolicy, parseGatiRoutingPolicy } from './gati-ingestion.guard';
import {
  bool,
  dec,
  docTypeFromTranType,
  dt,
  int,
  karatFromMetal,
  maxWatermark,
  karatFromRow,
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
  /** Website import only — published photographs filed into product galleries. */
  photos?: number;
  /**
   * Stock only — `Inward.Status` letters this build does not recognise, with
   * counts. Their pieces are deliberately withheld from the available set, and
   * this is how that decision surfaces instead of quietly hiding stock.
   */
  unknownStatuses?: Record<string, number>;
  /**
   * Stock only — how many rows had their Eclat-owned store/location + status
   * preserved against the legacy values because the piece is mid- or
   * post-transfer (Module 9 source-of-truth split). 0 on a normal batch.
   */
  eclatControlledPreserved?: number;
}

type Rec = Record<string, any>;

type IngestionDatabase = PrismaService | Prisma.TransactionClient;

interface ActiveGatiIngestion {
  db: Prisma.TransactionClient;
  routing: GatiRoutingPolicy;
  /** Pictures to queue for indexing once the batch has committed. */
  imagesToIndex: string[];
}

interface LockedGatiAgent {
  id: string;
  organisationId: string;
  sourceSystem: string;
  sourceInstanceHash: string | null;
  tokenHash: string;
  revokedAt: Date | null;
  config: Prisma.JsonValue;
}

/**
 * `SyncState.storeId` is nullable, and PostgreSQL treats NULL values as
 * distinct in a unique constraint. A null organisation-wide row could
 * therefore duplicate forever. This non-null sentinel is deliberately not a
 * Store id (SyncState has no Store FK); organisationId remains the tenant key.
 */
export const SYNC_STATE_ORGANISATION_SENTINEL = '__organisation__';

const GATI_SOURCE_TABLE_BY_ROUTE: Record<string, string> = {
  // Use the source's own table names, not CaratOS endpoint names. Several routes
  // are views over PartyMst; they intentionally converge on one table state,
  // with the latest fully accepted batch replacing its counters.
  parties: 'PartyMst',
  stores: 'PartyMst',
  staff: 'PartyMst',
  products: 'StyleMst',
  stock: 'Inward',
  sales: 'JewelTrans',
  'sale-lines': 'JewelTransInward',
  orders: 'Spm_MfgOrder',
  'order-items': 'SPM_MfgOrderItem',
  bags: 'SPM_BagMaster',
  ledger: 'Journal',
  'stock-movements': 'InwardHistory',
  // These two are not SQL tables. Their source names are explicit so nobody
  // mistakes them for a Gati database watermark.
  'product-images': 'GatiMediaFiles',
  'website-products': 'WebsiteProductFeed',
};

/**
 * Design category from whatever text a row carries. Gati's StyleMst has no clean
 * category column, so we scan every field (item type, group, name, code, web
 * description) for a keyword — Indian-retail synonyms included (jhumka=earrings,
 * kada/kangan=bangle, mangalsutra=necklace). Used by BOTH the Gati product sync
 * and the website import so `ring`/`necklace`/… actually separate in the
 * catalogue instead of everything landing in `other`.
 */
const CATEGORY_RULES: [RegExp, string][] = [
  [/mangalsutra|necklace|haar|rani\s*haar/i, 'necklace'],
  [/pendant|locket/i, 'pendant'],
  [/earring|ear\s*ring|stud|jhumk|bali|bugadi|kaanphool/i, 'earrings'],
  [/bangle|bengal|kada|kangan|kadaa|noa/i, 'bangle'],
  [/bracelet|lace|loose\s*chain\s*bracelet/i, 'bracelet'],
  [/chain|rope\s*chain|box\s*chain/i, 'chain'],
  [/ring|solitaire|\bband\b|finger\s*ring/i, 'ring'],
];

/**
 * Gati encodes the product group as a 2-letter code inside the design/piece code
 * (`10880RG` -> RG, `SDNK01033` -> NK, `12483BRG` -> RG, `LGCBR0045` -> BR),
 * matching MainProductGroup prefixes. The English-word scan below never matched
 * Gati rows (the text is the CODE, not the word "ring"), so every product/stock
 * row classified as `other`. Strip non-letters from the leading token and read
 * the last two letters.
 */
const CODE_GROUP: Record<string, string> = {
  RG: 'ring',
  PD: 'pendant',
  BG: 'bangle',
  BR: 'bracelet',
  NK: 'necklace',
  ER: 'earrings',
  CH: 'chain',
  CG: 'chain',
};

function categoryFromCode(r: Rec): string | null {
  const token = String(r.StyleCode ?? r.StyleSKUNo ?? r.JewelCode ?? r.InwardSKUNo ?? '').split('-')[0];
  const two = token
    .replace(/[^A-Za-z]/g, '')
    .slice(-2)
    .toUpperCase();
  return CODE_GROUP[two] ?? null;
}

/** Category from the Gati product-group code first, then an English-word scan
 * (kept for website imports, which carry real descriptions); `other` if none. */
export function categoryFromRow(r: Rec): string {
  const fromCode = categoryFromCode(r);
  if (fromCode) return fromCode;
  const hay = Object.values(r)
    .map((v) => String(v ?? ''))
    .join(' ');
  return CATEGORY_RULES.find(([re]) => re.test(hay))?.[1] ?? 'other';
}

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
/**
 * Fields a CaratOS stock transfer takes ownership of. Once a piece has moved,
 * the legacy source no longer knows where it is or what state it is in, and a
 * sync that overwrote these would send stock back to the branch it left — with
 * every total still adding up, so nobody would notice.
 *
 * Exported so FieldOwnershipService can assert its policy matches what this
 * service actually enforces. Widening the protection in one place and not the
 * other is the failure mode that constant exists to prevent.
 */
export const TRANSFER_PROTECTED_STOCK_FIELDS = ['storeId', 'status'] as const;

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);
  private readonly activeGatiIngestion = new AsyncLocalStorage<ActiveGatiIngestion>();

  constructor(
    private readonly basePrisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly provenance: ProvenanceService,
    // Optional so the unit-style specs that construct the service by hand keep working.
    @Optional() private readonly catalogueIndex?: CatalogueIndexService,
  ) {}

  /**
   * Every Gati domain query in a guarded request resolves through this getter,
   * and therefore through the same row-locking transaction. Human-only repair
   * operations have no active ingestion context and retain the ordinary client.
   */
  private get prisma(): PrismaService {
    return (this.activeGatiIngestion.getStore()?.db ?? this.basePrisma) as IngestionDatabase as PrismaService;
  }

  /**
   * Linearize one legacy batch against token rotation, revocation, disable and
   * configuration replacement.
   *
   * The initial HTTP guard is necessary but insufficient: an admin can update
   * ConnectAgent after it returns while a 3,000-row batch is still writing.
   * `FOR SHARE` conflicts with those ConnectAgent UPDATE/DELETE operations and
   * is held until every domain write plus the accepted SyncState receipt commits.
   * Therefore either the whole request is before the head-office mutation, or
   * it observes the new generation and writes nothing. There is no final-check
   * window in which stale rows can land after the mutation completes.
   */
  async runGatiIngestion<T>(
    user: AuthUser,
    request: GatiIngestionContext,
    routeEntity: string,
    received: number,
    work: () => Promise<T>,
    rawSourceTable?: string,
  ): Promise<T> {
    if (
      !user.isMachine ||
      !user.agentId ||
      user.agentId !== request.agentId ||
      user.organisationId !== request.organisationId ||
      user.agentTokenHash !== request.tokenHash ||
      user.agentConfigRevision !== request.configRevision ||
      user.connectorSourceSystem !== 'gati'
    ) {
      throw new ForbiddenException('Legacy Gati ingestion context does not match the authenticated principal.');
    }

    const imagesToIndex: string[] = [];
    const accepted = await this.basePrisma.withTenant(
      user.organisationId,
      async (tx) => {
        const [agent] = await tx.$queryRaw<LockedGatiAgent[]>(Prisma.sql`
          SELECT
            "id",
            "organisationId",
            "sourceSystem",
            "sourceInstanceHash",
            "tokenHash",
            "revokedAt",
            "config"
          FROM "ConnectAgent"
          WHERE "id" = ${request.agentId}
            AND "organisationId" = ${user.organisationId}
          FOR SHARE
        `);
        const routing = await this.assertLockedGeneration(tx, user, request, agent);

        return this.activeGatiIngestion.run({ db: tx, routing, imagesToIndex }, async () => {
          const result = await work();
          await this.recordAcceptedSyncState(tx, user.organisationId, routeEntity, rawSourceTable, received, result);
          await this.audit.record(
            user,
            {
              action: 'sync.ingested',
              entityType: 'ConnectAgent',
              entityId: request.agentId,
              summary: `Accepted Gati ${routeEntity.slice(0, 64)} batch (${received} row${received === 1 ? '' : 's'})`,
              metadata: {
                routeEntity,
                received,
                sourceTable: syncSourceTable(routeEntity, rawSourceTable),
                profileId: request.profileId,
                profileHash: request.profileHash,
                sourceInstanceHash: request.sourceInstanceHash,
                configRevision: request.configRevision,
                counts: aggregateSyncResultCounts(result),
              },
            },
            tx,
          );
          return result;
        });
      },
      // The on-site client times an upload out at 180 seconds. Leave enough
      // headroom for the response while allowing the existing 3,000-row chunk.
      { timeout: 170_000, maxWait: 10_000 },
    );
    // After commit: the indexer reads the new rows from its own connection.
    await this.queueImageIndex(user.organisationId, imagesToIndex);
    return accepted;
  }

  /**
   * Queue pictures for visual-search indexing. Inside a Gati batch this waits
   * for the commit (runGatiIngestion flushes it); a failure to queue never fails
   * a committed batch — a reindex picks the picture up.
   */
  private async queueImageIndex(organisationId: string, imageIds: string[]): Promise<void> {
    const active = this.activeGatiIngestion.getStore();
    if (active) {
      active.imagesToIndex.push(...imageIds);
      return;
    }
    if (!imageIds.length || !this.catalogueIndex) return;
    try {
      await this.catalogueIndex.enqueue(organisationId, [...new Set(imageIds)]);
    } catch (err) {
      this.logger.warn(`catalogue index enqueue failed (${imageIds.length} image(s)): ${(err as Error).message}`);
    }
  }

  private async assertLockedGeneration(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    request: GatiIngestionContext,
    agent: LockedGatiAgent | undefined,
  ): Promise<GatiRoutingPolicy> {
    if (
      !agent ||
      agent.organisationId !== user.organisationId ||
      agent.sourceSystem !== 'gati' ||
      agent.revokedAt ||
      agent.tokenHash !== request.tokenHash ||
      agent.sourceInstanceHash !== request.sourceInstanceHash
    ) {
      throw new ForbiddenException('This Gati batch belongs to an obsolete or revoked agent generation.');
    }

    const config = jsonObject(agent.config);
    const configRevision = config.configRevision ?? '1';
    if (
      config.enabled === false ||
      configRevision !== request.configRevision ||
      config.expectedProfileHash !== request.profileHash ||
      config.expectedSourceInstanceHash !== request.sourceInstanceHash
    ) {
      throw new ForbiddenException('This Gati batch no longer matches the approved configuration.');
    }

    // Parse again under the row lock. The request copy is never the authority;
    // it is only a guard-to-service carrier bound to this configRevision.
    const routing = parseGatiRoutingPolicy(config);
    if (routing.defaultStoreId) {
      const store = await tx.store.findFirst({
        where: {
          id: routing.defaultStoreId,
          organisationId: user.organisationId,
          isAggregate: false,
          isHolding: false,
          attendanceOnly: false,
          status: 'active',
          isActive: true,
        },
        select: { id: true },
      });
      if (!store) {
        throw new ForbiddenException('The approved Gati default store is not available in this organisation.');
      }
    }
    return routing;
  }

  /** Persist only a complete acknowledgement, in the same transaction as data. */
  private async recordAcceptedSyncState<T>(
    tx: Prisma.TransactionClient,
    organisationId: string,
    routeEntity: string,
    rawSourceTable: string | undefined,
    received: number,
    result: T,
  ): Promise<void> {
    if (!Number.isInteger(received) || received <= 0) return;
    if (!result || typeof result !== 'object') return;
    const view = result as Record<string, unknown>;
    const skipped = routeEntity === 'stores' ? 0 : numberField(view.skipped);
    if (skipped === null) return;
    if (routeEntity !== 'stores' && numberField(view.received) !== received) return;
    const accepted =
      routeEntity === 'stores'
        ? arrayLength(view.created) + arrayLength(view.updated)
        : routeEntity === 'staff'
          ? (numberField(view.created) ?? 0) + (numberField(view.updated) ?? 0)
          : numberField(view.upserted);
    if (skipped !== 0 || accepted !== received) return;

    const sourceTable = syncSourceTable(routeEntity, rawSourceTable);
    if (!sourceTable) return;

    const watermark = typeof view.watermark === 'string' ? dt(view.watermark) : null;
    const stateId = randomUUID();

    // This must be one database statement. Two accepted batches can finish in
    // the opposite order from the one in which their source snapshots were
    // taken. A read-then-upsert (or a plain Prisma upsert) lets the delayed,
    // older batch lower lastUpdatedAt after the newer batch commits.
    //
    // PostgreSQL's transaction timestamp also makes lastRunAt monotonic when
    // application hosts have slightly different clocks. rowsSynced follows the
    // transaction with the greatest run timestamp, while the source watermark
    // independently retains its greatest value.
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "SyncState" (
        "id",
        "organisationId",
        "sourceTable",
        "storeId",
        "lastUpdatedAt",
        "lastRunAt",
        "rowsSynced",
        "updatedAt"
      )
      VALUES (
        ${stateId},
        ${organisationId},
        ${sourceTable},
        ${SYNC_STATE_ORGANISATION_SENTINEL},
        (${watermark}::timestamptz AT TIME ZONE 'UTC'),
        (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
        ${received},
        (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
      )
      ON CONFLICT ("organisationId", "sourceTable", "storeId")
      DO UPDATE SET
        "lastUpdatedAt" = CASE
          WHEN EXCLUDED."lastUpdatedAt" IS NULL THEN "SyncState"."lastUpdatedAt"
          WHEN "SyncState"."lastUpdatedAt" IS NULL THEN EXCLUDED."lastUpdatedAt"
          ELSE GREATEST("SyncState"."lastUpdatedAt", EXCLUDED."lastUpdatedAt")
        END,
        "rowsSynced" = CASE
          WHEN "SyncState"."lastRunAt" IS NULL
            OR "SyncState"."lastRunAt" <= EXCLUDED."lastRunAt"
          THEN EXCLUDED."rowsSynced"
          ELSE "SyncState"."rowsSynced"
        END,
        "lastRunAt" = CASE
          WHEN "SyncState"."lastRunAt" IS NULL THEN EXCLUDED."lastRunAt"
          ELSE GREATEST("SyncState"."lastRunAt", EXCLUDED."lastRunAt")
        END,
        "updatedAt" = CASE
          WHEN "SyncState"."updatedAt" <= EXCLUDED."updatedAt" THEN EXCLUDED."updatedAt"
          ELSE "SyncState"."updatedAt"
        END
    `);
  }

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
    const approved = this.activeGatiIngestion.getStore()?.routing;
    if (approved && approved.defaultStoreId !== undefined) {
      if (approved.defaultStoreId) return approved.defaultStoreId;
      throw new BadRequestException(
        'This Gati configuration has no defaultStoreId. Configure one before importing unattributed rows.',
      );
    }
    // The store that owns rows we cannot attribute to a branch. This MUST be set
    // explicitly per install — there is no "main store", so never fall back to a
    // hardcoded branch (Surat or any other). An unset value is a config error.
    const id = this.config.get<string>('SYNC_DEFAULT_STORE_ID');
    if (!id) {
      throw new BadRequestException(
        'SYNC_DEFAULT_STORE_ID is not configured. Set it to the active physical branch that should own ' +
          'unattributed rows, or use holding mode — the sync never assumes one.',
      );
    }
    return id;
  }

  private async assertStore(organisationId: string): Promise<string> {
    const id = this.defaultStoreId;
    // Store.id is globally unique, but that is not an authorization boundary.
    // A process-wide fallback can point at another tenant, so ownership must be
    // checked before the id is attached to an organisation-owned row.
    const store = await this.prisma.store.findFirst({
      where: {
        id,
        organisationId,
        isAggregate: false,
        attendanceOnly: false,
        // A dedicated holding row is a documented choice here, and a branch the
        // sync itself has just created is pending until head office reviews it:
        // requiring `active` would deadlock a tenant whose only branch arrives
        // from the very sync that needs this store.
        status: { not: 'closed' },
      },
      select: { id: true },
    });
    if (!store) {
      throw new BadRequestException(
        `Sync target store '${id}' is not available in this organisation — ` +
          'configure a tenant-owned fallback before importing unattributed rows.',
      );
    }
    return id;
  }

  /**
   * Map a Gati branch/location legacyId -> Eclat Store id (or null if unmapped).
   * For future per-row location stamping of transaction rows.
   */
  async resolveStoreByLegacyId(
    legacyId: string | number | null | undefined,
    organisationId: string,
  ): Promise<string | null> {
    if (legacyId == null) return null;
    // findFirst (not findUnique): a legacyId is only unique WITHIN an org, so the
    // branch is resolved against the sync account's own org, never another's.
    const store = await this.prisma.store.findFirst({
      where: { legacyId: String(legacyId), organisationId },
      select: { id: true },
    });
    return store?.id ?? null;
  }

  // ── Gati branches -> Store (auto-detect new branches) ────────────────────────
  /**
   * Upsert Gati branches on `legacyId`. New branches are created `pending`
   * (isActive=false, no geo/region — HO/AM fills those on activation). Known
   * pending branches refresh their source identity/address/contact. Once head
   * office has reviewed and activated a branch, those human-reviewed fields are
   * preserved; only a branch first linked by this run receives the source
   * identity once. Status, geo, region and manager are never touched.
   *
   * The response carries `missingGeo` because the legacy system holds no
   * coordinates at all. Geo-attendance silently refuses to work for a store
   * without them, so the sync has to say so out loud rather than let someone
   * discover it when a salesperson can't clock in.
   */
  async syncStores(user: AuthUser, records: StoreSyncRowDto[]) {
    const created: { id: string; legacyId: string; name: string }[] = [];
    const updated: { id: string; legacyId: string; name: string }[] = [];

    const adoptions = await this.planAdoptions(user.organisationId, records);
    const adopted: {
      id: string;
      legacyId: string;
      name: string;
      was: string;
    }[] = [];

    for (const r of records) {
      const legacyId = String(r.legacyId);
      // findFirst scoped to the acting org: a legacyId is unique only WITHIN an
      // org now, so an org must never resolve another org's branch by it.
      let existing = await this.prisma.store.findFirst({
        where: { legacyId, organisationId: user.organisationId },
        select: { id: true, status: true },
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

      // Not known by legacyId, but an existing Eclat branch is plainly the same
      // shop — claim it rather than creating a second one. See planAdoptions().
      const adopt = !existing ? adoptions.get(legacyId) : undefined;
      let adoptedIdentity: { id: string; name: string } | null = null;
      if (adopt) {
        // Claim + the one permitted source-identity refresh are one transaction.
        // There is no interval in which HO can activate/edit the just-linked row
        // and then have this first refresh overwrite that reviewed state.
        const result = await this.prisma.$transaction(async (tx) => {
          const claim = await tx.store.updateMany({
            where: {
              id: adopt.storeId,
              organisationId: user.organisationId,
              legacyId: null,
            },
            data: {
              legacyId,
              name: r.name,
              city: r.city ?? undefined,
              code: r.code ?? undefined,
              ...details,
            },
          });

          // Another sync may have won the adoption race. Reuse its authoritative
          // link only when it is for this same incoming legacy branch; otherwise
          // let this row arrive as a separate pending branch below.
          if (claim.count === 0) {
            const winner = await tx.store.findFirst({
              where: { legacyId, organisationId: user.organisationId },
              select: { id: true, status: true, name: true },
            });
            return winner ? { store: winner, didAdopt: false } : null;
          }

          const claimed = await tx.store.findFirstOrThrow({
            where: { id: adopt.storeId, organisationId: user.organisationId, legacyId },
            select: { id: true, status: true, name: true },
          });
          await this.audit.record(user, {
            action: 'store.linked_to_gati',
            entityType: 'store',
            entityId: adopt.storeId,
            storeId: adopt.storeId,
            summary: `Linked existing branch "${adopt.wasNamed}" to Gati branch "${r.name}"`,
            metadata: { legacyId, matchedOn: adopt.why },
          }, tx);
          return { store: claimed, didAdopt: true };
        });
        existing = result?.store ?? null;
        if (result?.didAdopt) {
          adoptedIdentity = result.store;
          adopted.push({
            id: adopt.storeId,
            legacyId,
            name: r.name,
            was: adopt.wasNamed,
          });
        }
      }

      if (existing) {
        // Active means a person has reviewed this branch. Do not let the next
        // connector run undo a corrected name, city or office address. The
        // status predicate is part of the WRITE, not based on the earlier read:
        // if HO activates this row between those operations, updateMany claims
        // zero rows and the unchanged reviewed profile is fetched below.
        if (!adoptedIdentity) {
          await this.prisma.store.updateMany({
            where: {
              id: existing.id,
              organisationId: user.organisationId,
              legacyId,
              status: 'pending',
              isActive: false,
            },
            data: {
              name: r.name,
              city: r.city ?? undefined,
              code: r.code ?? undefined,
              ...details,
            },
          });
        }
        const store =
          adoptedIdentity ??
          (await this.prisma.store.findFirstOrThrow({
            where: { id: existing.id, organisationId: user.organisationId, legacyId },
            select: { id: true, name: true },
          }));
        updated.push({ id: store.id, legacyId, name: store.name });
      } else {
        const store = await this.prisma.store.create({
          data: {
            organisationId: user.organisationId,
            legacyId,
            name: r.name,
            city: r.city ?? '',
            code: r.code ?? null,
            status: 'pending',
            isActive: false,
            isHolding: false,
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
        }, this.prisma);
      }
    }

    const pendingCount = await this.prisma.store.count({
      where: {
        status: 'pending',
        isAggregate: false,
        isHolding: false,
        organisationId: user.organisationId,
      },
    });

    // Real branches still missing a geofence centre. Excludes the synthetic
    // "All Stores" aggregate, which has no physical location by definition.
    const missingGeo = await this.prisma.store.findMany({
      where: {
        isAggregate: false,
        isHolding: false,
        organisationId: user.organisationId,
        OR: [{ latitude: null }, { longitude: null }],
      },
      select: {
        id: true,
        name: true,
        city: true,
        addressLine1: true,
        pincode: true,
      },
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
    organisationId: string,
    records: StoreSyncRowDto[],
  ): Promise<Map<string, { storeId: string; wasNamed: string; why: string }>> {
    const words = (s: string): string[] =>
      (s || '')
        .toUpperCase()
        .split(/[^A-Z0-9]+/)
        .filter(Boolean);

    const candidates = (
      await this.prisma.store.findMany({
        where: {
          legacyId: null,
          isAggregate: false,
          isHolding: false,
          attendanceOnly: false,
          status: { not: 'closed' },
          organisationId,
        },
        select: { id: true, name: true },
      })
    ).map((s) => ({
      ...s,
      words: words(s.name),
      joined: words(s.name).join(''),
    }));
    if (!candidates.length) return new Map();

    const knownLegacyIds = new Set(
      (
        await this.prisma.store.findMany({
          where: { legacyId: { not: null }, organisationId },
          select: { legacyId: true },
        })
      ).map((s) => s.legacyId as string),
    );

    type Proposal = {
      legacyId: string;
      storeId: string;
      wasNamed: string;
      why: string;
      score: number;
    };
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
          (c.words.length === incoming.length && [...c.words].sort().join('|') === [...incoming].sort().join('|'));
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
      plan.set(p.legacyId, {
        storeId: p.storeId,
        wasNamed: p.wasNamed,
        why: p.why,
      });
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
        ? ((
            await this.prisma.store.findFirst({
              where: {
                legacyId: String(r.storeLegacyId),
                organisationId: user.organisationId,
              },
              select: { id: true },
            })
          )?.id ?? null)
        : null;

      const existing = await this.prisma.user.findFirst({
        where: { legacyId, organisationId: user.organisationId },
        select: { id: true, isActive: true },
      });

      if (existing) {
        await this.prisma.user.update({
          where: {
            organisationId_legacyId: {
              organisationId: user.organisationId,
              legacyId,
            },
          },
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
          organisationId: user.organisationId,
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
      }, this.prisma);
    }

    const pendingStaff = await this.prisma.user.count({
      where: {
        legacyId: { not: null },
        isActive: false,
        organisationId: user.organisationId,
      },
    });

    this.logger.log(
      `sync staff: received=${records.length} created=${created} updated=${updated} ` +
        `skipped=${skipped} pendingActivation=${pendingStaff}`,
    );
    return {
      received: records.length,
      created,
      updated,
      skipped,
      conflicts,
      pendingStaff,
    };
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
        counts[t] = await model.count({
          where: {
            legacyId: { not: null },
            organisationId: user.organisationId,
          },
        });
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
            d[t] = (
              await model.deleteMany({
                where: {
                  legacyId: { not: null },
                  organisationId: user.organisationId,
                },
              })
            ).count;
          }
          // Stores survive — they hold the branch links, geofences and staff
          // assignments set up by hand — but must look un-synced so the next run
          // refreshes them.
          const s = await tx.store.updateMany({
            where: {
              legacyId: { not: null },
              organisationId: user.organisationId,
            },
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
      next: 'On the sync agent: delete sync_state.json, then run 5_first_sync.bat all',
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
      where: {
        legacyId: { not: null },
        isAggregate: false,
        status: 'pending',
        organisationId: user.organisationId,
      },
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
    const deleted = ids.length ? (await this.prisma.store.deleteMany({ where: { id: { in: ids } } })).count : 0;

    await this.audit.record(user, {
      action: 'store.pruned_empty',
      entityType: 'system',
      entityId: 'store-prune',
      summary: `Removed ${deleted} imported branch(es) that held no data`,
      metadata: {
        removed: empty.map((s) => `${s.name} (${s.legacyId})`),
        kept: inUse.length,
      },
    });

    return {
      dryRun: false,
      message: `Removed ${deleted} empty imported branch(es).`,
      removed: empty.map((s) => ({ name: s.name, legacyId: s.legacyId })),
      kept: inUse,
    };
  }

  /**
   * "Delete this row" predicate for the mirrored tables during a demo purge.
   *
   * The rule used to be `legacyId: null` — "anything the connector did not bring
   * in is seeded demo data". True until the file-import engine shipped: an
   * imported customer has no legacyId either, so the documented go-live purge
   * silently deleted every customer and product a client had uploaded from their
   * own spreadsheet.
   *
   * The rule now lives in ProvenanceService, so this operation and every future
   * destructive one read the SAME definition of "the customer gave us this".
   * A local copy is exactly how the two definitions drifted apart the first time.
   */
  private notDemoWhere(model: string, org: string): Record<string, unknown> {
    return this.provenance.locallyCreatedWhere(model, org) as Record<string, unknown>;
  }

  async purgeDemo(user: AuthUser, confirm?: string) {
    const PURGE_CONFIRM_PHRASE = 'DELETE DEMO DATA';
    const armed = confirm === PURGE_CONFIRM_PHRASE;

    // Guard 2 — is there any real data at all? Scoped to the acting org: another
    // tenant's synced rows must never satisfy THIS tenant's "real data exists" gate.
    const org = user.organisationId;
    const fromClient = {
      OR: [{ legacyId: { not: null } }, { importBatchId: { not: null } }],
    };
    const realCounts = {
      parties: await this.prisma.party.count({
        where: { ...fromClient, organisationId: org },
      }),
      products: await this.prisma.product.count({
        where: { ...fromClient, organisationId: org },
      }),
      stockItems: await this.prisma.stockItem.count({
        where: { legacyId: { not: null }, organisationId: org },
      }),
      sales: await this.prisma.sale.count({
        where: { legacyId: { not: null }, organisationId: org },
      }),
      orders: await this.prisma.manufacturingOrder.count({
        where: { legacyId: { not: null }, organisationId: org },
      }),
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
      // Eight tables below were missing from this list, and every one of them
      // holds a RESTRICT foreign key to User or Store — so the purge got all the
      // way to `user.deleteMany()` and died on
      // `LeaveBalance_userId_fkey ... Key (id)=(u-sm-aarav)`. Derived from the
      // schema rather than remembered: any model with a Restrict relation to
      // User or Store that the sync never writes belongs here.
      'attendanceRegularization', // -> attendanceRecord, so it goes first
      'attendanceRecord',
      'leaveBalance',
      'leaveRequest',
      'shift',
      'storeHoliday',
      'specialRequestMessage',
      'specialRequest',
      'handoff',
      'dailyReport',
      'salesTarget',
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
      // `importBatchId: null` matters as much as `legacyId: null`: a store the
      // client uploaded in their own spreadsheet is their real branch, not
      // seeded demo data, and deleting it takes every row hanging off it.
      where: {
        legacyId: null,
        importBatchId: null,
        isAggregate: false,
        attendanceOnly: false,
        organisationId: org,
      },
      select: { id: true, name: true },
    });
    const storesToDelete: { id: string; name: string }[] = [];
    const storesKept: { id: string; name: string; reason: string }[] = [];
    for (const s of demoStores) {
      if (s.id === this.defaultStoreId) {
        storesKept.push({
          ...s,
          reason: 'it is the sync target for all imported data',
        });
        continue;
      }
      // Any imported row anywhere under this store makes it untouchable.
      let holdsReal = 0;
      for (const { model, hasLegacyId } of storeScoped) {
        if (!hasLegacyId) continue;
        const m = (this.prisma as any)[model];
        if (!m) continue;
        try {
          // "Real" means came from the client — whether via the connector
          // (legacyId) or an uploaded file (importBatchId). Counting only
          // legacyId made a store full of imported stock look empty.
          holdsReal += await m.count({
            where: {
              storeId: s.id,
              ...(this.provenance.supportsImportBatch(model)
                ? {
                    OR: [{ legacyId: { not: null } }, { importBatchId: { not: null } }],
                  }
                : { legacyId: { not: null } }),
            },
          });
        } catch {
          /* model without the expected shape — ignore */
        }
        if (holdsReal > 0) break;
      }
      if (holdsReal > 0) {
        storesKept.push({
          ...s,
          reason: `holds ${holdsReal} imported record(s)`,
        });
      } else {
        storesToDelete.push(s);
      }
    }

    // Guard 4 — which seeded users are safe to remove? Scoped to the acting org
    // so this tenant's purge can never touch another tenant's accounts.
    const demoUsers = await this.prisma.user.findMany({
      where: { legacyId: null, organisationId: org },
      select: { id: true, name: true, email: true, role: true },
    });
    const usersToDelete: { id: string; name: string; email: string }[] = [];
    const usersKept: { id: string; email: string; reason: string }[] = [];
    for (const u of demoUsers) {
      if (u.id === user.id) {
        usersKept.push({ id: u.id, email: u.email, reason: 'this is you' });
      } else if (u.role === 'head_office') {
        usersKept.push({
          id: u.id,
          email: u.email,
          reason: 'head office account',
        });
      } else {
        usersToDelete.push({ id: u.id, name: u.name, email: u.email });
      }
    }

    // Build the plan (counts only — no writes yet). Every count is org-scoped:
    // a demo-only table with no org column of its own is scoped through its
    // owning relation (orgScopedWhere), so the plan never counts another tenant.
    const plan: Record<string, number> = {};
    for (const m of demoOnlyTables) {
      const model = (this.prisma as any)[m];
      if (!model) continue;
      const scope = this.orgScopedWhere(m, org);
      if (!scope) continue; // cannot tie to an org — never touch it (fail-closed)
      try {
        plan[m] = await model.count({ where: scope });
      } catch {
        /* model absent in this schema version — skip silently */
      }
    }
    for (const m of mirroredTables) {
      const model = (this.prisma as any)[m];
      if (!model) continue;
      try {
        plan[m] = await model.count({ where: this.notDemoWhere(m, org) });
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
    // Every deleteMany is org-scoped — a demo-only table with no org column is
    // scoped through its owning relation. A model that cannot be tied to an org
    // is skipped rather than wiped globally (fail-closed cross-tenant guard).
    const deleted: Record<string, number> = {};
    for (const m of demoOnlyTables) {
      const model = (this.prisma as any)[m];
      if (!model) continue;
      const scope = this.orgScopedWhere(m, org);
      if (!scope) {
        this.logger.warn(`purge: ${m} has no org scope — left untouched to avoid a cross-tenant wipe`);
        continue;
      }
      try {
        deleted[m] = (await model.deleteMany({ where: scope })).count;
      } catch (err) {
        this.logger.warn(`purge: skipped ${m}: ${err instanceof Error ? err.message : err}`);
      }
    }
    for (const m of mirroredTables) {
      const model = (this.prisma as any)[m];
      if (!model) continue;
      try {
        deleted[m] = (await model.deleteMany({ where: this.notDemoWhere(m, org) })).count;
      } catch (err) {
        this.logger.warn(`purge: skipped ${m}: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (usersToDelete.length) {
      // Guarded like every other step. This one was not, and it is where the
      // purge actually died — `LeaveBalance_userId_fkey` on `u-sm-aarav`, a
      // RESTRICT relation from a table the list above had never mentioned. The
      // throw escaped as a 500 *after* the loops had already deleted rows, so
      // the operation half-ran: the visible result was 198 catalogue designs
      // gone and a "something went wrong" message that named nothing.
      //
      // The missing tables are now in demoOnlyTables, so this should not fail —
      // but a demo user that cannot be removed is a cosmetic leftover, and it
      // must never again cost the work that ran before it.
      try {
        deleted['user'] = (
          await this.prisma.user.deleteMany({
            where: { id: { in: usersToDelete.map((u) => u.id) } },
          })
        ).count;
      } catch (err) {
        deleted['user'] = 0;
        this.logger.warn(
          `purge: demo users kept — something still references them: ` +
            (err instanceof Error ? err.message.split('\n').slice(-2).join(' ') : String(err)),
        );
      }
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
        deleted['store'] = (await this.prisma.store.deleteMany({ where: { id: { in: doomed } } })).count;
      } catch (err) {
        // Better a demo store lingering than a partly-deleted one.
        this.logger.error(
          `purge: store delete failed, leaving them in place: ` + (err instanceof Error ? err.message : String(err)),
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
   * POST /sync/reset-users — clean slate for go-live: remove EVERY account except
   * head office, so the client starts with one login and everyone else self-signs
   * up. Dry-run unless the body carries `{"confirm":"DELETE ALL USERS EXCEPT HEAD
   * OFFICE"}`.
   *
   * Removing a user requires clearing the Eclat-only rows that foreign-key to them
   * (leads, quotes, attendance, leave, tickets, targets, …) — all of which are
   * demo data at go-live. Synced data (parties/products/stock/sales, keyed on
   * legacyId) never references a user and is left untouched. HO's own audit trail,
   * notifications and store links are preserved.
   *
   * The whole thing runs in ONE transaction: it either fully succeeds or rolls
   * back. It can never half-run and strand the database (the bug purgeDemo hit).
   */
  async resetToHeadOffice(actor: AuthUser, confirm?: string) {
    const CONFIRM = 'DELETE ALL USERS EXCEPT HEAD OFFICE';
    // Scoped to the ACTING org throughout: keep ALL of this org's head-office
    // accounts and delete only this org's other users. Another tenant's accounts
    // — head-office or not — are never read, kept, or deleted here.
    const org = actor.organisationId;
    const keep = await this.prisma.user.findMany({
      where: { role: 'head_office', organisationId: org },
      select: { id: true, name: true, email: true },
    });
    const keepIds = keep.map((u) => u.id);
    const doomedUsers = await this.prisma.user.findMany({
      where: { organisationId: org, id: { notIn: keepIds } },
      select: { id: true, name: true, email: true, role: true },
    });
    const doomedIds = doomedUsers.map((u) => u.id);
    const doomed = doomedUsers.map(({ name, email, role }) => ({
      name,
      email,
      role,
    }));

    if (confirm !== CONFIRM) {
      return {
        dryRun: true,
        confirmPhrase: CONFIRM,
        wouldDelete: doomed.length,
        wouldKeep: keep.map((k) => k.email),
        sample: doomed.slice(0, 25),
      };
    }
    if (keepIds.length === 0) {
      throw new BadRequestException(
        'No head_office account exists — refusing to delete every user and lock everyone out.',
      );
    }
    if (doomed.length === 0) {
      return {
        dryRun: false,
        deletedUsers: 0,
        message: 'Only head office exists already.',
      };
    }

    // Eclat-only tables that FK to the users being removed. Cleared entirely
    // (all demo at go-live), CHILDREN BEFORE PARENTS so foreign keys stay valid.
    const clearEntirely = [
      'leadNote',
      'leadFollowUp',
      'occasionReminder',
      'lead',
      'quoteLine',
      'quote',
      'checkIn',
      'attendanceRegularization',
      'attendanceRecord',
      'leaveBalance',
      'leaveRequest',
      'specialRequestMessage',
      'specialRequest',
      'handoff',
      'dailyReport',
      'salesTarget',
      'commission',
      'ticketMessage',
      'ticket',
      'returnPhoto',
      'returnRecord',
      'discountRequest',
      'customOrderEvent',
      'customOrder',
      'task',
    ];

    const deleted: Record<string, number> = {};
    await this.prisma.$transaction(
      async (tx) => {
        for (const m of clearEntirely) {
          const model = (tx as any)[m];
          if (!model) continue;
          // Org-scoped: a child table with no org column is scoped through its
          // owning relation. A model that can't be tied to this org is skipped
          // rather than wiped across every tenant (fail-closed).
          const scope = this.orgScopedWhere(m, org);
          if (!scope) {
            this.logger.warn(`reset-users: ${m} has no org scope — left untouched`);
            continue;
          }
          deleted[m] = (await model.deleteMany({ where: scope })).count;
        }
        // Scope to THIS org's doomed users so every other tenant — and this org's
        // own head office — keeps its notifications, audit trail and store links.
        deleted['notification'] = (
          await tx.notification.deleteMany({
            where: { userId: { in: doomedIds } },
          })
        ).count;
        deleted['auditLog'] = (
          await tx.auditLog.deleteMany({
            where: { organisationId: org, actorId: { notIn: keepIds } },
          })
        ).count;
        deleted['userStore'] = (
          await tx.userStore.deleteMany({
            where: { userId: { in: doomedIds } },
          })
        ).count;
        deleted['user'] = (await tx.user.deleteMany({ where: { id: { in: doomedIds } } })).count;
      },
      { timeout: 120_000, maxWait: 20_000 },
    );

    await this.audit.record(actor, {
      action: 'users.reset_to_head_office',
      entityType: 'system',
      entityId: 'user-reset',
      summary: `Removed ${deleted['user']} account(s); kept head office only`,
      metadata: { deleted, kept: keep.map((k) => k.email) },
    });
    this.logger.warn(`USER RESET by ${actor.id}: removed ${deleted['user']} account(s)`);

    return {
      dryRun: false,
      deletedUsers: deleted['user'],
      deleted,
      kept: keep.map((k) => k.email),
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

  /**
   * A Prisma `where` fragment that restricts one model to a single organisation.
   *
   * The destructive go-live ops (purgeDemo / resetSyncedData / resetToHeadOffice)
   * loop over heterogeneous model names. Most business models carry an
   * `organisationId` column, but ~28 child tables (leadNote, quoteLine,
   * returnPhoto, schemeInstallment, …) inherit tenancy transitively through a
   * required FK and have no org column of their own. A blanket `deleteMany({})`
   * on such a table would wipe EVERY tenant's rows — the exact cross-org leak
   * this hardening closes.
   *
   * So: use the org column directly when present; otherwise walk the shortest
   * to-one relation to the nearest org-bearing ancestor and scope through it.
   * Returns null when a model cannot be tied to an org at all — the caller MUST
   * then refuse to delete rather than fall back to a global wipe (fail-closed).
   */
  private orgScopedWhere(
    model: string,
    organisationId: string,
    seen: Set<string> = new Set(),
  ): Record<string, any> | null {
    const models = (Prisma as any)?.dmmf?.datamodel?.models ?? [];
    const lc = (n: string) => n.charAt(0).toLowerCase() + n.slice(1);
    const meta = models.find((m: any) => lc(m.name) === model || m.name === model);
    if (!meta || seen.has(meta.name)) return null;
    seen.add(meta.name);
    if (meta.fields.some((f: any) => f.name === 'organisationId')) {
      return { organisationId };
    }
    // Prefer a required to-one relation (the owning parent) over an optional one.
    const relations = meta.fields
      .filter((f: any) => f.kind === 'object' && !f.isList)
      .sort((a: any, b: any) => Number(b.isRequired) - Number(a.isRequired));
    for (const f of relations) {
      const child = this.orgScopedWhere(lc(f.type), organisationId, new Set(seen));
      if (child) return { [f.name]: child };
    }
    return null;
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
        `could not link user ${userId} to store ${storeId}: ` + (err instanceof Error ? err.message : String(err)),
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
    // Journal carries no branch column at all — only `BookNo`, the document
    // series, which the agent resolves to a branch through BookMaster and hands
    // over as `EclatBranchId` exactly as it does for sales and orders.
    ledger: ['EclatBranchId', 'BranchNo', 'LocationId'],
    // No `bags` entry on purpose: ProductionBag has no storeId of its own and
    // hangs off ManufacturingOrder, so a bag inherits whichever branch its order
    // was attributed to. Listing it here would imply a stamping that never runs.
    // Likewise no `stock-movements`: a movement belongs to its piece, and the
    // piece already carries the branch.
  };

  private branchColumnsFor(entity: string): string[] {
    const approved = this.activeGatiIngestion.getStore()?.routing;
    if (approved && approved.branchColumns !== undefined) {
      return [
        ...(approved.branchColumns[entity as keyof typeof approved.branchColumns] ??
          SyncService.DEFAULT_BRANCH_COLUMNS[entity] ?? ['EclatBranchId']),
      ];
    }
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
  static readonly LEGACY_UNASSIGNED_STORE_ID = 'unassigned';

  /** Store ids are global, so every tenant needs a distinct holding-store id. */
  private static unassignedStoreIdFor(organisationId: string): string {
    return `unassigned:${organisationId}`;
  }

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
  private async unattributedStoreId(organisationId: string): Promise<string> {
    const approved = this.activeGatiIngestion.getStore()?.routing;
    const mode =
      approved && approved.unattributedMode !== undefined
        ? approved.unattributedMode
        : (this.config.get<string>('SYNC_UNATTRIBUTED') ?? 'holding').toLowerCase();
    if (mode === 'default') return this.assertStore(organisationId);

    const realBranches = await this.prisma.store.count({
      where: { legacyId: { not: null }, isAggregate: false, organisationId },
    });
    if (realBranches <= 1) return this.assertStore(organisationId);

    // Preserve an existing pre-multi-tenant holding store only for its owner.
    // Every other tenant gets an injective id based on its authoritative org id;
    // the old global `unassigned` id must never be reused across tenants.
    const legacy = await this.prisma.store.findFirst({
      where: {
        id: SyncService.LEGACY_UNASSIGNED_STORE_ID,
        organisationId,
      },
      select: { id: true, isHolding: true },
    });
    if (legacy) {
      if (!legacy.isHolding) {
        await this.prisma.store.update({
          where: { id: legacy.id },
          data: { isHolding: true, status: 'pending', isActive: false },
        });
      }
      return legacy.id;
    }

    const id = SyncService.unassignedStoreIdFor(organisationId);
    const existing = await this.prisma.store.findFirst({
      where: { id, organisationId },
      select: { id: true, isHolding: true },
    });
    if (existing) {
      if (!existing.isHolding) {
        await this.prisma.store.update({
          where: { id: existing.id },
          data: { isHolding: true, status: 'pending', isActive: false },
        });
      }
      return existing.id;
    }

    // Deliberately has no legacyId: it is ours, not a branch of theirs, so the
    // demo purge treats it as non-imported and the sync never tries to update it.
    try {
      await this.prisma.store.create({
        data: {
          id,
          organisationId,
          name: 'Unassigned — needs a branch',
          city: '',
          status: 'pending',
          isActive: false,
          isHolding: true,
        },
      });
    } catch (error) {
      // Two first unattributed batches for the same tenant may race. The
      // deterministic id makes the winner safe to reuse; any other failure is
      // still surfaced rather than swallowed.
      const winner = await this.prisma.store.findFirst({
        where: { id, organisationId },
        select: { id: true, isHolding: true },
      });
      if (!winner) throw error;
      if (!winner.isHolding) {
        await this.prisma.store.update({
          where: { id: winner.id },
          data: { isHolding: true, status: 'pending', isActive: false },
        });
      }
    }
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

  private async branchResolver(entity: string, organisationId: string) {
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
    // Resolve a fallback only when a row actually needs it. This lets a fully
    // attributed batch proceed even if an obsolete process-wide fallback
    // belongs to a different tenant; the first unattributed row still fails
    // closed before any foreign store id can be persisted.
    let fallbackStore: Promise<string> | undefined;
    const fallbackStoreId = () => {
      fallbackStore ??= this.unattributedStoreId(organisationId);
      return fallbackStore;
    };
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
          cache.set(key, await this.resolveStoreByLegacyId(key, organisationId));
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
      return isGlobal ? null : fallbackStoreId();
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
        throw new BadRequestException(`Internal: '${entity}' resolved to no store, but its rows require one.`);
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
  private logAttribution(
    entity: string,
    report: ReturnType<Awaited<ReturnType<SyncService['branchResolver']>>['report']>,
  ) {
    if (report.fellBackToDefault > 0 || report.unknownBranchIds.length > 0) {
      this.logger.warn(
        `sync ${entity}: ${report.fellBackToDefault} row(s) had no usable branch and ` +
          `went to the default store` +
          (report.unknownBranchIds.length ? `; unknown branch ids: ${report.unknownBranchIds.join(', ')}` : '') +
          ` (columns tried: ${report.branchColumns.join(' -> ')})`,
      );
    }
    return report;
  }

  // ── PartyMst -> Party ────────────────────────────────────────────────────────
  async syncParties(organisationId: string, records: Rec[]): Promise<SyncResult> {
    const branch = await this.branchResolver('parties', organisationId);
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
        where: { organisationId_legacyId: { organisationId, legacyId } },
        create: { legacyId, organisationId, ...data },
        update: data,
      });
      upserted++;
    }
    return this.result('parties', records, upserted, skipped, branch.report());
  }

  // ── StyleMst (+Summary) -> Product ───────────────────────────────────────────
  async syncProducts(organisationId: string, records: Rec[]): Promise<SyncResult> {
    const branch = await this.branchResolver('products', organisationId);
    let upserted = 0;
    let skipped = 0;
    const synced: string[] = [];
    const now = new Date();
    for (const r of records) {
      if (r.StyleId == null) {
        skipped++;
        continue;
      }
      const metal = gatiMetal(r);
      const sku = str(r.StyleSKUNo) || str(r.StyleCode) || `STYLE-${r.StyleId}`;
      const storeId = await branch.resolve(r);
      const data = {
        storeId,
        sku,
        name: str(r.StyleCode) || sku,
        styleNumber: sent(r, 'StyleCode', str),
        gatiSyncedAt: now,
        category: categoryFromRow(r) as any,
        metal: metal as any,
        // Product.karat is a non-null Int; when purity is unknown the honest
        // signal is metal=gold_unspecified, and karat falls back to 0 (a design,
        // not a physical piece). Physical StockItems keep null karat below.
        karat: karatFromRow(r) ?? 0,
        weightGrams: dec(r.GrossWt ?? r.ModelWt) ?? '0',
        caratWeight: dec(r.TotDiaWt) ?? '0',
        price: dec(r.MRP ?? r.TagPrice ?? r.EndClientPrice) ?? '0',
        description: str(r.WebDescription),
        bestSeller: bool(r.BestSeller),
        // The summary totals the agent merges into every StyleMst row. Left
        // untouched (undefined) when a row carries none, rather than wiping
        // what an earlier, fuller sync stored.
        composition: (gatiComposition(r, metal as MetalKind) ?? undefined) as Prisma.InputJsonValue | undefined,
      };
      const legacyId = String(r.StyleId);
      const saved = await this.prisma.product.upsert({
        where: { organisationId_legacyId: { organisationId, legacyId } },
        create: { legacyId, organisationId, ...data },
        update: data,
        select: { id: true },
      });
      synced.push(saved.id);
      upserted++;
    }
    await this.refreshGatiTagPrices(organisationId, synced);
    return this.result('products', records, upserted, skipped, branch.report());
  }

  // ── Inward (+Summary) -> StockItem ───────────────────────────────────────────
  async syncStock(organisationId: string, records: Rec[]): Promise<SyncResult> {
    const branch = await this.branchResolver('stock', organisationId);
    const productByStyle = await this.idMap(
      'product',
      records.map((r) => r.StyleId),
      organisationId,
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

    // Source-of-truth split (Module 9). Gati owns a piece until it enters an
    // Eclat-controlled transfer; from the moment that transfer RESERVES the
    // piece (ho_approved/dispatched) or MOVES it (received/acknowledged), Eclat
    // is authoritative for the piece's store/location and status. A legacy sync
    // must not overwrite those two fields for such pieces — otherwise the next
    // sync silently reverts a legitimate transfer (piece jumps back to its old
    // branch, reservation dissolves). Every OTHER field stays Gati-owned and
    // keeps syncing. Evidence is the existing StockTransferItem -> StockTransfer
    // relationship; no marker column is added.
    const legacyIds = records.filter((r) => r.JewelId != null).map((r) => String(r.JewelId));
    const existingItems = legacyIds.length
      ? await this.prisma.stockItem.findMany({
          where: { legacyId: { in: legacyIds }, organisationId },
          select: { id: true, legacyId: true, productId: true },
        })
      : [];
    const idByLegacy = new Map(existingItems.map((s) => [s.legacyId as string, s.id]));
    // The designs these pieces belong to: their style number (Inward carries
    // only StyleId) and their live website variants, for the variant link.
    const linkedProducts = await this.prisma.product.findMany({
      where: { organisationId, id: { in: [...new Set(productByStyle.values())] } },
      select: {
        id: true,
        styleNumber: true,
        variants: {
          where: { source: 'website', status: { not: 'tombstoned' } },
          select: { id: true, karat: true, colour: true },
        },
      },
    });
    const productById = new Map(linkedProducts.map((p) => [p.id, p]));
    // Tag-price ranges move with pieces: recompute for every design a piece
    // in this batch belonged to before, or belongs to now.
    const touchedProducts = new Set(existingItems.map((s) => s.productId));
    const controlled = existingItems.length
      ? await this.prisma.stockTransferItem.findMany({
          where: {
            stockItemId: { in: existingItems.map((s) => s.id) },
            transfer: {
              status: {
                in: ['ho_approved', 'dispatched', 'received', 'acknowledged'],
              },
            },
          },
          select: { stockItemId: true },
        })
      : [];
    const eclatControlled = new Set(controlled.map((i) => i.stockItemId));
    let eclatControlledPreserved = 0;

    for (const r of records) {
      if (r.JewelId == null) {
        skipped++;
        continue;
      }
      const metal = gatiMetal(r);
      const storeId = await branch.resolveRequired(r);
      const productId = productByStyle.get(String(r.StyleId)) ?? null;
      const product = productId ? productById.get(productId) : undefined;
      touchedProducts.add(productId);
      const rawStatus = String(r.Status ?? '')
        .trim()
        .toUpperCase();
      if (rawStatus && !KNOWN_INWARD_STATUSES.has(rawStatus)) {
        unknownStatuses[rawStatus] = (unknownStatuses[rawStatus] ?? 0) + 1;
      }
      const stockStatus = stockStatusFromInward(r);
      byStatus[stockStatus] = (byStatus[stockStatus] ?? 0) + 1;
      const data = {
        storeId,
        productId,
        sku: str(r.InwardSKUNo) || str(r.JewelCode),
        name: str(r.JewelCode),
        // Same keyword rule as the product sync — without this the piece keeps
        // the `other` default and every stock row reads "Other".
        category: categoryFromRow(r) as any,
        metal: metal as any,
        karat: karatFromRow(r),
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
        // HallMarkId is an opaque FK id (33/38), not a hallmark serial, so it is
        // not mapped. certificateNo carries the real certificate number.
        certificateNo: str(r.Jewelry_CertificateNo),
        inwardDate: dt(r.InwardDate),
        legacyUpdatedAt: dt(r.UpdateDate),
        // Columns an older agent build may not send: absent -> left as stored
        // (undefined), never nulled. Inward has no StyleCode; the design's
        // style number comes from the linked StyleMst product.
        styleNumber: product?.styleNumber ?? undefined,
        productCode: sent(r, 'ProductCode', str),
        quantity: sent(r, 'InwardQty', int),
        itemSizeId: sent(r, 'ItemSizeId', str),
        stonePieces: sent(r, 'TotCZPc', int),
        variantId: product ? matchVariant(product.variants, karatFromRow(r), r.ToneCode) : null,
      };
      const legacyId = String(r.JewelId);
      // Eclat-controlled piece: keep syncing every Gati-owned field, but do NOT
      // let the legacy store/location or status overwrite what the transfer set.
      // The CREATE path is never protected — a brand-new piece has no transfer.
      let updateData: typeof data | Omit<typeof data, 'storeId' | 'status'> = data;
      const existingId = idByLegacy.get(legacyId);
      if (existingId && eclatControlled.has(existingId)) {
        // The fields listed in TRANSFER_PROTECTED_STOCK_FIELDS. Destructured
        // literally (rather than looped over the constant) because the omission
        // has to be visible in the type, but the constant is exported so
        // FieldOwnershipService can assert the two agree — see
        // assertConsistentWithSync.
        const { storeId: _omitStore, status: _omitStatus, ...gatiOwned } = data;
        updateData = gatiOwned;
        eclatControlledPreserved++;
      }
      await this.prisma.stockItem.upsert({
        where: { organisationId_legacyId: { organisationId, legacyId } },
        create: { legacyId, organisationId, ...data },
        update: updateData,
      });
      upserted++;
    }
    await this.refreshGatiTagPrices(organisationId, [...touchedProducts]);

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
      // How many rows had their Eclat-owned store/status preserved against the
      // legacy values (pieces mid- or post-transfer). 0 on a normal batch.
      eclatControlledPreserved,
    };
  }

  // ── JewelTrans -> Sale ───────────────────────────────────────────────────────
  async syncSales(organisationId: string, records: Rec[]): Promise<SyncResult> {
    const branch = await this.branchResolver('sales', organisationId);
    const partyByLegacy = await this.idMap(
      'party',
      records.map((r) => r.PartyNo),
      organisationId,
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
        where: { organisationId_legacyId: { organisationId, legacyId } },
        create: { legacyId, organisationId, ...data },
        update: data,
      });
      upserted++;
    }
    return this.result('sales', records, upserted, skipped, branch.report());
  }

  // ── JewelTransInward (+Summary) -> SaleLine ──────────────────────────────────
  async syncSaleLines(organisationId: string, records: Rec[]): Promise<SyncResult> {
    const saleByLegacy = await this.idMap(
      'sale',
      records.map((r) => r.JewelTransId),
      organisationId,
    );
    const stockByLegacy = await this.idMap(
      'stockItem',
      records.map((r) => r.JewelId),
      organisationId,
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
      // What the legacy bill adds up to. Checked against the 8 Jun 2026 backup:
      // MRP = TotMtlAmt + TotDiaAmt + TotCPFAmt + TotImiAmt + TotXchgAmt on
      // 3,275 of 3,275 lines. Reading making from TotHandlingAmt alone
      // reconciled 13 of them: on this ERP the making charge is booked as CPF
      // and TotHandlingAmt is zero on every row, so every synced line was
      // importing with no making charge at all and Rs 1.65 crore of labour and
      // imitation-stone value landed in no column. Both columns are added
      // rather than swapped, because an install that does use TotHandlingAmt
      // leaves CPF at zero and vice versa.
      const money = (...columns: unknown[]): string | undefined => {
        if (columns.every((v) => v == null)) return undefined;
        let total = 0;
        for (const v of columns) total += Number(v) || 0;
        return total.toFixed(2);
      };
      const data = {
        saleId,
        stockItemId: stockByLegacy.get(String(r.JewelId)) ?? null,
        netWeight: dec(r.NetWt),
        metalAmount: dec(r.TotMtlAmt),
        makingAmount: money(r.TotHandlingAmt, r.TotCPFAmt),
        stoneAmount: money(r.TotDiaAmt, r.TotImiAmt),
        exchangeAmount: dec(r.TotXchgAmt),
        discountAmount: dec(r.DiscountAmt),
        lineTotal: dec(r.MRP) ?? '0',
      };
      await this.prisma.saleLine.upsert({
        where: { organisationId_legacyId: { organisationId, legacyId } },
        create: { legacyId, organisationId, ...data },
        update: data,
      });
      upserted++;
    }
    return this.result('sale-lines', records, upserted, skipped);
  }

  // ── Spm_MfgOrder -> ManufacturingOrder ───────────────────────────────────────
  async syncOrders(organisationId: string, records: Rec[]): Promise<SyncResult> {
    const branch = await this.branchResolver('orders', organisationId);
    const partyByLegacy = await this.idMap(
      'party',
      records.flatMap((r) => [r.MadeFor_PartyNo, r.CustomerId]),
      organisationId,
    );
    let upserted = 0;
    let skipped = 0;
    for (const r of records) {
      if (r.OrderId == null) {
        skipped++;
        continue;
      }
      const partyId = partyByLegacy.get(String(r.MadeFor_PartyNo)) ?? partyByLegacy.get(String(r.CustomerId)) ?? null;
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
        status: (STAGE_RANK[str(r.EclatStage) ?? ''] != null ? str(r.EclatStage) : 'booked') as any,
        amount: dec(r.Amount ?? r.GrossAmount) ?? '0',
        poNo: str(r.PoNo),
        legacyUpdatedAt: dt(r.UpdateDate),
      };
      const legacyId = String(r.OrderId);
      await this.prisma.manufacturingOrder.upsert({
        where: { organisationId_legacyId: { organisationId, legacyId } },
        create: { legacyId, organisationId, ...data },
        update: data,
      });
      upserted++;
    }
    return this.result('orders', records, upserted, skipped, branch.report());
  }

  // ── SPM_MfgOrderItem -> ManufacturingOrderItem ───────────────────────────────
  async syncOrderItems(organisationId: string, records: Rec[]): Promise<SyncResult> {
    const orderByLegacy = await this.idMap(
      'manufacturingOrder',
      records.map((r) => r.OrderId),
      organisationId,
    );
    const stockByLegacy = await this.idMap(
      'stockItem',
      records.map((r) => r.Inward_JewelId),
      organisationId,
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
        producedStockItemId: r.Inward_JewelId ? (stockByLegacy.get(String(r.Inward_JewelId)) ?? null) : null,
      };
      const legacyId = String(r.OrderItemId);
      await this.prisma.manufacturingOrderItem.upsert({
        where: { organisationId_legacyId: { organisationId, legacyId } },
        create: { legacyId, organisationId, ...data },
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
  async syncRaw(organisationId: string, table: string, records: Rec[]): Promise<SyncResult> {
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
      // The DB unique is now [organisationId, sourceTable, rowKey], so the upsert
      // is keyed on the acting org — two tenants mirroring the same source table
      // with the same rowKey get two independent rows, never a cross-tenant clash.
      await this.prisma.legacyRow.upsert({
        where: {
          organisationId_sourceTable_rowKey: {
            organisationId,
            sourceTable: table,
            rowKey,
          },
        },
        create: {
          organisationId,
          sourceTable: table,
          rowKey,
          data: data as any,
          legacyUpdatedAt,
        },
        update: { data: data as any, legacyUpdatedAt, syncedAt: new Date() },
      });
      upserted++;
    }
    this.logger.log(`sync raw:${table}: received=${records.length} upserted=${upserted} skipped=${skipped}`);
    return {
      entity: `raw:${table}`,
      received: records.length,
      upserted,
      skipped,
      watermark,
    };
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
  async syncBags(organisationId: string, records: Rec[]): Promise<SyncResult> {
    const orderByLegacy = await this.idMap(
      'manufacturingOrder',
      records.map((r) => r.OrderId),
      organisationId,
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
        where: { organisationId_legacyId: { organisationId, legacyId } },
        create: { legacyId, organisationId, ...data },
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
      // A cancelled (refunded) order is terminal — a stray bag returning through a
      // department must never reopen it. Skip BEFORE the rank comparison: cancelled
      // ranks -1, so any incoming stage (>=0) would otherwise win and un-cancel it.
      if (!current || current.status === 'cancelled') continue;
      const currentRank = STAGE_RANK[current.status] ?? -1;
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
  async syncWebsiteProducts(organisationId: string, records: Rec[]): Promise<SyncResult> {
    // Karat -> MetalKind through the one shared mapping (catalogue/metal.ts).
    // This used to file 9KT and 14KT as 18K, which priced and filtered a 9KT
    // ring as something it is not; an unreadable karat is now gold_unspecified.
    let upserted = 0;
    let skipped = 0;
    let created = 0;
    let enriched = 0;
    let photos = 0;

    for (const r of records) {
      const code = str(r.productCode);
      if (!code) {
        skipped++;
        continue;
      }
      const imageUrl = str(r.imageUrl) || null;
      // Every published photograph of the design, cover first.
      //
      // The feed is shaped variantType[] -> shapes[] -> images[] and always
      // carried several; the agent's first_image() took one and dropped the
      // rest, so a design the client had photographed from four sides reached
      // the catalogue as a single view — and visual search could only ever
      // find it from that one. These are the retouched shots already on the
      // website's CDN, so this stores links and uploads nothing.
      const imageUrls = Array.isArray(r.imageUrls)
        ? (r.imageUrls as unknown[])
            .map((u) => str(u))
            .filter((u): u is string => !!u && /^https?:\/\//i.test(u))
        : [];
      // The cover belongs in the gallery too, and first without duplicating.
      const allImages = [...new Set([...(imageUrl ? [imageUrl] : []), ...imageUrls])];
      const price = dec(r.price);
      const karat = int(r.karat) ?? 0;

      // By our own marker first, so a re-run finds what it created last time
      // rather than colliding on the unique SKU.
      // Every match is org-scoped: an org's website import must never enrich (or
      // adopt the provenance of) another org's product that happens to share a
      // code, name or SKU prefix.
      const composition = websiteComposition(r.composition);
      const existing =
        (await this.prisma.product.findFirst({
          where: { legacyId: `WEB-${code}`, organisationId },
          select: { id: true, imageUrl: true, price: true, legacyId: true, websiteCode: true, composition: true },
        })) ??
        (await this.prisma.product.findFirst({
          where: { name: code, organisationId },
          select: { id: true, imageUrl: true, price: true, legacyId: true, websiteCode: true, composition: true },
        })) ??
        (await this.prisma.product.findFirst({
          where: { sku: { startsWith: `${code}-` }, organisationId },
          select: { id: true, imageUrl: true, price: true, legacyId: true, websiteCode: true, composition: true },
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
        // A Gati design keeps Gati's id; this is where its website code lives.
        if (existing.websiteCode !== code) data.websiteCode = code;
        // Gati's own breakdown wins; the website's only fills a gap.
        if (!existing.composition && composition) data.composition = composition;
        if (Object.keys(data).length) {
          await this.prisma.product.update({
            where: { id: existing.id },
            data,
          });
          enriched++;
          upserted++;
        } else {
          skipped++;
        }
        photos += await this.addWebsiteImages(organisationId, existing.id, allImages);
        continue;
      }

      const fresh = await this.prisma.product.create({
        data: {
          organisationId,
          // Provenance, and it has to be set. `purgeDemo` decides what is seeded
          // demo data by `legacyId IS NULL`, so a website design created without
          // one is indistinguishable from a demo row and gets deleted at go-live
          // — which is exactly what happened the first time this ran. The `WEB-`
          // prefix keeps it clear of any Gati id and makes the import idempotent.
          legacyId: `WEB-${code}`,
          websiteCode: code,
          composition: (composition ?? undefined) as Prisma.InputJsonValue | undefined,
          sku: code,
          name: str(r.name) || code,
          category: categoryFromRow(r) as any,
          metal: karatToMetal(r.metal, karat || null),
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
      photos += await this.addWebsiteImages(organisationId, fresh.id, allImages);
    }

    this.logger.log(
      `sync website-products: created=${created} enriched=${enriched} skipped=${skipped} photos=${photos}`,
    );
    return {
      ...this.result('website-products', records, upserted, skipped),
      created,
      enriched,
      photos,
    };
  }

  /**
   * POST /sync/website/raw — raw, lossless website payloads from the shop-PC
   * agent. The normalise/persist code is the catalogue connector's own
   * (catalogue/website); this only runs it inside the fenced Gati ingestion
   * transaction, so the batch and its receipt commit together.
   */
  syncWebsiteRaw(organisationId: string, body: WebsiteRawDto, catalogue: WebsiteCatalogueService) {
    return catalogue.ingestRawBatch(this.prisma, organisationId, body);
  }

  /**
   * File a website design's published photographs in its gallery.
   *
   * Idempotent on the URL, so re-running the import adds nothing and a photo
   * the client later removes from the site is simply not re-added — it is not
   * deleted either, because the site dropping a shot is not the shop saying the
   * piece was never photographed that way.
   *
   * Never touches a photo somebody uploaded at the counter: those have no
   * matching URL, so they are invisible to this. The cover is left exactly as
   * the caller set it; ordering here only decides display order.
   */
  private async addWebsiteImages(
    organisationId: string,
    productId: string,
    urls: string[],
  ): Promise<number> {
    if (!urls.length) return 0;
    const existing = new Set(
      (
        await this.prisma.productImage.findMany({
          where: { productId },
          select: { url: true },
        })
      ).map((i) => i.url),
    );
    const fresh = urls.filter((u) => !existing.has(u));
    if (!fresh.length) return 0;

    // The design has no cover in the gallery yet only when it had no photos at
    // all, in which case the first one published becomes it.
    const hasPrimary =
      existing.size > 0 &&
      (await this.prisma.productImage.count({ where: { productId, isPrimary: true } })) > 0;

    await this.prisma.productImage.createMany({
      data: fresh.map((url, i) => ({
        organisationId,
        productId,
        url,
        // Provenance, so the lossless website sync adopts these rows instead
        // of adding a second copy of each picture.
        source: 'website',
        sourceUrl: url,
        sourceOrder: urls.indexOf(url),
        isPrimary: !hasPrimary && i === 0,
        sortOrder: existing.size + i,
      })),
    });
    await applyImageOrder(this.prisma, productId);
    return fresh.length;
  }

  // ── Journal -> LedgerEntry ───────────────────────────────────────────────────
  /**
   * The shop's day book.
   *
   * `Journal` was extracted by the agent from the first version and then thrown
   * away — counted in the log, never pushed, no endpoint to push it to. 1,134
   * rows read and discarded on every run, which is why Finance has been empty.
   *
   * It goes to `LedgerEntry`, NOT to `Payment`, and the difference matters.
   * Journal is double-entry accounting: every row names a debit account and a
   * credit account, and plenty of the rows are GST splits ("1.5% CGST") rather
   * than money anyone handed over. Filing that as a customer collection would
   * put tax postings in the till report. Receipts with an actual payment mode
   * live in `VoucherEntry`, which is a separate and much smaller table.
   *
   * `TranType` decides which side of the business a row belongs to — sales are
   * income, purchases are expense — and both accounts are kept: `partyId` is the
   * counterparty (credit side for a sale, debit side for a purchase), so the
   * ledger can be read per customer or per supplier.
   */
  async syncLedger(organisationId: string, records: Rec[]): Promise<SyncResult> {
    const branch = await this.branchResolver('ledger', organisationId);
    // JW = jewellery, M = metal, B = branch-to-branch, prefix SL/PH = sale/purchase.
    const KIND: Record<string, string> = {
      JWSL: 'income',
      BJWSL: 'income',
      MSL: 'income',
      JWPH: 'expense',
      BJWPH: 'expense',
      MPH: 'expense',
      VCH: 'asset',
    };
    const parties = await this.idMap(
      'party',
      records.flatMap((r) => [r.DrAccountNo, r.CrAccountNo]),
      organisationId,
    );

    let upserted = 0;
    let skipped = 0;
    const byKind: Record<string, number> = {};

    for (const r of records) {
      const legacyId = r.Id == null ? null : String(r.Id);
      const amount = dec(r.Amount);
      if (!legacyId || amount == null) {
        skipped++;
        continue;
      }
      const tranType = String(str(r.TranType) ?? '').toUpperCase();
      const kind = KIND[tranType] ?? 'asset';
      byKind[kind] = (byKind[kind] ?? 0) + 1;

      // Income sits on the credit side of the day book, expense on the debit —
      // and the counterparty is whichever account is NOT ours.
      const isIncome = kind === 'income';
      const counterparty = isIncome ? r.CrAccountNo : r.DrAccountNo;

      const data = {
        storeId: await branch.resolve(r),
        partyId: parties.get(String(counterparty)) ?? null,
        kind: kind as any,
        side: (isIncome ? 'credit' : 'debit') as any,
        amount,
        entryDate: dt(r.Jdate) ?? dt(r.EntryDate) ?? new Date(),
        reference: str(r.DocNo) ?? str(r.TransNo),
        // The remark is often the only thing distinguishing a tax posting from
        // the sale it belongs to, so it is kept verbatim.
        narration: [str(r.Remarks), tranType ? `(${tranType})` : null].filter(Boolean).join(' ') || null,
        legacyUpdatedAt: dt(r.EntryDate),
      };
      await this.prisma.ledgerEntry.upsert({
        where: { organisationId_legacyId: { organisationId, legacyId } },
        create: { legacyId, organisationId, ...data },
        update: data,
      });
      upserted++;
    }

    this.logger.log(
      `sync ledger: ${Object.entries(byKind)
        .map(([k, n]) => `${k}=${n}`)
        .join(' ')}`,
    );
    return this.result('ledger', records, upserted, skipped, branch.report());
  }

  // ── InwardHistory -> StockMovement ───────────────────────────────────────────
  /**
   * Where each piece has been.
   *
   * `InwardHistory` is the shop's per-piece movement log — 14,374 rows saying
   * which piece moved, what it became, and when. Nothing was reading it, so
   * `StockMovement` has been empty since the model was written, and a question
   * as ordinary as "when did this ring arrive at Bandra, and where was it
   * before" had no answer in the product.
   *
   * `LocationId` is null throughout on this install (the same column the branch
   * work already found useless), so from/to store cannot be filled from here.
   * That is recorded honestly as null rather than guessed: a movement history
   * showing invented branches would be worse than one showing dates and states.
   * `Jstatus` is the status the piece ENDED UP in — decoded by the same
   * Const_InwardStatus table the stock import uses — and `Trans` is what
   * happened (a sale, a bag issue, a return).
   */
  async syncStockMovements(organisationId: string, records: Rec[]): Promise<SyncResult> {
    const stock = await this.idMap(
      'stockItem',
      records.map((r) => r.JewelId),
      organisationId,
    );
    let upserted = 0;
    let skipped = 0;

    for (const r of records) {
      const legacyId = r.Id == null ? null : String(r.Id);
      const stockItemId = stock.get(String(r.JewelId));
      // A movement for a piece we have not imported is skipped, not invented.
      // The next run picks it up once the piece exists (the agent pushes stock
      // before movements).
      if (!legacyId || !stockItemId) {
        skipped++;
        continue;
      }
      const data = {
        stockItemId,
        fromStoreId: null,
        toStoreId: null,
        status: str(r.Jstatus),
        note: str(r.Trans),
        occurredAt: dt(r.TransactionDate) ?? new Date(),
        legacyUpdatedAt: dt(r.TransactionDate),
      };
      await this.prisma.stockMovement.upsert({
        where: { organisationId_legacyId: { organisationId, legacyId } },
        create: { legacyId, organisationId, ...data },
        update: data,
      });
      upserted++;
    }
    return this.result('stock-movements', records, upserted, skipped);
  }

  // Only updates already-synced rows (never creates), but must still scope by
  // org: legacyId is unique only within an org, so the update target is the
  // composite (organisationId, legacyId) — never another org's row with the
  // same legacyId.
  async syncProductImages(organisationId: string, records: Rec[]): Promise<SyncResult> {
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
          // The design picture is the Gati CAD: a ProductImage of its own, and
          // Product.imageUrl follows the one precedence rule (a pin or a
          // website photo may still come first — see image-order.ts).
          const product = await this.prisma.product.update({
            where: { organisationId_legacyId: { organisationId, legacyId } },
            data: str(r.stlUrl) ? { stlUrl: str(r.stlUrl) } : {},
            select: { id: true },
          });
          const queued = await this.upsertGatiCad(organisationId, product.id, url);
          await applyImageOrder(this.prisma, product.id);
          if (queued) await this.queueImageIndex(organisationId, [queued]);
        } else {
          await this.prisma.stockItem.update({
            where: { organisationId_legacyId: { organisationId, legacyId } },
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

  /**
   * The Gati design picture as a `gati_cad` ProductImage, keyed by its URL.
   * Re-sending the same URL is a no-op (a tombstoned copy is revived); a new
   * URL retires the previous CAD as a tombstone. Other sources are never
   * touched. Returns the id to index when the picture is new or revived.
   */
  private async upsertGatiCad(organisationId: string, productId: string, url: string): Promise<string | null> {
    const existing = await this.prisma.productImage.findFirst({
      where: { organisationId, productId, source: 'gati_cad', sourceUrl: url },
      select: { id: true, status: true },
    });
    let queued: string | null = null;
    if (!existing) {
      const created = await this.prisma.productImage.create({
        data: { organisationId, productId, url, sourceUrl: url, source: 'gati_cad' },
        select: { id: true },
      });
      queued = created.id;
    } else if (existing.status === 'tombstoned') {
      await this.prisma.productImage.update({
        where: { id: existing.id },
        data: { status: 'active', tombstonedAt: null },
      });
      queued = existing.id;
    }
    await this.prisma.productImage.updateMany({
      where: { organisationId, productId, source: 'gati_cad', status: 'active', NOT: { sourceUrl: url } },
      data: { status: 'tombstoned', tombstonedAt: new Date() },
    });
    return queued;
  }

  /**
   * ProductPrice `gati_tag_min` / `gati_tag_max` (source gati): the range of
   * tag prices over a design's in-stock pieces. A design with no priced piece
   * in stock has no range. Only rows whose amount changes are written.
   */
  private async refreshGatiTagPrices(organisationId: string, productIds: (string | null | undefined)[]) {
    const ids = [...new Set(productIds.filter((id): id is string => !!id))];
    const kinds = ['gati_tag_min', 'gati_tag_max'];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const [ranges, current] = await Promise.all([
        this.prisma.stockItem.groupBy({
          by: ['productId'],
          where: { organisationId, productId: { in: chunk }, status: 'in_stock', tagPrice: { gt: 0 } },
          _min: { tagPrice: true },
          _max: { tagPrice: true },
        }),
        this.prisma.productPrice.findMany({
          where: { organisationId, productId: { in: chunk }, variantKey: '', source: 'gati', kind: { in: kinds } },
          select: { productId: true, kind: true, amount: true },
        }),
      ]);
      const have = new Map(current.map((p) => [`${p.productId}|${p.kind}`, p.amount.toString()]));
      const withRange = new Set<string>();
      for (const range of ranges) {
        const productId = range.productId as string;
        withRange.add(productId);
        for (const [kind, amount] of [
          ['gati_tag_min', range._min.tagPrice],
          ['gati_tag_max', range._max.tagPrice],
        ] as const) {
          if (!amount || have.get(`${productId}|${kind}`) === amount.toString()) continue;
          await this.prisma.productPrice.upsert({
            where: { productId_variantKey_source_kind: { productId, variantKey: '', source: 'gati', kind } },
            create: { organisationId, productId, source: 'gati', kind, amount },
            update: { amount, capturedAt: new Date() },
          });
        }
      }
      const stale = chunk.filter((id) => !withRange.has(id));
      if (stale.length) {
        await this.prisma.productPrice.deleteMany({
          where: { organisationId, productId: { in: stale }, variantKey: '', source: 'gati', kind: { in: kinds } },
        });
      }
    }
  }

  private async idMap(
    model: 'party' | 'product' | 'stockItem' | 'sale' | 'manufacturingOrder',
    legacyValues: unknown[],
    organisationId: string,
  ): Promise<Map<string, string>> {
    const ids = [...new Set(legacyValues.filter((v) => v !== null && v !== undefined).map((v) => String(v)))];
    const map = new Map<string, string>();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      // legacyId is unique only within an org, so a foreign-key resolution must
      // never match another org's row — scope every lookup to the acting org.
      const rows = await (this.prisma[model] as any).findMany({
        where: { legacyId: { in: chunk }, organisationId },
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
        (attribution ? ` attributed=${attribution.attributed} default=${attribution.fellBackToDefault}` : ''),
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

/**
 * A column an older agent build may not send: absent -> `undefined` (Prisma
 * leaves the stored value), present -> converted (a real null clears it).
 */
function sent<T>(r: Rec, column: string, convert: (v: unknown) => T): T | undefined {
  return column in r ? convert(r[column]) : undefined;
}

/**
 * Gati metal: karat from the row (explicit, else the SKU token `-14KT-`), mapped
 * by the one shared table. Tone colour (PG/rose) no longer changes the enum.
 */
function gatiMetal(r: Rec): MetalKind {
  return karatToMetal(r.ToneFor, karatFromRow(r));
}

/** Tone code / colour text -> rose | yellow | white; null when unreadable or mixed. */
function toneColour(raw: unknown): string | null {
  const s = String(raw ?? '').toUpperCase();
  const found = new Set<string>();
  if (/PG|RG|ROSE|PINK/.test(s)) found.add('rose');
  if (/YG|YELLOW/.test(s)) found.add('yellow');
  if (/WG|WHITE/.test(s)) found.add('white');
  return found.size === 1 ? [...found][0] : null;
}

/**
 * The website variant a Gati piece is: exactly one live website variant of the
 * design with the piece's karat (and colour, when Gati records a tone). Any
 * doubt — unknown karat, unreadable tone, zero or several candidates — is null.
 */
function matchVariant(
  variants: { id: string; karat: number | null; colour: string | null }[],
  karat: number | null,
  toneCode: unknown,
): string | null {
  if (karat == null) return null;
  const hasTone = str(toneCode) != null;
  const colour = hasTone ? toneColour(toneCode) : null;
  if (hasTone && !colour) return null;
  const hits = variants.filter((v) => v.karat === karat && (!colour || toneColour(v.colour) === colour));
  return hits.length === 1 ? hits[0].id : null;
}

function jsonObject(value: Prisma.JsonValue): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function numberField(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function normaliseRawSourceTable(value: string | undefined): string | null {
  const table = value;
  // SQL identifiers in the source can contain spaces, but never control
  // characters. Bound the operational state key even though LegacyRow's DTO is
  // intentionally source-agnostic and accepts a wider label.
  if (!table?.trim() || table.length > 190 || /[\u0000-\u001f\u007f]/.test(table)) {
    return null;
  }
  return table;
}

function syncSourceTable(routeEntity: string, rawSourceTable?: string): string | null {
  return routeEntity === 'raw'
    ? normaliseRawSourceTable(rawSourceTable)
    : (GATI_SOURCE_TABLE_BY_ROUTE[routeEntity] ?? null);
}

/** Allow only aggregate counters into the audit log; never source rows/text. */
function aggregateSyncResultCounts(result: unknown): Record<string, number> {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return {};
  const view = result as Record<string, unknown>;
  const counts: Record<string, number> = {};
  for (const key of [
    'upserted',
    'skipped',
    'created',
    'updated',
    'enriched',
    'eclatControlledPreserved',
  ]) {
    const value = view[key];
    if (Array.isArray(value)) counts[key] = value.length;
    else if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
      counts[key] = value;
    }
  }
  const attribution = view.attribution;
  if (attribution && typeof attribution === 'object' && !Array.isArray(attribution)) {
    const aggregate = attribution as Record<string, unknown>;
    for (const key of ['attributed', 'fellBackToDefault']) {
      const value = aggregate[key];
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
        counts[key] = value;
      }
    }
  }
  return counts;
}
