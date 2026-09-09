import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LeadSource, LeadStage, Prisma } from '@prisma/client';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'crypto';

import { AuthUser } from '../common/auth-user';
import { AuditService } from '../common/audit.service';
import { SequenceService } from '../common/sequence.service';
import { StoreScopeService } from '../common/store-scope.service';
import { businessDate, resolveTz, startOfDayAgoInTz, zonedParts } from '../common/tz.util';
import { updateOrgSettings, updateOrgSettingsIn, type OrgSettings } from '../config/org-settings';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from './activity.service';
import { IdentityService } from './identity.service';
import type {
  CaptureLeadFromQrDto,
  IssueLeadQrDto,
  LeadAgeingQueryDto,
  LeadSegmentFiltersDto,
  ReplaceLeadAgeingPolicyDto,
  ReplaceRoundRobinPolicyDto,
} from './dto/advanced-crm.dto';

const SEGMENTS_KEY = 'crmLeadSegments';
const AGEING_POLICY_KEY = 'crmLeadAgeingPolicy';
const ROUND_ROBIN_POLICY_KEY = 'crmRoundRobinPolicy';
const ROUND_ROBIN_STATE_KEY = 'crmRoundRobinState';
const DAY_MS = 86_400_000;
/**
 * Local-only QR signing key. Never reachable when NODE_ENV is production, and
 * deliberately self-describing so it can never be mistaken for a real secret in
 * a log, a dump or a screenshot.
 */
const DEVELOPMENT_QR_SECRET = 'development-only-crm-qr-secret-not-for-production';

