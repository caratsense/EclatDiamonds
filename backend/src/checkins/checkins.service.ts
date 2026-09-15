import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { ActivityService } from '../crm/activity.service';
import { IdentityService } from '../crm/identity.service';
import { CheckoutDto, CreateCheckInDto } from './dto/checkin.dto';
import { DEFAULT_TZ, formatHHMMInTz } from '../common/tz.util';
import { SequenceService } from '../common/sequence.service';
import { FollowUpRemindersService, reminderView } from '../crm/follow-up-reminders.service';
import { VisitFeedbackService } from '../crm/visit-feedback.service';

const PURPOSE_LABEL: Record<string, string> = {
  bridal: 'Bridal',
  investment: 'Gold Coin / Investment',
  repair: 'Repair / Service',
  quote_followup: 'Quote Follow-up',
  browsing: 'Browsing',
  scheme: 'Gold Scheme',
  other: 'Browsing',
};

/** A yyyy-mm-dd string as UTC midnight, which is what a `@db.Date` column holds. */
function parseYmdUtc(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function initialsOf(name?: string | null): string {
  if (!name) return '—';
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

/**
 * Store-local "HH:MM".
 *
 * This used to be `d.toISOString().slice(11, 16)`, which renders the instant in
 * UTC. For an Asia/Kolkata branch a customer who walked in at 10:30 was reported
 * as arriving at 05:00 — five and a half hours early, printed as fact on the
 * walk-in log, the "in store now" panel and the footfall-by-hour chart, which
 * peaked before the shutters were up. `formatHHMMInTz` is the helper the
 * dashboard and the DSR already use for exactly this.
 */
function hhmm(d: Date | null | undefined, tz: string): string | null {
  return formatHHMMInTz(d, tz);
}

/** Shape a CheckIn row into the frontend `CheckIn` (mock/checkins.ts). */
function toView(c: any, tz: string = DEFAULT_TZ) {
  const durationMin =
    c.timeOut ? Math.round((c.timeOut.getTime() - c.timeIn.getTime()) / 60000) : null;
  return {
    id: c.id,
    storeId: c.storeId,
    customer: c.customerName,
    returning: !!c.partyId,
    // The linked customer record, so the counter can open this walk-in's
    // history or log what they were shown. `returning` alone said that a
    // customer EXISTED without saying which one, which made every downstream
    // action re-resolve the phone number and risk resolving it differently.
    partyId: c.partyId ?? null,
    phone: c.phone ?? '',
    partySize: 1,
    purpose: PURPOSE_LABEL[c.purpose] ?? 'Browsing',
    repId: c.repId ?? c.attendedById ?? '',
    repName: c.repName ?? c.attendedBy?.name ?? '',
    repInitials: initialsOf(c.repName ?? c.attendedBy?.name),
    timeIn: hhmm(c.timeIn, tz),
    timeOut: hhmm(c.timeOut, tz),
    /**
     * The arrival as a real instant, alongside the wall clock above.
     *
     * The screen needs both: "10:30" to show a person, and something with a
     * date in it to answer "is this from today". It used to have only the first,
     * and the Check-ins page counted every row it was given as today's footfall.
     */
    timeInAt: c.timeIn,
    durationMin,
    outcome: c.outcome,
    // What was promised at the counter when the visit closed. Returned so the
    // walk-in log shows it; before this the fields were written and never read.
    remark: c.remark ?? null,
    followUpDate: c.followUpDate ? c.followUpDate.toISOString().slice(0, 10) : null,
    preferredAction: c.preferredAction ?? null,
    /** The booked follow-up's reminder: when, in the branch's time, and whether it went. */
    reminder: c.followUpReminder ?? null,
    /**
     * The automatic feedback ask for a visit that booked no follow-up. Separate
     * from the follow-up on purpose: it is not a sales chase.
     */
    feedback: c.visitFeedback ?? null,
  };
}

@Injectable()
export class CheckinsService {
  private readonly log = new Logger(CheckinsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly identity: IdentityService,
    private readonly activity: ActivityService,
    private readonly sequence: SequenceService,
    private readonly reminders: FollowUpRemindersService,
    private readonly visitFeedback: VisitFeedbackService,
  ) {}

  /** GET /checkins — footfall log, store-scoped (most recent first). */
  async list(user: AuthUser, headerStore?: string) {
    const where: Prisma.CheckInWhereInput = {
      ...this.scope.storeFilter(user, headerStore),
    };
    // A salesperson only sees the walk-ins assigned to them; managers see all.
    //
    // Both columns, because there are two ways a visit gets attributed: the
    // walk-in form writes `repId`, and the floor app writes `attendedById`.
    // Testing only the first hid every visit the floor app recorded from the
    // person who recorded it.
    if (user.role === 'salesperson') {
      where.OR = [{ repId: user.id }, { attendedById: user.id }];
    }
    const tz = await this.scope.resolveTimezone(user, headerStore);
    const rows = await this.prisma.checkIn.findMany({
      where,
      orderBy: { timeIn: 'desc' },
      take: 200,
      include: { attendedBy: { select: { id: true, name: true } } },
    });
    return (await this.withOutcomes(rows, tz)).map((r) => toView(r, tz));
  }

  /**
   * Attach each visit's follow-up reminder and feedback ask, in two queries for
   * the whole page rather than two per row.
   */
  private async withOutcomes<T extends { id: string; leadId: string | null; followUpDate: Date | null }>(
    rows: T[],
    tz: string,
  ) {
    const leadIds = [...new Set(rows.map((r) => r.leadId).filter((x): x is string => !!x))];
    const [followUps, asks] = await Promise.all([
      this.prisma.leadFollowUp.findMany({
        where: { leadId: { in: leadIds } },
        select: { leadId: true, dueDate: true, reminderAt: true, reminderNotifiedAt: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.feedbackRequest.findMany({
        where: { checkInId: { in: rows.map((r) => r.id) }, origin: 'visit_auto' },
        select: { checkInId: true, status: true, scheduledFor: true, deliveryNote: true },
      }),
    ]);
    return rows.map((r) => {
      const fu = r.leadId && r.followUpDate
        ? followUps.find(
            (f) => f.leadId === r.leadId && f.dueDate.getTime() === r.followUpDate!.getTime(),
          )
        : undefined;
      const ask = asks.find((a) => a.checkInId === r.id);
      return {
        ...r,
        followUpReminder: fu ? reminderView(fu, tz) : null,
        visitFeedback: ask
          ? { status: ask.status, scheduledFor: ask.scheduledFor?.toISOString() ?? null, note: ask.deliveryNote }
          : null,
      };
    });
  }

  /** POST /checkins — register a walk-in. */
  async create(user: AuthUser, dto: CreateCheckInDto) {
    this.scope.assertStoreAllowed(user, dto.storeId);

    // Phase A6 — a walk-in is the moment a real person is in front of a
    // salesperson, which makes it the single best point to establish identity.
    // Best-effort: a check-in must never be blocked by an unusable phone number,
    // because the customer is standing there either way.
    const identity = await this.identity.resolveForRecord(user, {
      phone: dto.phone,
      name: dto.customerName,
      storeId: dto.storeId,
      source: 'checkin',
    });
    const partyId = identity.partyId;

    const row = await this.prisma.checkIn.create({
      data: {
        organisationId: user.organisationId,
        storeId: dto.storeId,
        partyId,
        customerName: dto.customerName,
        phone: dto.phone,
        purpose: dto.purpose ?? 'browsing',
        outcome: 'in_store',
        repId: dto.repId ?? user.id,
        repName: dto.repName ?? user.name,
        timeIn: new Date(),
      },
    });

    const tz = await this.scope.resolveTimezone(user, dto.storeId);

    await this.activity.recordFor(user, {
      type: 'visit.recorded',
      summary: `${dto.customerName} walked in (${dto.purpose ?? 'browsing'})`,
      partyId,
      storeId: dto.storeId,
      entityType: 'CheckIn',
      entityId: row.id,
      channel: 'store',
    });

    return toView(row, tz);
  }

  /** PATCH /checkins/:id — check the customer out (records timeOut + outcome). */
  async checkout(user: AuthUser, id: string, headerStore: string | undefined, dto: CheckoutDto) {
    // The header narrows the WRITE the same way it narrows the read. Without it
    // a manager with several branches could close a walk-in at a branch other
    // than the one their screen is showing.
    const existing = await this.prisma.checkIn.findFirst({
      where: { id, ...this.scope.storeFilter(user, headerStore) },
    });
    if (!existing) throw new NotFoundException('Check-in not found');
    // A salesperson can only close their own walk-in, not another rep's.
    if (user.role === 'salesperson' && existing.repId !== user.id) {
      throw new ForbiddenException('You can only check out your own walk-ins');
    }
    /*
     * The follow-up decision, if one was made.
     *
     * Resolved BEFORE the update so a bad owner id or an unreachable lead fails
     * the whole checkout rather than leaving a visit closed with a follow-up
     * that silently went nowhere. The floor's complaint in the meeting was
     * precisely that what they promised the customer never reached the system.
     */
    // A reminder sent without a date books the follow-up on the reminder's day.
    const followUpDate = dto.followUpDate ?? dto.reminderAt?.slice(0, 10);
    const store = await this.prisma.store.findUnique({
      where: { id: existing.storeId },
      select: { timezone: true },
    });
    const reminderAt = followUpDate
      ? await this.reminders.resolveReminderAt({
          organisationId: user.organisationId,
          timezone: store?.timezone,
          dueDay: parseYmdUtc(followUpDate),
          explicitLocal: dto.reminderAt,
        })
      : null;

    const leadId = followUpDate
      ? await this.ensureLeadForFollowUp(user, existing)
      : existing.leadId;

    if (dto.followUpOwnerId) {
      const owner = await this.prisma.user.findFirst({
        where: {
          id: dto.followUpOwnerId,
          organisationId: user.organisationId,
          isActive: true,
        },
        select: { id: true },
      });
      if (!owner) throw new NotFoundException('That follow-up owner is not available.');
    }

    const row = await this.prisma.checkIn.update({
      where: { id },
      data: {
        timeOut: new Date(),
        outcome: dto.outcome ?? 'left',
        ...(dto.remark !== undefined ? { remark: dto.remark.trim() || null } : {}),
        ...(followUpDate ? { followUpDate: parseYmdUtc(followUpDate) } : {}),
        ...(followUpDate
          ? { followUpOwnerId: dto.followUpOwnerId ?? existing.repId ?? user.id }
          : {}),
        ...(dto.preferredAction ? { preferredAction: dto.preferredAction } : {}),
        ...(leadId ? { leadId } : {}),
      },
      include: { attendedBy: { select: { id: true, name: true } } },
    });

    if (followUpDate && leadId) {
      /*
       * A real LeadFollowUp, on the same queue the calling workspace already
       * works from — not a second parallel list of things to do. `seq` is the
       * next free slot after the SOP's +7d and +30d rows so a visit-booked
       * callback sorts alongside them instead of colliding.
       */
      const seq = await this.prisma.leadFollowUp.count({ where: { leadId } });
      await this.prisma.leadFollowUp.create({
        data: {
          leadId,
          storeId: existing.storeId,
          seq: seq + 1,
          dueDate: parseYmdUtc(followUpDate),
          note: dto.remark?.trim() || `Follow-up booked at the counter${
            dto.preferredAction ? ` (${dto.preferredAction})` : ''
          }`,
          assigneeId: row.followUpOwnerId ?? user.id,
          reminderAt,
        },
      });
    } else if (row.outcome !== 'in_store') {
      /*
       * No follow-up booked: the tenant may want to ask how the visit went, a
       * set number of days later. Booked, not sent, and never allowed to fail
       * the checkout — the customer has already left either way.
       */
      try {
        await this.visitFeedback.scheduleAfterVisit({
          organisationId: user.organisationId,
          checkIn: { id: existing.id, storeId: existing.storeId, partyId: existing.partyId },
          closedAt: row.timeOut ?? new Date(),
          timezone: store?.timezone,
          createdById: user.id,
        });
      } catch (error) {
        this.log.warn(`Visit feedback not booked for ${existing.id}: ${(error as Error).message}`);
      }
    }

    // The remark belongs on the customer's timeline, not only on the visit row —
    // the next person to open the customer has no reason to go looking in a
    // closed visit for what was said.
    if (dto.remark?.trim() || followUpDate) {
      await this.activity.recordFor(user, {
        type: 'visit.closed',
        summary: dto.remark?.trim()
          ? `Visit ended — ${dto.remark.trim().slice(0, 200)}`
          : 'Visit ended, follow-up booked',
        partyId: existing.partyId,
        leadId: leadId ?? undefined,
        storeId: existing.storeId,
        entityType: 'CheckIn',
        entityId: existing.id,
        channel: 'store',
        metadata: {
          followUpDate: followUpDate ?? null,
          preferredAction: dto.preferredAction ?? null,
        },
      });
    }

    const tz = await this.scope.resolveTimezone(user, headerStore);
    const [withOutcomes] = await this.withOutcomes([row], tz);
    return toView(withOutcomes, tz);
  }

  /**
   * The enquiry a visit follow-up is filed against.
   *
   * Reuses an OPEN lead for this customer at this branch when there is one —
   * a second visit about the same ring is the same opportunity, and opening a
   * new lead each time would inflate every count the meeting asked to report
   * on. Creates one only when the customer has no open enquiry here.
   *
   * Not routed through LeadIntakeService.capture(): that door exists for leads
   * nobody typed — it demands a `systemActor` and stamps an automatic origin
   * key. A salesperson booking a callback is a person acting, and recording it
   * as an automation would put the wrong name on the audit trail.
   */
  private async ensureLeadForFollowUp(
    user: AuthUser,
    visit: { id: string; storeId: string; partyId: string | null; customerName: string; phone: string | null; leadId: string | null },
  ): Promise<string> {
    if (visit.leadId) return visit.leadId;

    if (visit.partyId) {
      const open = await this.prisma.lead.findFirst({
        where: {
          organisationId: user.organisationId,
          storeId: visit.storeId,
          partyId: visit.partyId,
          outcome: 'open',
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (open) return open.id;
    }

    const seq = await this.sequence.next('LD:global');
    const lead = await this.prisma.lead.create({
      data: {
        organisationId: user.organisationId,
        ref: `LD-${5000 + seq}`,
        storeId: visit.storeId,
        partyId: visit.partyId,
        customerName: visit.customerName,
        phone: visit.phone,
        // The customer walked in. That is what happened, and it is the one
        // source value that cannot be wrong here.
        source: 'walk_in',
        stage: 'inquiry',
        ownerId: user.id,
        lastActivity: new Date(),
      },
      select: { id: true },
    });
    return lead.id;
  }
}
