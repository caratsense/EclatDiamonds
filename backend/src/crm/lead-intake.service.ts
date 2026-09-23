import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { LeadSource, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { SequenceService } from '../common/sequence.service';
import { AuditService, type SystemActor } from '../common/audit.service';
import { businessDate, resolveTz } from '../common/tz.util';
import { ActivityService } from './activity.service';
import { IdentityService, type ContactKind } from './identity.service';
import { AdvancedCrmService } from './advanced-crm.service';

/** SOP follow-up cadence, matching the manual and QR paths. */
const FOLLOW_UP_1_DAYS = 7;
const FOLLOW_UP_2_DAYS = 30;

/** Advance a UTC calendar date. Local to this file so intake owns its own dates. */
function addUtcDays(value: Date, days: number): Date {
  const out = new Date(value);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

export interface LeadIntakeInput {
  organisationId: string;
  /** Never guessed. Every caller resolves a real branch before arriving here. */
  storeId: string;
  /**
   * The thing that happened exactly once — a form submission id, a conversation
   * id, an import row. The unique index on (organisationId, originKey) is what
   * makes intake idempotent; the pre-check below is only an optimisation.
   */
  originKey: string;
  customerName: string;
  phone?: string | null;
  email?: string | null;
  interest: string;
  source: LeadSource;
  /** Provenance stamped on the ContactPoint, e.g. 'web_form', 'import'. */
  identitySource: string;
  /** Written to the activity feed and the audit trail. Must contain no PII. */
  summary: string;
  /** Audit action slug, e.g. 'crm.lead_captured_from_web_form'. */
  auditAction: string;
  /** System actor for the audit row, since no human is acting. */
  systemActor: SystemActor;
  /** Note written onto both follow-ups. */
  followUpNote: string;
  /** Extra audit/activity metadata. Must contain no PII. */
  metadata?: Record<string, unknown>;
}

export interface LeadIntakeResult {
  accepted: true;
  duplicate: boolean;
  leadId: string;
  reference: string;
  assigned: { userId: string; sequence: number } | null;
}

/**
 * One way in.
 *
 * Before this, each new door grew its own copy of "resolve the customer, open a
 * lead, schedule the follow-ups, write the activity, write the audit, put it in
 * the queue" — and they drifted. Meta leads skipped the fair queue entirely;
 * click-to-WhatsApp leads still get no follow-ups. Every drift produced the same
 * failure: an identical customer treated differently because of the channel they
 * happened to use.
 *
 * So the sequence lives here once and the doors supply only what genuinely
 * differs — where the enquiry came from, which branch it belongs to, and the key
 * that makes it exactly-once.
 *
 * Deliberately NOT used by the QR path yet. `AdvancedCrmService.captureLead`
 * carries its own copy and is covered by tests; folding it in would make this
 * service and AdvancedCrmService mutually dependent, and the honest fix for that
 * is to lift round-robin into its own service rather than to add a forwardRef.
 * That is a separate change and is recorded in HANDOFF.md rather than smuggled
 * in here.
 */
@Injectable()
export class LeadIntakeService {
  private readonly logger = new Logger(LeadIntakeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly identity: IdentityService,
    private readonly activity: ActivityService,
    private readonly audit: AuditService,
    private readonly sequence: SequenceService,
    private readonly advanced: AdvancedCrmService,
  ) {}

  async capture(input: LeadIntakeInput): Promise<LeadIntakeResult> {
    const { organisationId, originKey } = input;

    // Fast path for a replay. Not the guard — the unique index is.
    const seen = await this.prisma.lead.findFirst({
      where: { organisationId, originKey },
      select: { id: true, ref: true },
    });
    if (seen) {
      return { accepted: true, duplicate: true, leadId: seen.id, reference: seen.ref, assigned: null };
    }

    const store = await this.prisma.store.findFirst({
      where: {
        id: input.storeId,
        organisationId,
        isAggregate: false,
        isHolding: false,
        attendanceOnly: false,
        status: { not: 'closed' },
      },
      select: { id: true, timezone: true },
    });
    if (!store) {
      // This is the final boundary shared by form, import, conversation and
      // telephony intake. A stale caller-side rule must not turn a quarantine
      // bucket, office or closed branch into a customer-facing location.
      throw new BadRequestException(
        'Choose an active physical store before creating a lead.',
      );
    }

    /*
     * Identity first, and through the CRM's own contract, so an enquiry resolves
     * to the SAME customer whoever they already are — the person whose WhatsApp
     * thread is open, whose Meta form arrived last week, whose record was
     * imported from the old system. A second Party for the same phone number is
     * the thing this exists to prevent.
     *
     * Phone is preferred over email because it is the identity the rest of the
     * product can act on, and it is what an inbound message will match.
     */
    const kind: ContactKind = input.phone ? 'phone' : 'email';
    const value = input.phone ?? input.email ?? '';
    const identity = value
      ? await this.identity.resolveInbound(organisationId, {
          kind,
          value,
          name: input.customerName,
          storeId: store.id,
          source: input.identitySource,
        })
      : { partyId: null };

    const seq = await this.sequence.next('LD:global');
    const now = new Date();

    let lead: { id: string; ref: string };
    try {
      lead = await this.prisma.$transaction(async (tx) => {
        const created = await tx.lead.create({
          data: {
            organisationId,
            ref: `LD-${5000 + seq}`,
            storeId: store.id,
            partyId: identity.partyId,
            customerName: input.customerName.trim(),
            phone: input.phone?.trim() ?? null,
            source: input.source,
            interest: input.interest,
            originKey,
            lastActivity: now,
          },
          select: { id: true, ref: true },
        });

        // Follow-ups are scheduled in the BRANCH's timezone, not the server's.
        // A lead taken at 11pm in Kolkata is due seven days later there.
        const localDate = businessDate(now, resolveTz(store.timezone));
        await tx.leadFollowUp.createMany({
          data: [
            { leadId: created.id, storeId: store.id, seq: 1, dueDate: addUtcDays(localDate, FOLLOW_UP_1_DAYS), note: input.followUpNote },
            { leadId: created.id, storeId: store.id, seq: 2, dueDate: addUtcDays(localDate, FOLLOW_UP_2_DAYS), note: input.followUpNote },
          ],
        });

        await this.activity.record(
          {
            organisationId,
            type: 'lead.created',
            summary: input.summary,
            partyId: identity.partyId,
            leadId: created.id,
            storeId: store.id,
            entityType: 'Lead',
            entityId: created.id,
            channel: 'web',
            dedupeKey: `intake:${originKey}`,
            metadata: input.metadata as Prisma.InputJsonValue | undefined,
          },
          tx,
        );

        // Attributed to the system actor: nobody signed in to do this, and an
        // automatic write with no actor is an write nobody can question later.
        await this.audit.recordSystem(
          organisationId,
          input.systemActor,
          {
            action: input.auditAction,
            entityType: 'Lead',
            entityId: created.id,
            storeId: store.id,
            summary: input.summary,
            metadata: { reference: created.ref, ...(input.metadata ?? {}) },
          },
          tx,
        );

        return created;
      });
    } catch (error) {
      // Lost the race with a concurrent submission of the same thing. Returning
      // theirs IS the correct idempotent outcome.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const winner = await this.prisma.lead.findFirst({
          where: { organisationId, originKey },
          select: { id: true, ref: true },
        });
        if (winner) {
          return { accepted: true, duplicate: true, leadId: winner.id, reference: winner.ref, assigned: null };
        }
      }
      throw error;
    }

    // Advisory, and outside the transaction: a lead that exists and is unowned
    // is a far better outcome than a submission refused because the branch has
    // no eligible salesperson today.
    const assigned = await this.advanced.autoAssignLead(organisationId, lead.id);

    return {
      accepted: true,
      duplicate: false,
      leadId: lead.id,
      reference: lead.ref,
      assigned: assigned ? { userId: assigned.assignedUserId, sequence: assigned.sequence } : null,
    };
  }

  /**
   * Open leads for the customers a completed import created.
   *
   * Deliberately a SEPARATE, explicit step rather than a checkbox inside the
   * import wizard. Importing a customer list and starting a sales pipeline are
   * different decisions: a tenant migrating ten years of history wants the
   * customers and emphatically does not want ten thousand leads landing on
   * eight salespeople overnight. So the operator imports, looks at what actually
   * arrived, and then decides.
   *
   * Only rows this batch CREATED are considered. A customer the import merely
   * updated already existed and is somebody's existing relationship; manufacturing
   * a fresh lead for them would misreport both pipeline volume and conversion.
   *
   * Idempotent per (batch, customer), so running it twice — or twice at once —
   * opens each lead exactly once.
   */
  async openLeadsForImportBatch(
    organisationId: string,
    batchId: string,
    input: { interest: string; storeId?: string | null; limit?: number },
  ) {
    const batch = await this.prisma.importBatch.findFirst({
      where: { id: batchId, organisationId },
      select: { id: true, entity: true, status: true, targetStoreId: true },
    });
    if (!batch) throw new NotFoundException('Import batch not found');
    if (batch.entity !== 'customers') {
      throw new BadRequestException('Only a customer import can open leads.');
    }
    if (batch.status !== 'completed') {
      throw new BadRequestException('Wait for the import to finish before opening leads.');
    }

    const storeId = input.storeId ?? batch.targetStoreId;
    if (!storeId) {
      throw new BadRequestException(
        'This import was organisation-wide, so choose which branch these leads belong to.',
      );
    }

    // Bounded on purpose. A caller asking for leads from a 50,000-row import
    // should discover the cap here rather than by holding a request open until
    // it times out halfway through, leaving an unknowable partial result.
    const limit = Math.min(Math.max(input.limit ?? 500, 1), 2000);
    const parties = await this.prisma.party.findMany({
      where: { organisationId, importBatchId: batchId, types: { has: 'customer' } },
      select: { id: true, name: true, phone: true, email: true },
      orderBy: { id: 'asc' },
      take: limit + 1,
    });
    const more = parties.length > limit;
    const page = parties.slice(0, limit);

    let opened = 0;
    let already = 0;
    const failures: { partyId: string; reason: string }[] = [];

    for (const party of page) {
      try {
        const result = await this.capture({
          organisationId,
          storeId,
          originKey: `import_lead:${batchId}:${party.id}`,
          customerName: party.name,
          phone: party.phone,
          email: party.email,
          interest: input.interest.trim(),
          // Never a marketing channel. See the migration note on this value:
          // crediting `website` or `walk_in` here would invent attribution the
          // file never carried.
          source: LeadSource.imported,
          identitySource: 'import',
          summary: 'A lead was opened from an imported customer record.',
          auditAction: 'crm.lead_opened_from_import',
          systemActor: 'import_lead_capture',
          followUpNote: 'Imported customer follow-up',
          metadata: { importBatchId: batchId },
        });
        if (result.duplicate) already += 1;
        else opened += 1;
      } catch (err) {
        // One bad row must not abandon the rest. The reason is reported per
        // row so the operator can see exactly which customers were skipped.
        failures.push({
          partyId: party.id,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      batchId,
      storeId,
      considered: page.length,
      opened,
      alreadyOpen: already,
      failed: failures.length,
      failures: failures.slice(0, 50),
      more,
    };
  }
}