export interface SavedLeadSegment {
  id: string;
  name: string;
  entity: 'lead';
  filters: LeadSegmentFiltersDto;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

export interface LeadAgeingPolicy {
  defaultHours: number;
  byStage: Partial<Record<LeadStage, number>>;
}

export interface RoundRobinStorePolicy {
  storeId: string;
  eligibleUserIds: string[];
}

export interface RoundRobinPolicy {
  enabled: boolean;
  stores: RoundRobinStorePolicy[];
}

interface QrPayload {
  v: 1;
  organisationId: string;
  storeId: string;
  exp: number;
  nonce: string;
  label: string | null;
  defaultInterest: string | null;
}

interface MergePlan {
  candidateId: string;
  primaryPartyId: string;
  duplicatePartyId: string | null;
  primaryUpdatedAt: string | null;
  duplicateUpdatedAt: string | null;
  /** Hash only; contact values never need to leave the service in a plan. */
  contactFingerprint: string;
  moves: Record<string, number>;
  /**
   * What the merge does to the two Party fields that are protections rather
   * than preferences. In the plan so a reviewer approves the risk outcome, not
   * only a row count — and so the executed write can use these exact values.
   */
  riskCarry: RiskCarry;
  blockers: string[];
}

interface RiskCarry {
  survivorBlacklisted: boolean;
  blacklistSource: 'neither' | 'primary' | 'duplicate' | 'both';
  /** Decimal string, or null when neither side has one (or they disagree). */
  survivorCreditLimit: string | null;
  creditLimitSource: 'neither' | 'primary' | 'duplicate' | 'both_agree' | 'conflict';
}

type Db = PrismaService | Prisma.TransactionClient;

/**
 * Advanced CRM capabilities that deliberately reuse the existing CRM spine.
 *
 * Segments and routing policies are tenant configuration, so they live in the
 * already-concurrency-safe Organisation.settings bag. Customer merge moves every
 * current Party foreign key in one serializable transaction and requires a
 * fresh plan hash; it never offers the dangerous "move some history" shortcut.
 */
@Injectable()
export class AdvancedCrmService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly audit: AuditService,
    private readonly sequence: SequenceService,
    private readonly identity: IdentityService,
    private readonly activity: ActivityService,
    private readonly config: ConfigService,
  ) {}

  // -----------------------------------------------------------------------
  // Customer merge
  // -----------------------------------------------------------------------

  async mergePlan(user: AuthUser, candidateId: string) {
    const plan = await this.buildMergePlan(this.prisma, user.organisationId, candidateId);
    if (!plan) throw new NotFoundException('Merge review not found');
    return { ...plan, planHash: mergePlanHash(plan), executable: plan.blockers.length === 0 };
  }

  async mergeCustomers(user: AuthUser, candidateId: string, expectedPlanHash: string) {
    // Serializable closes the gap between counting the proposed moves and moving
    // them. A concurrent record attaching to either Party makes one transaction
    // retry/fail rather than silently falling outside an approved plan.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            await tx.$queryRaw`
              SELECT "id" FROM "Organisation"
              WHERE "id" = ${user.organisationId}
              FOR UPDATE
            `;
            await tx.$queryRaw`
              SELECT "id" FROM "MergeCandidate"
              WHERE "id" = ${candidateId} AND "organisationId" = ${user.organisationId}
              FOR UPDATE
            `;

            const plan = await this.buildMergePlan(tx, user.organisationId, candidateId);
            if (!plan) throw new NotFoundException('Merge review not found');
            if (mergePlanHash(plan) !== expectedPlanHash) {
              throw new ConflictException(
                'Customer records changed after the merge plan was reviewed. Generate and approve a fresh plan.',
              );
            }
            if (plan.blockers.length) {
              throw new ConflictException({ message: 'This merge is not safe to execute.', blockers: plan.blockers });
            }

            const duplicateId = plan.duplicatePartyId!;
            const primaryId = plan.primaryPartyId;
            const [primary, duplicate] = await Promise.all([
              tx.party.findFirst({ where: { id: primaryId, organisationId: user.organisationId } }),
              tx.party.findFirst({ where: { id: duplicateId, organisationId: user.organisationId } }),
            ]);
            if (!primary || !duplicate) throw new ConflictException('A customer disappeared during merge.');

            // Keep one primary contact of each kind. Moving a second primary
            // without demoting it would leave "the phone number" ambiguous.
            const primaryKinds = (
              await tx.contactPoint.findMany({
                where: { organisationId: user.organisationId, partyId: primaryId, isPrimary: true },
                select: { kind: true },
              })
            ).map((row) => row.kind);
            if (primaryKinds.length) {
              await tx.contactPoint.updateMany({
                where: {
                  organisationId: user.organisationId,
                  partyId: duplicateId,
                  kind: { in: primaryKinds },
                },
                data: { isPrimary: false },
              });
            }

            // Move every current Party relation. This list is intentionally
            // explicit: a future schema relation must be reviewed rather than
            // being guessed at by dynamic SQL.
            await tx.contactPoint.updateMany({ where: { organisationId: user.organisationId, partyId: duplicateId }, data: { partyId: primaryId } });
            await tx.lead.updateMany({ where: { organisationId: user.organisationId, partyId: duplicateId }, data: { partyId: primaryId } });
            await tx.quote.updateMany({ where: { organisationId: user.organisationId, partyId: duplicateId }, data: { partyId: primaryId } });
            await tx.sale.updateMany({ where: { organisationId: user.organisationId, partyId: duplicateId }, data: { partyId: primaryId } });
            await tx.manufacturingOrder.updateMany({ where: { organisationId: user.organisationId, partyId: duplicateId }, data: { partyId: primaryId } });
            await tx.customOrder.updateMany({ where: { organisationId: user.organisationId, partyId: duplicateId }, data: { partyId: primaryId } });
            await tx.ledgerEntry.updateMany({ where: { organisationId: user.organisationId, partyId: duplicateId }, data: { partyId: primaryId } });
            await tx.payment.updateMany({ where: { organisationId: user.organisationId, partyId: duplicateId }, data: { partyId: primaryId } });
            await tx.checkIn.updateMany({ where: { organisationId: user.organisationId, partyId: duplicateId }, data: { partyId: primaryId } });
            await tx.schemeMember.updateMany({ where: { organisationId: user.organisationId, partyId: duplicateId }, data: { partyId: primaryId } });
            await tx.returnRecord.updateMany({ where: { organisationId: user.organisationId, partyId: duplicateId }, data: { partyId: primaryId } });
            await tx.task.updateMany({ where: { organisationId: user.organisationId, partyId: duplicateId }, data: { partyId: primaryId } });
            await tx.activityEvent.updateMany({ where: { organisationId: user.organisationId, partyId: duplicateId }, data: { partyId: primaryId } });
            await tx.conversation.updateMany({ where: { organisationId: user.organisationId, partyId: duplicateId }, data: { partyId: primaryId } });
            await tx.productInteraction.updateMany({ where: { organisationId: user.organisationId, partyId: duplicateId }, data: { partyId: primaryId } });
            await tx.attributionTouch.updateMany({ where: { organisationId: user.organisationId, partyId: duplicateId }, data: { partyId: primaryId } });
            await tx.leadQualification.updateMany({ where: { organisationId: user.organisationId, partyId: duplicateId }, data: { partyId: primaryId } });

            // Preserve useful blanks and the deleted row's identifiers without
            // overwriting facts a human already chose on the primary customer.
            const primaryAttributes = asObject(primary.attributes);
            const duplicateAttributes = asObject(duplicate.attributes);
            const history = Array.isArray(primaryAttributes._crmMergeHistory)
              ? primaryAttributes._crmMergeHistory
              : [];
            await tx.party.update({
              where: { id: primaryId },
              data: {
                storeId: primary.storeId ?? duplicate.storeId,
                code: primary.code ?? duplicate.code,
                legalName: primary.legalName ?? duplicate.legalName,
                phone: primary.phone ?? duplicate.phone,
                whatsapp: primary.whatsapp ?? duplicate.whatsapp,
                email: primary.email ?? duplicate.email,
                addressLine1: primary.addressLine1 ?? duplicate.addressLine1,
                addressLine2: primary.addressLine2 ?? duplicate.addressLine2,
                city: primary.city ?? duplicate.city,
                state: primary.state ?? duplicate.state,
                country: primary.country ?? duplicate.country,
                pincode: primary.pincode ?? duplicate.pincode,
                birthday: primary.birthday ?? duplicate.birthday,
                anniversary: primary.anniversary ?? duplicate.anniversary,
                legacyId: primary.legacyId ?? duplicate.legacyId,
                importBatchId: primary.importBatchId ?? duplicate.importBatchId,
                types: [...new Set([...primary.types, ...duplicate.types])],
                // Blacklist and credit limit are protections, not preferences,
                // so they do not follow the "primary wins, duplicate fills
                // blanks" rule the fields above use. Both come from the plan a
                // human approved rather than being recomputed here, so the
                // review and the write can never disagree: either side being
                // blacklisted keeps the survivor blacklisted (deleting the
                // blocked twin must not produce a clean customer), and two
                // different non-null credit limits are a blocker above — never
                // reconciled by picking the larger one.
                isBlacklisted: plan.riskCarry.survivorBlacklisted,
                creditLimit: plan.riskCarry.survivorCreditLimit,
                attributes: {
                  ...duplicateAttributes,
                  ...primaryAttributes,
                  _crmMergeHistory: [
                    ...history,
                    {
                      duplicatePartyId: duplicateId,
                      duplicateLegacyId: duplicate.legacyId ?? null,
                      duplicateImportBatchId: duplicate.importBatchId ?? null,
                      candidateId,
                      mergedAt: new Date().toISOString(),
                    },
                  ],
                } as Prisma.InputJsonValue,
              },
            });

            // Repoint every other review before deleting the duplicate. Reviews
            // that would become "primary vs itself" are closed as redundant.
            const related = await tx.mergeCandidate.findMany({
              where: {
                organisationId: user.organisationId,
                id: { not: candidateId },
                OR: [{ primaryPartyId: duplicateId }, { duplicatePartyId: duplicateId }],
              },
            });
            for (const review of related) {
              const nextPrimary = review.primaryPartyId === duplicateId ? primaryId : review.primaryPartyId;
              const nextDuplicate = review.duplicatePartyId === duplicateId ? primaryId : review.duplicatePartyId;
              const selfReview = nextDuplicate === nextPrimary;
              await tx.mergeCandidate.update({
                where: { id: review.id },
                data: selfReview
                  ? {
                      primaryPartyId: nextPrimary,
                      duplicatePartyId: null,
                      status: 'rejected',
                      reason: 'Closed automatically because another approved merge made both sides the same customer.',
                      resolvedById: user.id,
                      resolvedAt: new Date(),
                    }
                  : { primaryPartyId: nextPrimary, duplicatePartyId: nextDuplicate },
              });
            }

            await tx.mergeCandidate.update({
              where: { id: candidateId },
              data: {
                duplicatePartyId: null,
                status: 'merged',
                reason: `Merged duplicate ${duplicateId} into primary ${primaryId} after an approved plan.`,
                resolvedById: user.id,
                resolvedAt: new Date(),
              },
            });
            await tx.party.delete({ where: { id: duplicateId } });

            await this.audit.record(
              user,
              {
                action: 'crm.customers_merged',
                entityType: 'Party',
                entityId: primaryId,
                storeId: primary.storeId ?? duplicate.storeId,
                summary: 'Merged a reviewed duplicate customer into the selected primary customer.',
                metadata: {
                  candidateId,
                  duplicatePartyId: duplicateId,
                  planHash: expectedPlanHash,
                  moves: plan.moves,
                  // What happened to the two protected fields, so an auditor
                  // can answer "did this merge clear a blacklist?" without
                  // reconstructing two deleted rows.
                  riskCarry: { ...plan.riskCarry },
                },
              },
              tx,
            );
            await this.activity.record(
              {
                organisationId: user.organisationId,
                type: 'customer.merged',
                summary: 'A reviewed duplicate customer was merged into this profile.',
                partyId: primaryId,
                storeId: primary.storeId ?? duplicate.storeId,
                actorUserId: user.id,
                entityType: 'Party',
                entityId: primaryId,
                channel: 'system',
                dedupeKey: `crm-merge:${candidateId}`,
                metadata: { candidateId, duplicatePartyId: duplicateId, moves: plan.moves },
              },
              tx,
            );

            return { merged: true, candidateId, primaryPartyId: primaryId, duplicatePartyId: duplicateId, moves: plan.moves };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (isSerializationFailure(error) && attempt < 2) continue;
        throw error;
      }
    }
    throw new ConflictException('The merge could not be serialized. Generate a fresh plan and retry.');
  }

  private async buildMergePlan(db: Db, organisationId: string, candidateId: string): Promise<MergePlan | null> {
    const candidate = await db.mergeCandidate.findFirst({
      where: { id: candidateId, organisationId },
      select: {
        id: true,
        status: true,
        primaryPartyId: true,
        duplicatePartyId: true,
        primaryParty: {
          select: {
            id: true, updatedAt: true, types: true, legacyId: true, user: { select: { id: true } },
            gstin: true, pan: true, aadhaar: true, isBlacklisted: true, creditLimit: true,
          },
        },
        duplicateParty: {
          select: {
            id: true, updatedAt: true, types: true, legacyId: true, user: { select: { id: true } },
            gstin: true, pan: true, aadhaar: true, isBlacklisted: true, creditLimit: true,
          },
        },
      },
    });
    if (!candidate) return null;

    const blockers: string[] = [];
    if (candidate.status !== 'open') blockers.push(`Merge review is already ${candidate.status}.`);
    if (!candidate.duplicatePartyId || !candidate.duplicateParty) blockers.push('The review has no duplicate customer to merge.');
    if (candidate.primaryPartyId === candidate.duplicatePartyId) blockers.push('Primary and duplicate are the same customer.');
    if (!candidate.primaryParty) blockers.push('The primary customer no longer exists.');
    if (candidate.duplicateParty?.user || candidate.primaryParty?.user) blockers.push('A selected customer is linked to a staff login and cannot be merged.');
    const structural = [...(candidate.primaryParty?.types ?? []), ...(candidate.duplicateParty?.types ?? [])]
      .filter((t) => ['staff', 'salesperson', 'branch'].includes(t));
    if (structural.length) blockers.push(`A selected customer has protected role(s): ${[...new Set(structural)].join(', ')}.`);
    if (
      candidate.primaryParty?.legacyId && candidate.duplicateParty?.legacyId &&
      candidate.primaryParty.legacyId !== candidate.duplicateParty.legacyId
    ) {
      blockers.push('Both customers have different import identities; merging would let the next source sync recreate one of them.');
    }
    for (const field of ['gstin', 'pan', 'aadhaar'] as const) {
      const a = candidate.primaryParty?.[field]?.replace(/\s/g, '').toUpperCase();
      const b = candidate.duplicateParty?.[field]?.replace(/\s/g, '').toUpperCase();
      if (a && b && a !== b) blockers.push(`The customers have conflicting ${field.toUpperCase()} values.`);
    }
    const riskCarry = mergeRiskCarry(candidate.primaryParty, candidate.duplicateParty);
    if (riskCarry.creditLimitSource === 'conflict') {
      blockers.push(
        'The customers have different credit limits. Make them agree, or clear the one that is wrong, before merging.',
      );
    }

    const duplicateId = candidate.duplicatePartyId;
    const moves: Record<string, number> = Object.fromEntries(
      await Promise.all(
        [
          ['contactPoints', 'contactPoint'], ['leads', 'lead'], ['quotes', 'quote'], ['sales', 'sale'],
          ['manufacturingOrders', 'manufacturingOrder'], ['customOrders', 'customOrder'],
          ['ledgerEntries', 'ledgerEntry'], ['payments', 'payment'], ['checkIns', 'checkIn'],
          ['schemeMembers', 'schemeMember'], ['returns', 'returnRecord'], ['tasks', 'task'],
          ['activityEvents', 'activityEvent'], ['conversations', 'conversation'],
          ['productInteractions', 'productInteraction'], ['attributionTouches', 'attributionTouch'],
          ['leadQualifications', 'leadQualification'],
        ].map(async ([label, model]) => {
          if (!duplicateId) return [label, 0] as const;
          const delegate = (db as unknown as Record<string, { count(args: unknown): Promise<number> }>)[model];
          return [label, await delegate.count({ where: { organisationId, partyId: duplicateId } })] as const;
        }),
      ),
    );
    if (duplicateId) {
      moves.mergeReviews = await db.mergeCandidate.count({
        where: {
          organisationId,
          id: { not: candidateId },
          OR: [{ primaryPartyId: duplicateId }, { duplicatePartyId: duplicateId }],
        },
      });
    } else {
      moves.mergeReviews = 0;
    }
    const contacts = duplicateId
      ? await db.contactPoint.findMany({
          where: { organisationId, partyId: { in: [candidate.primaryPartyId, duplicateId] } },
          orderBy: { id: 'asc' },
          select: { id: true, partyId: true, kind: true, valueNormalized: true, isPrimary: true, updatedAt: true },
        })
      : [];
    const contactFingerprint = createHash('sha256').update(stableStringify(contacts)).digest('hex');

    return {
      candidateId: candidate.id,
      primaryPartyId: candidate.primaryPartyId,
      duplicatePartyId: duplicateId,
      primaryUpdatedAt: candidate.primaryParty?.updatedAt.toISOString() ?? null,
      duplicateUpdatedAt: candidate.duplicateParty?.updatedAt.toISOString() ?? null,
      contactFingerprint,
      moves,
      riskCarry,
      blockers,
    };
  }

  // -----------------------------------------------------------------------
  // Dynamic and saved lead segments
  // -----------------------------------------------------------------------

  async listSegments(user: AuthUser): Promise<SavedLeadSegment[]> {
    const settings = await this.settings(user.organisationId);
    return normaliseSegments(settings[SEGMENTS_KEY]);
  }

  async createSegment(user: AuthUser, name: string, filters: LeadSegmentFiltersDto) {
    await this.validateSegmentScope(user, filters);
    const now = new Date().toISOString();
    const segment: SavedLeadSegment = {
      id: randomUUID(),
      name: name.trim(),
      entity: 'lead',
      filters: cleanSegmentFilters(filters),
      createdById: user.id,
      createdAt: now,
      updatedAt: now,
    };
    await updateOrgSettings(this.prisma, user.organisationId, (settings) => {
      const current = normaliseSegments(settings[SEGMENTS_KEY]);
      if (current.length >= 100) throw new BadRequestException('A tenant may save at most 100 lead segments.');
      if (current.some((s) => s.name.toLocaleLowerCase() === segment.name.toLocaleLowerCase())) {
        throw new ConflictException('A lead segment with this name already exists.');
      }
      return { ...settings, [SEGMENTS_KEY]: [...current, segment] };
    });
    await this.audit.record(user, {
      action: 'crm.segment_created', entityType: 'Organisation', entityId: user.organisationId,
      summary: `Saved lead segment "${segment.name}".`, metadata: { segmentId: segment.id },
    });
    return segment;
  }

  async deleteSegment(user: AuthUser, segmentId: string) {
    let removed: SavedLeadSegment | undefined;
    await updateOrgSettings(this.prisma, user.organisationId, (settings) => {
      const current = normaliseSegments(settings[SEGMENTS_KEY]);
      removed = current.find((s) => s.id === segmentId);
      if (!removed) throw new NotFoundException('Lead segment not found');
      return { ...settings, [SEGMENTS_KEY]: current.filter((s) => s.id !== segmentId) };
    });
    await this.audit.record(user, {
      action: 'crm.segment_deleted', entityType: 'Organisation', entityId: user.organisationId,
      summary: `Deleted lead segment "${removed!.name}".`, metadata: { segmentId },
    });
    return { deleted: true, id: segmentId };
  }

  async savedSegmentResults(user: AuthUser, segmentId: string, limit = 100) {
    const segment = (await this.listSegments(user)).find((s) => s.id === segmentId);
    if (!segment) throw new NotFoundException('Lead segment not found');
    return { segment, ...(await this.querySegment(user, segment.filters, limit)) };
  }

  async previewSegment(user: AuthUser, filters: LeadSegmentFiltersDto, limit = 100) {
    await this.validateSegmentScope(user, filters);
    return this.querySegment(user, cleanSegmentFilters(filters), limit);
  }

  private async querySegment(user: AuthUser, filters: LeadSegmentFiltersDto, limit: number) {
    const where = await this.segmentWhere(user, filters);
    const take = Math.min(Math.max(limit, 1), 200);
    const [total, rows] = await Promise.all([
      this.prisma.lead.count({ where }),
      this.prisma.lead.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take,
        select: {
          id: true, ref: true, customerName: true, phone: true, value: true, source: true,
          stage: true, outcome: true, interest: true, storeId: true, ownerId: true,
          createdAt: true, lastActivity: true, updatedAt: true,
          owner: { select: { id: true, name: true } },
          store: { select: { id: true, name: true, timezone: true } },
        },
      }),
    ]);
    return { total, returned: rows.length, results: rows.map((row) => this.leadSummary(row)) };
  }

  private async segmentWhere(user: AuthUser, filters: LeadSegmentFiltersDto): Promise<Prisma.LeadWhereInput> {
    const requested = filters.storeIds?.length ? filters.storeIds : user.storeIds;
    const allowed = requested.filter((id) => user.storeIds.includes(id));
    const where: Prisma.LeadWhereInput = {
      organisationId: user.organisationId,
      storeId: { in: allowed },
    };
    if (user.role === 'salesperson') where.ownerId = user.id;
    else if (filters.ownerIds?.length) where.ownerId = { in: filters.ownerIds };
    if (filters.sources?.length) where.source = { in: filters.sources };
    if (filters.stages?.length) where.stage = { in: filters.stages };
    if (filters.outcomes?.length) where.outcome = { in: filters.outcomes };
    if (filters.minValue != null || filters.maxValue != null) {
      where.value = {
        ...(filters.minValue != null ? { gte: filters.minValue } : {}),
        ...(filters.maxValue != null ? { lte: filters.maxValue } : {}),
      };
    }
    if (filters.createdFrom || filters.createdTo) {
      where.createdAt = {
        ...(filters.createdFrom ? { gte: parseYmd(filters.createdFrom) } : {}),
        ...(filters.createdTo ? { lt: addUtcDays(parseYmd(filters.createdTo), 1) } : {}),
      };
    }
    if (filters.hasPhone === true) where.phone = { not: null };
    if (filters.hasPhone === false) where.phone = null;

    if (filters.inactiveForDays != null) {
      const stores = await this.prisma.store.findMany({
        where: { organisationId: user.organisationId, id: { in: allowed } },
        select: { id: true, timezone: true },
      });
      const now = new Date();
      where.AND = [
        {
          OR: stores.map((store) => {
            const cutoff = localDayStartAgo(now, resolveTz(store.timezone), filters.inactiveForDays!);
            return {
              storeId: store.id,
              OR: [
                { lastActivity: { lt: cutoff } },
                { lastActivity: null, createdAt: { lt: cutoff } },
              ],
            };
          }),
        },
      ];
    }
    return where;
  }

  private async validateSegmentScope(user: AuthUser, filters: LeadSegmentFiltersDto) {
    if (filters.minValue != null && filters.maxValue != null && filters.minValue > filters.maxValue) {
      throw new BadRequestException('minValue cannot exceed maxValue.');
    }
    if (filters.createdFrom) parseYmd(filters.createdFrom);
    if (filters.createdTo) parseYmd(filters.createdTo);
    for (const storeId of filters.storeIds ?? []) this.scope.assertStoreAllowed(user, storeId);
    if (user.role === 'salesperson' && filters.ownerIds?.some((id) => id !== user.id)) {
      throw new BadRequestException('A salesperson can only segment their own leads.');
    }
    if (filters.ownerIds?.length) {
      const count = await this.prisma.user.count({
        where: {
          id: { in: filters.ownerIds }, organisationId: user.organisationId, isActive: true,
          userStores: { some: { storeId: { in: filters.storeIds?.length ? filters.storeIds : user.storeIds } } },
        },
      });
      if (count !== filters.ownerIds.length) throw new BadRequestException('A segment owner is not active in the selected locations.');
    }
  }

  // -----------------------------------------------------------------------
  // Lead ageing and SLA
  // -----------------------------------------------------------------------

  async getAgeingPolicy(user: AuthUser): Promise<LeadAgeingPolicy> {
    return normaliseAgeingPolicy((await this.settings(user.organisationId))[AGEING_POLICY_KEY]);
  }

  async replaceAgeingPolicy(user: AuthUser, input: ReplaceLeadAgeingPolicyDto) {
    const policy = normaliseAgeingPolicy(input, true);
    await updateOrgSettings(this.prisma, user.organisationId, (settings) => ({
      ...settings, [AGEING_POLICY_KEY]: policy,
    }));
    await this.audit.record(user, {
      action: 'crm.lead_ageing_policy_updated', entityType: 'Organisation', entityId: user.organisationId,
      summary: 'Updated lead ageing and response SLA policy.', metadata: policy,
    });
    return policy;
  }

  async leadAgeing(user: AuthUser, query: LeadAgeingQueryDto) {
    if (query.storeId) this.scope.assertStoreAllowed(user, query.storeId);
    const where: Prisma.LeadWhereInput = {
      organisationId: user.organisationId,
      ...this.scope.storeFilter(user, query.storeId),
      ...(query.stage ? { stage: query.stage } : {}),
      // `all` means every outcome, so it contributes no filter. It used to fall
      // through to `outcome: 'open'`, which made a documented query value a no-op.
      ...(query.outcome === 'all' ? {} : { outcome: query.outcome ?? 'open' }),
      ...(user.role === 'salesperson' ? { ownerId: user.id } : {}),
    };
    const policy = await this.getAgeingPolicy(user);
    const now = new Date();

    /*
     * The summary is counted in the database, over the whole authorised set.
     *
     * It used to be counted in JavaScript over the same 1,000-row page the list
     * returns, so a tenant with more open leads than that read a total that
     * stopped at 1,000 and bucket counts that stopped with it — with no flag
     * saying so. Worse, the page is ordered by lastActivity and Postgres sorts
     * NULLs last, so the rows dropped at the cap were exactly the never-touched
     * leads this board exists to surface.
     */
    const summary = await this.ageingSummary(where, policy, now);

    // The bucket filter is a database predicate too. Applying it after the cap
    // meant `?bucket=untouched` on a large tenant returned an empty list while
    // untouched leads existed.
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 200);
    const rows = await this.prisma.lead.findMany({
      where: query.bucket ? { AND: [where, bucketFilter(query.bucket, policy, now)] } : where,
      orderBy: [
        // Never-touched first: the most urgent thing on an SLA board, and what
        // a plain `asc` would push to the very end.
        { lastActivity: { sort: 'asc', nulls: 'first' } },
        { createdAt: 'asc' },
        { id: 'asc' },
      ],
      take: limit,
      select: {
        id: true, ref: true, customerName: true, phone: true, source: true, stage: true,
        outcome: true, interest: true, storeId: true, ownerId: true, createdAt: true,
        lastActivity: true, updatedAt: true, value: true,
        owner: { select: { id: true, name: true } },
        store: { select: { id: true, name: true, timezone: true } },
      },
    });
    const results = rows.map((row) => ({
      ...this.leadSummary(row),
      ...evaluateLeadAge(row, policy, now, resolveTz(row.store.timezone)),
    }));

    return { asOf: now.toISOString(), policy, summary, returned: results.length, results };
  }

  /**
   * Bucket counts over every lead the caller may see, not over one page of them.
   *
   * Four counts in one transaction so they describe a single snapshot, and the
   * total is their sum rather than a fifth query that could disagree with them.
   * The buckets partition the set: every lead has exactly one stage, and the
   * three dated ranges plus `lastActivity IS NULL` cover every row.
   */
  private async ageingSummary(where: Prisma.LeadWhereInput, policy: LeadAgeingPolicy, now: Date) {
    const buckets = ['untouched', 'breached', 'due_soon', 'fresh'] as const;
    const counts = await this.prisma.$transaction(
      buckets.map((bucket) =>
        this.prisma.lead.count({ where: { AND: [where, bucketFilter(bucket, policy, now)] } }),
      ),
    );
    return {
      total: counts.reduce((sum, n) => sum + n, 0),
      fresh: counts[3],
      due_soon: counts[2],
      breached: counts[1],
      untouched: counts[0],
    };
  }

  // -----------------------------------------------------------------------
  // Fair, persistent round-robin assignment
  // -----------------------------------------------------------------------

  async getRoundRobinPolicy(user: AuthUser): Promise<RoundRobinPolicy> {
    return normaliseRoundRobinPolicy((await this.settings(user.organisationId))[ROUND_ROBIN_POLICY_KEY]);
  }

  async replaceRoundRobinPolicy(user: AuthUser, input: ReplaceRoundRobinPolicyDto) {
    const storeIds = input.stores.map((s) => s.storeId);
    if (new Set(storeIds).size !== storeIds.length) throw new BadRequestException('Each location may appear only once.');
    for (const id of storeIds) this.scope.assertStoreAllowed(user, id);

    for (const store of input.stores) {
      if (!store.eligibleUserIds?.length) continue;
      const count = await this.prisma.user.count({
        where: {
          id: { in: store.eligibleUserIds }, organisationId: user.organisationId,
          role: 'salesperson', isActive: true, approvalStatus: 'approved',
          userStores: { some: { storeId: store.storeId } },
        },
      });
      if (count !== store.eligibleUserIds.length) {
        throw new BadRequestException('Every chosen round-robin user must be an active, approved salesperson in that location.');
      }
    }
    const policy: RoundRobinPolicy = {
      enabled: input.enabled,
      stores: input.stores.map((s) => ({ storeId: s.storeId, eligibleUserIds: [...(s.eligibleUserIds ?? [])].sort() })),
    };
    await updateOrgSettings(this.prisma, user.organisationId, (settings) => ({
      ...settings, [ROUND_ROBIN_POLICY_KEY]: policy,
    }));
    await this.audit.record(user, {
      action: 'crm.round_robin_policy_updated', entityType: 'Organisation', entityId: user.organisationId,
      summary: `Updated round-robin policy for ${policy.stores.length} location(s).`,
      metadata: { enabled: policy.enabled, storeIds },
    });
    return policy;
  }

  async roundRobinAssign(user: AuthUser, entity: 'lead' | 'conversation', entityId: string) {
    const result = await this.assignRoundRobin(user.organisationId, entity, entityId, user);
    if (!result) throw new BadRequestException('Round-robin is disabled or not configured for this location.');
    return result;
  }

  /** Called by inbound ingestion only after the customer message is safely stored. */
  async autoAssignInbound(organisationId: string, conversationId: string, leadId: string | null) {
    try {
      const assigned = await this.assignRoundRobin(organisationId, 'conversation', conversationId, null);
      if (assigned && leadId) {
        const { count } = await this.prisma.lead.updateMany({
          where: { id: leadId, organisationId, storeId: assigned.storeId, ownerId: null },
          data: { ownerId: assigned.assignedUserId },
        });
        // A second ownership change, on a different record from the one
        // assignRoundRobin audited. It needs its own row, and only when it
        // actually moved: the `ownerId: null` guard makes a replay a no-op, and
        // a no-op must not manufacture an audit entry.
        if (count) {
          await this.audit.recordSystem(organisationId, 'round_robin', {
            action: 'crm.round_robin_assigned',
            entityType: 'Lead',
            entityId: leadId,
            storeId: assigned.storeId,
            summary: 'The lead behind an inbound conversation was given the same owner.',
            metadata: {
              assignedUserId: assigned.assignedUserId,
              previousOwnerId: null,
              sequence: assigned.sequence,
              method: 'automatic_round_robin_conversation_lead',
              conversationId,
            },
          });
        }
      }
      return assigned;
    } catch {
      // Assignment automation is advisory plumbing. An inbound message has
      // already been stored and must never turn into a provider retry because a
      // tenant has no eligible salesperson or a settings row is malformed.
      return null;
    }
  }

  private async assignRoundRobin(
    organisationId: string,
    entity: 'lead' | 'conversation',
    entityId: string,
    actor: AuthUser | null,
  ): Promise<{ entity: string; entityId: string; storeId: string; assignedUserId: string; sequence: number; idempotent: boolean } | null> {
    return this.prisma.$transaction(async (tx) => {
      const orgRows = await tx.$queryRaw<{ settings: unknown }[]>`
        SELECT "settings" FROM "Organisation" WHERE "id" = ${organisationId} FOR UPDATE
      `;
      if (!orgRows.length) return null;
      const settings = asObject(orgRows[0].settings);
      const policy = normaliseRoundRobinPolicy(settings[ROUND_ROBIN_POLICY_KEY]);
      if (!policy.enabled) return null;

      const target = entity === 'lead'
        ? (await tx.$queryRaw<{ id: string; storeId: string; assignedUserId: string | null }[]>`
            SELECT "id", "storeId", "ownerId" AS "assignedUserId"
            FROM "Lead" WHERE "id" = ${entityId} AND "organisationId" = ${organisationId} FOR UPDATE
          `)[0]
        : (await tx.$queryRaw<{ id: string; storeId: string | null; assignedUserId: string | null }[]>`
            SELECT "id", "storeId", "assignedUserId"
            FROM "Conversation" WHERE "id" = ${entityId} AND "organisationId" = ${organisationId} FOR UPDATE
          `)[0];
      if (!target) throw new NotFoundException(`${entity === 'lead' ? 'Lead' : 'Conversation'} not found`);
      if (!target.storeId) throw new BadRequestException('Choose a location before assigning this record.');
      if (actor) this.scope.assertStoreAllowed(actor, target.storeId);
      if (target.assignedUserId) {
        return {
          entity, entityId, storeId: target.storeId, assignedUserId: target.assignedUserId,
          sequence: currentRoundRobinSequence(settings, target.storeId), idempotent: true,
        };
      }

      const storePolicy = policy.stores.find((s) => s.storeId === target.storeId);
      if (!storePolicy) return null;
      const eligible = await tx.user.findMany({
        where: {
          organisationId, role: 'salesperson', isActive: true, approvalStatus: 'approved',
          ...(storePolicy.eligibleUserIds.length ? { id: { in: storePolicy.eligibleUserIds } } : {}),
          userStores: { some: { storeId: target.storeId } },
        },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      if (!eligible.length) throw new BadRequestException('No active salesperson is eligible for this location.');

      const state = normaliseRoundRobinState(settings[ROUND_ROBIN_STATE_KEY]);
      const previous = state[target.storeId]?.lastUserId;
      const previousIndex = previous ? eligible.findIndex((u) => u.id === previous) : -1;
      const selected = eligible[(previousIndex + 1) % eligible.length];
      const sequence = (state[target.storeId]?.sequence ?? 0) + 1;

      await updateOrgSettingsIn(tx, organisationId, (current) => {
        const liveState = normaliseRoundRobinState(current[ROUND_ROBIN_STATE_KEY]);
        return {
          ...current,
          [ROUND_ROBIN_STATE_KEY]: {
            ...liveState,
            [target.storeId!]: { lastUserId: selected.id, sequence, updatedAt: new Date().toISOString() },
          },
        };
      });

      if (entity === 'lead') {
        await tx.lead.update({ where: { id: entityId }, data: { ownerId: selected.id } });
      } else {
        await tx.conversation.update({
          where: { id: entityId },
          data: { assignedUserId: selected.id, handling: 'human', handoffReason: 'Assigned by the configured fair round-robin queue.' },
        });
      }

      /*
       * Ownership just changed, so the trail records it — whether or not a
       * person asked for it.
       *
       * This used to be `if (actor)`, which meant the two automatic callers
       * (an inbound message, a public QR submission) both reassigned a lead or
       * conversation with no AuditLog row at all. The interactive route was the
       * only one that left evidence, so the assignments a tenant could not see
       * coming were exactly the ones it could not audit afterwards.
       *
       * `tx` on both forms is deliberate: an audit failure rolls the assignment
       * back rather than leaving an unrecorded change of hands.
       */
      const trail = {
        action: 'crm.round_robin_assigned',
        entityType: entity === 'lead' ? 'Lead' : 'Conversation',
        entityId,
        storeId: target.storeId,
        summary: 'Assigned through the fair round-robin queue.',
        metadata: {
          assignedUserId: selected.id,
          // Read from the locked row rather than hardcoded. Today the guard
          // above means this is always null — an already-owned record returns
          // early as idempotent, so a replayed webhook writes no second row —
          // but the trail should still state what it replaced.
          previousOwnerId: target.assignedUserId,
          sequence,
          method: actor ? 'manual_round_robin' : 'automatic_round_robin',
        },
      };
      if (actor) {
        await this.audit.record(actor, trail, tx);
      } else {
        await this.audit.recordSystem(organisationId, 'round_robin', trail, tx);
      }
      await this.activity.record({
        organisationId, type: `${entity}.assigned`, summary: 'Assigned through the fair round-robin queue.',
        ...(entity === 'lead' ? { leadId: entityId } : {}), storeId: target.storeId,
        actorUserId: actor?.id ?? null, entityType: entity === 'lead' ? 'Lead' : 'Conversation', entityId,
        channel: 'system', dedupeKey: `round-robin:${entity}:${entityId}`,
        metadata: { assignedUserId: selected.id, sequence },
      }, tx);
      return { entity, entityId, storeId: target.storeId, assignedUserId: selected.id, sequence, idempotent: false };
    });
  }

  // -----------------------------------------------------------------------
  // Opaque, expiring QR lead capture
  // -----------------------------------------------------------------------

  async issueLeadQr(user: AuthUser, input: IssueLeadQrDto) {
    this.scope.assertStoreAllowed(user, input.storeId);
    const store = await this.prisma.store.findFirst({
      where: { id: input.storeId, organisationId: user.organisationId, isAggregate: false },
      select: { id: true, name: true },
    });
    if (!store) throw new NotFoundException('Location not found');
    const expiresInHours = input.expiresInHours ?? 24 * 30;
    const payload: QrPayload = {
      v: 1,
      organisationId: user.organisationId,
      storeId: store.id,
      exp: Date.now() + expiresInHours * 3_600_000,
      nonce: randomBytes(16).toString('hex'),
      label: input.label?.trim() || null,
      defaultInterest: input.defaultInterest?.trim() || null,
    };
    const token = sealQrPayload(payload, this.qrSecret());
    await this.audit.record(user, {
      action: 'crm.lead_qr_issued', entityType: 'Store', entityId: store.id, storeId: store.id,
      summary: `Issued an expiring lead-capture QR link for ${store.name}.`,
      metadata: { expiresAt: new Date(payload.exp).toISOString(), tokenId: qrTokenId(payload.nonce) },
    });
    return {
      token,
      capturePath: `/crm/qr/capture/${token}`,
      expiresAt: new Date(payload.exp).toISOString(),
      storeName: store.name,
      label: payload.label,
    };
  }

  async captureLead(token: string, input: CaptureLeadFromQrDto) {
    const payload = openQrPayload(token, this.qrSecret());
    if (!payload || payload.exp <= Date.now()) throw new BadRequestException('Invalid or expired QR link.');
    const store = await this.prisma.store.findFirst({
      where: {
        id: payload.storeId, organisationId: payload.organisationId, isAggregate: false,
        organisation: { status: { in: ['active', 'onboarding'] } },
      },
      select: { id: true, timezone: true, organisation: { select: { country: true } } },
    });
    if (!store) throw new BadRequestException('Invalid or expired QR link.');
    if (!this.identity.normalize('phone', input.phone, store.organisation.country)) {
      throw new BadRequestException('Enter a valid phone number including its country code when required.');
    }
    const interest = input.interest?.trim() || payload.defaultInterest;
    if (!interest) throw new BadRequestException('Tell us what you are interested in.');

    const originKey = `qr:${qrTokenId(payload.nonce)}:${input.submissionId}`;
    const existing = await this.prisma.lead.findFirst({
      where: { organisationId: payload.organisationId, originKey }, select: { id: true, ref: true },
    });
    if (existing) return { accepted: true, duplicate: true, leadId: existing.id, reference: existing.ref };

    const identity = await this.identity.resolveInbound(payload.organisationId, {
      kind: 'phone', value: input.phone, name: input.customerName, storeId: store.id, source: 'qr',
    });
    const seq = await this.sequence.next('LD:global');
    const now = new Date();
    let lead: { id: string; ref: string };
    try {
      lead = await this.prisma.$transaction(async (tx) => {
        const created = await tx.lead.create({
          data: {
            organisationId: payload.organisationId,
            ref: `LD-${5000 + seq}`,
            storeId: store.id,
            partyId: identity.partyId,
            customerName: input.customerName.trim(),
            phone: input.phone.trim(),
            source: LeadSource.website,
            interest,
            originKey,
            lastActivity: now,
          },
          select: { id: true, ref: true },
        });
        const localDate = businessDate(now, resolveTz(store.timezone));
        await tx.leadFollowUp.createMany({
          data: [
            { leadId: created.id, storeId: store.id, seq: 1, dueDate: addUtcDays(localDate, 7), note: 'QR enquiry follow-up' },
            { leadId: created.id, storeId: store.id, seq: 2, dueDate: addUtcDays(localDate, 30), note: 'QR enquiry follow-up' },
          ],
        });
        await this.activity.record({
          organisationId: payload.organisationId, type: 'lead.created',
          summary: 'A visitor submitted an enquiry through a location QR code.',
          partyId: identity.partyId, leadId: created.id, storeId: store.id,
          entityType: 'Lead', entityId: created.id, channel: 'web',
          dedupeKey: `qr-lead:${originKey}`, metadata: { tokenId: qrTokenId(payload.nonce), consent: true },
        }, tx);
        // Issuing the QR was audited; the anonymous submission it produces was
        // not. Inside the transaction, so the lead and its trail arrive
        // together, and only on the create path — a replayed submissionId
        // returns the existing lead above and writes nothing.
        //
        // The metadata is deliberately thin: the token id is the salted digest
        // of the nonce, never the signing secret or the raw token, and no name,
        // phone or enquiry text is copied into the audit trail.
        await this.audit.recordSystem(payload.organisationId, 'qr_lead_capture', {
          action: 'crm.lead_captured_from_qr',
          entityType: 'Lead',
          entityId: created.id,
          storeId: store.id,
          summary: 'A visitor submitted an enquiry through a location QR code.',
          metadata: { tokenId: qrTokenId(payload.nonce), reference: created.ref },
        }, tx);
        return created;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const winner = await this.prisma.lead.findFirst({
          where: { organisationId: payload.organisationId, originKey }, select: { id: true, ref: true },
        });
        if (winner) return { accepted: true, duplicate: true, leadId: winner.id, reference: winner.ref };
      }
      throw error;
    }

    // If this store opted in, immediately place the new lead in its fair queue.
    const assigned = await this.assignRoundRobin(payload.organisationId, 'lead', lead.id, null).catch(() => null);
    return {
      accepted: true, duplicate: false, leadId: lead.id, reference: lead.ref,
      assigned: assigned ? { userId: assigned.assignedUserId, sequence: assigned.sequence } : null,
    };
  }

  /**
   * The QR signing secret, with no fallback in production.
   *
   * It used to fall back to `JWT_SECRET`. That quietly gave one key two jobs:
   * anything able to mint a QR token was signing with the same material that
   * authenticates every session, so a leak of either compromised both and
   * neither could be rotated without invalidating the other. Store QR posters
   * live on walls for months; login sessions must be rotatable in minutes.
   *
   * Production now fails closed. Development and test keep an explicit,
   * clearly-named constant so a local run needs no setup — it is not a secret,
   * and it cannot reach production because the branch is on NODE_ENV.
   */
  private qrSecret(): string {
    const value = this.config.get<string>('CRM_QR_SECRET');
    if (value && value.length >= 16) return value;
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'CRM_QR_SECRET is not set (or is shorter than 16 characters). Set it to sign store QR codes.',
      );
    }
    return DEVELOPMENT_QR_SECRET;
  }

  private async settings(organisationId: string): Promise<OrgSettings> {
    const org = await this.prisma.organisation.findUnique({ where: { id: organisationId }, select: { settings: true } });
    return asObject(org?.settings);
  }

  private leadSummary(row: {
    id: string; ref: string; customerName: string; phone: string | null; value: Prisma.Decimal | null;
    source: LeadSource; stage: LeadStage; outcome: string; interest: string | null; storeId: string;
    ownerId: string | null; createdAt: Date; lastActivity: Date | null; updatedAt: Date;
    owner: { id: string; name: string } | null; store: { id: string; name: string; timezone: string };
  }) {
    return {
      id: row.id, ref: row.ref, customerName: row.customerName, phone: row.phone,
      value: row.value?.toFixed(2) ?? null, source: row.source, stage: row.stage,
      outcome: row.outcome, interest: row.interest, storeId: row.storeId, ownerId: row.ownerId,
      createdAt: row.createdAt, lastActivity: row.lastActivity, owner: row.owner,
      store: { id: row.store.id, name: row.store.name },
    };
  }
}

// -------------------------------------------------------------------------
// Pure helpers exported for deterministic contract tests.
// -------------------------------------------------------------------------

export function chooseNextAssignee(eligibleIds: string[], previousId?: string | null): string | null {
  const ids = [...new Set(eligibleIds)].sort();
  if (!ids.length) return null;
  const at = previousId ? ids.indexOf(previousId) : -1;
  return ids[(at + 1) % ids.length];
}

export function evaluateLeadAge(
  lead: { createdAt: Date; lastActivity: Date | null; stage: LeadStage },
  policy: LeadAgeingPolicy,
  now: Date,
  timezone: string,
) {
  const anchor = lead.lastActivity ?? lead.createdAt;
  const ageHours = Math.max(0, (now.getTime() - anchor.getTime()) / 3_600_000);
  const localToday = businessDate(now, timezone);
  const localAnchor = businessDate(anchor, timezone);
  const inactiveCalendarDays = Math.max(0, Math.floor((localToday.getTime() - localAnchor.getTime()) / DAY_MS));
  const slaHours = policy.byStage[lead.stage] ?? policy.defaultHours;
  const ratio = ageHours / slaHours;
  const ageBucket: 'fresh' | 'due_soon' | 'breached' | 'untouched' = !lead.lastActivity
    ? 'untouched'
    : ratio >= 1
      ? 'breached'
      : ratio >= 0.5
        ? 'due_soon'
        : 'fresh';
  const local = zonedParts(now, timezone);
  return {
    ageAnchor: anchor.toISOString(), ageHours: Math.round(ageHours * 10) / 10,
    inactiveCalendarDays, slaHours, slaDueAt: new Date(anchor.getTime() + slaHours * 3_600_000).toISOString(),
    slaBreached: ratio >= 1, ageBucket, timezone,
    localAsOf: `${local.year}-${pad(local.month)}-${pad(local.day)}T${pad(local.hour)}:${pad(local.minute)}`,
  };
}

export function sealQrPayload(payload: QrPayload, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', qrKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

export function openQrPayload(token: string, secret: string): QrPayload | null {
  try {
    if (!token || token.length > 2048) return null;
    const packed = Buffer.from(token, 'base64url');
    if (packed.length < 29) return null;
    const iv = packed.subarray(0, 12);
    const tag = packed.subarray(12, 28);
    const decipher = createDecipheriv('aes-256-gcm', qrKey(secret), iv);
    decipher.setAuthTag(tag);
    const parsed = JSON.parse(Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString('utf8')) as Partial<QrPayload>;
    if (
      parsed.v !== 1 || typeof parsed.organisationId !== 'string' || typeof parsed.storeId !== 'string' ||
      typeof parsed.exp !== 'number' || !Number.isFinite(parsed.exp) || typeof parsed.nonce !== 'string'
    ) return null;
    return parsed as QrPayload;
  } catch {
    return null;
  }
}

/**
 * The SQL form of `evaluateLeadAge`'s bucket rule, so a summary can be counted
 * by the database instead of by reading rows.
 *
 * `ratio = ageHours / slaHours` with `ageHours = now - lastActivity`, so:
 *   breached  ratio >= 1    <=>  lastActivity <= now - slaHours
 *   due_soon  ratio >= 0.5  <=>  lastActivity <= now - slaHours/2
 *   fresh                        everything more recent than that
 * and a lead with no lastActivity is `untouched` whatever its age. SQL's
 * three-valued logic excludes NULLs from all three dated ranges on its own, so
 * the four buckets partition the set without an explicit NOT NULL.
 *
 * The SLA hours are per stage and tenant-configurable, so stages are grouped by
 * the value they resolve to: one OR arm per distinct SLA, never one per stage.
 */
function bucketFilter(bucket: string, policy: LeadAgeingPolicy, now: Date): Prisma.LeadWhereInput {
  if (bucket === 'untouched') return { lastActivity: null };

  const byHours = new Map<number, LeadStage[]>();
  for (const stage of Object.values(LeadStage)) {
    const hours = policy.byStage[stage] ?? policy.defaultHours;
    byHours.set(hours, [...(byHours.get(hours) ?? []), stage]);
  }

  return {
    OR: [...byHours].map(([hours, stages]) => {
      const breachedAt = new Date(now.getTime() - hours * 3_600_000);
      const dueSoonAt = new Date(now.getTime() - (hours / 2) * 3_600_000);
      return {
        stage: { in: stages },
        lastActivity:
          bucket === 'breached'
            ? { lte: breachedAt }
            : bucket === 'due_soon'
              ? { gt: breachedAt, lte: dueSoonAt }
              : { gt: dueSoonAt },
      };
    }),
  };
}

function mergePlanHash(plan: MergePlan): string {
  return createHash('sha256').update(stableStringify(plan)).digest('hex');
}

/**
 * How a merge carries the two Party fields that exist to stop money leaving.
 *
 * Every other field follows "primary wins, duplicate fills blanks", which is
 * fine for a spelling of a name and wrong for these two:
 *
 *   - `isBlacklisted` is an OR, not a preference. A shop blocks a customer, the
 *     customer appears again under a second record, and someone merges the two
 *     — if the primary's `false` won, the merge would have laundered the block
 *     and the survivor could buy on credit again.
 *   - `creditLimit` survives only when there is exactly one answer. Two
 *     different non-null limits are refused, because picking the higher one
 *     silently grants credit nobody approved and picking the lower one silently
 *     withdraws credit somebody did.
 *
 * Exported and pure so the plan a human approves and the row the merge writes
 * are produced by one function rather than two that drift apart.
 */
export function mergeRiskCarry(
  primary: { isBlacklisted: boolean; creditLimit: Prisma.Decimal | null } | null | undefined,
  duplicate: { isBlacklisted: boolean; creditLimit: Prisma.Decimal | null } | null | undefined,
): RiskCarry {
  const primaryBlocked = primary?.isBlacklisted ?? false;
  const duplicateBlocked = duplicate?.isBlacklisted ?? false;
  const primaryLimit = primary?.creditLimit ?? null;
  const duplicateLimit = duplicate?.creditLimit ?? null;
  const conflict = primaryLimit !== null && duplicateLimit !== null && !primaryLimit.equals(duplicateLimit);

  return {
    survivorBlacklisted: primaryBlocked || duplicateBlocked,
    blacklistSource:
      primaryBlocked && duplicateBlocked
        ? 'both'
        : primaryBlocked
          ? 'primary'
          : duplicateBlocked
            ? 'duplicate'
            : 'neither',
    // Null on conflict as well as on absence. It is never read in the conflict
    // case — that path is a blocker — but leaving a number here would be an
    // invitation to use it.
    survivorCreditLimit: conflict ? null : ((primaryLimit ?? duplicateLimit)?.toFixed(2) ?? null),
    creditLimitSource: conflict
      ? 'conflict'
      : primaryLimit !== null && duplicateLimit !== null
        ? 'both_agree'
        : primaryLimit !== null
          ? 'primary'
          : duplicateLimit !== null
            ? 'duplicate'
            : 'neither',
  };
}

function qrKey(secret: string): Buffer {
  return createHash('sha256').update(`caratos:crm:lead-qr:v1\0${secret}`).digest();
}

function qrTokenId(nonce: string): string {
  return createHash('sha256').update(nonce).digest('hex').slice(0, 24);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function asObject(value: unknown): OrgSettings {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as OrgSettings;
  if (typeof value === 'string') {
    try { return asObject(JSON.parse(value)); } catch { return {}; }
  }
  return {};
}

function normaliseSegments(value: unknown): SavedLeadSegment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const s = raw as Partial<SavedLeadSegment>;
    if (!s || typeof s.id !== 'string' || typeof s.name !== 'string' || s.entity !== 'lead' || !s.filters || typeof s.filters !== 'object') return [];
    return [{
      id: s.id, name: s.name.slice(0, 100), entity: 'lead' as const, filters: cleanSegmentFilters(s.filters),
      createdById: typeof s.createdById === 'string' ? s.createdById : 'unknown',
      createdAt: typeof s.createdAt === 'string' ? s.createdAt : new Date(0).toISOString(),
      updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : new Date(0).toISOString(),
    }];
  }).slice(0, 100);
}

function cleanSegmentFilters(filters: LeadSegmentFiltersDto): LeadSegmentFiltersDto {
  return JSON.parse(JSON.stringify(filters)) as LeadSegmentFiltersDto;
}

function normaliseAgeingPolicy(value: unknown, strict = false): LeadAgeingPolicy {
  const raw = asObject(value);
  const defaultHours = boundedHours(raw.defaultHours) ?? 24;
  const stageRaw = asObject(raw.byStage);
  const allowed = new Set(Object.values(LeadStage));
  if (strict) {
    const unknown = Object.keys(stageRaw).filter((key) => !allowed.has(key as LeadStage));
    if (unknown.length) throw new BadRequestException(`Unknown lead stage SLA: ${unknown.join(', ')}.`);
  }
  const byStage: Partial<Record<LeadStage, number>> = {};
  for (const stage of Object.values(LeadStage)) {
    const hours = boundedHours(stageRaw[stage]);
    if (hours != null) byStage[stage] = hours;
  }
  return { defaultHours, byStage };
}

function boundedHours(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 8760 ? n : null;
}

function normaliseRoundRobinPolicy(value: unknown): RoundRobinPolicy {
  const raw = asObject(value);
  const seen = new Set<string>();
  const stores = Array.isArray(raw.stores)
    ? raw.stores.flatMap((entry) => {
        const s = asObject(entry);
        if (typeof s.storeId !== 'string' || !s.storeId || seen.has(s.storeId)) return [];
        seen.add(s.storeId);
        const ids = Array.isArray(s.eligibleUserIds)
          ? [...new Set(s.eligibleUserIds.filter((id): id is string => typeof id === 'string' && !!id))].sort()
          : [];
        return [{ storeId: s.storeId, eligibleUserIds: ids }];
      }).slice(0, 100)
    : [];
  return { enabled: raw.enabled === true, stores };
}

function normaliseRoundRobinState(value: unknown): Record<string, { lastUserId: string; sequence: number; updatedAt: string }> {
  const raw = asObject(value);
  return Object.fromEntries(Object.entries(raw).flatMap(([storeId, entry]) => {
    const s = asObject(entry);
    if (typeof s.lastUserId !== 'string') return [];
    return [[storeId, {
      lastUserId: s.lastUserId,
      sequence: Number.isInteger(s.sequence) && Number(s.sequence) >= 0 ? Number(s.sequence) : 0,
      updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : new Date(0).toISOString(),
    }]];
  }));
}

function currentRoundRobinSequence(settings: OrgSettings, storeId: string): number {
  return normaliseRoundRobinState(settings[ROUND_ROBIN_STATE_KEY])[storeId]?.sequence ?? 0;
}

function parseYmd(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new BadRequestException('Date must be yyyy-mm-dd.');
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new BadRequestException(`Invalid calendar date "${value}".`);
  }
  return parsed;
}

function addUtcDays(value: Date, days: number): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate() + days));
}

function localDayStartAgo(now: Date, timezone: string, days: number): Date {
  return startOfDayAgoInTz(now, timezone, days);
}

function isSerializationFailure(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
