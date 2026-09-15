import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StoreScopeService } from '../common/store-scope.service';
import { SequenceService } from '../common/sequence.service';
import { AuthUser } from '../common/auth-user';
import { isSalesScoped } from '../common/sales-scope';
import { AttributionService } from '../crm/attribution.service';
import { ActivityService } from '../crm/activity.service';
import { IdentityService } from '../crm/identity.service';
import { leadSearchWhere, leadTagWhere } from './lead-filters';
import { FollowUpRemindersService, reminderView } from '../crm/follow-up-reminders.service';
import {
  CreateActivityDto,
  CreateFollowUpDto,
  CreateLeadDto,
  ListLeadsQuery,
  ReminderQuery,
  ReminderScope,
  UpdateFollowUpDto,
  UpdateLeadDto,
  UpdateOutcomeDto,
} from './dto/lead.dto';

/** SOP follow-up cadence (days from lead-created date). Extensible via more seqs. */
const FU1_DAYS = 7;
const FU2_DAYS = 30;

/** Today as a UTC-midnight Date, matching how Prisma stores/reads `@db.Date`. */
function todayUtc(): Date {
  const n = new Date();
  return new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()));
}

/** Add whole days to a UTC-midnight date (stays date-only). */
function addDaysUtc(base: Date, days: number): Date {
  return new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + days),
  );
}

/** Parse a yyyy-mm-dd string into a UTC-midnight Date for a `@db.Date` column. */
function parseYmd(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** End-of-day (23:59:59.999 UTC) of a yyyy-mm-dd — inclusive upper bound for createdAt. */
function endOfDayUtc(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999));
}

const followUpInclude = { orderBy: { seq: 'asc' } } as const;

const DAY_MS = 86_400_000;

/** Days from today (UTC midnight) until the next month/day occurrence of `d`. */
function daysUntilOccasion(d: Date): number {
  const today = todayUtc().getTime();
  let next = Date.UTC(new Date().getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (next < today) {
    next = Date.UTC(new Date().getUTCFullYear() + 1, d.getUTCMonth(), d.getUTCDate());
  }
  return Math.round((next - today) / DAY_MS);
}

/**
 * Priority temperature (Zoho lead scoring, adapted). Computed from already-loaded
 * fields only — no extra queries per row.
 *   hot:  activity/note/follow-up-done within 7d, OR an open follow-up due in <=3d,
 *         OR birthday/anniversary within 14d;
 *   warm: activity within 30d;
 *   cold: otherwise.
 */
function computeTemperature(l: any): 'hot' | 'warm' | 'cold' {
  const now = Date.now();
  const lastAct: Date = l.lastActivity ?? l.updatedAt;
  const activityDays = (now - lastAct.getTime()) / DAY_MS;

  const followUps: any[] = l.followUps ?? [];
  const doneWithin7d = followUps.some(
    (f: any) => f.done && f.doneAt && now - f.doneAt.getTime() <= 7 * DAY_MS,
  );
  const today = todayUtc().getTime();
  const dueWithin3d = followUps.some((f: any) => {
    if (f.done) return false;
    const days = (f.dueDate.getTime() - today) / DAY_MS;
    return days >= 0 && days <= 3;
  });
  const occasionWithin14d = [l.birthday, l.anniversary].some(
    (d: Date | null) => d && daysUntilOccasion(d) <= 14,
  );

  if (activityDays <= 7 || doneWithin7d || dueWithin3d || occasionWithin14d) return 'hot';
  if (activityDays <= 30) return 'warm';
  return 'cold';
}

/**
 * The answers a Meta Lead Ads questionnaire carried, if this lead came from one.
 *
 * Read out of `attributes.metaLeadForm`, which is where `meta-lead.adapter.ts`
 * puts every field it did not recognise as a standard one (name, phone, email).
 * Exposed as its own narrow list rather than by returning `attributes` whole:
 * that bag is the tenant's custom vocabulary for every industry, and a screen
 * that renders all of it renders whatever anyone ever puts there.
 *
 * Anything not shaped like `{ name, values[] }` is dropped rather than guessed
 * at — the answers come from an external system and are not ours to repair.
 */
function metaFormAnswers(attributes: unknown): { name: string; values: string[] }[] {
  if (!attributes || typeof attributes !== 'object') return [];
  const raw = (attributes as Record<string, unknown>).metaLeadForm;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const { name, values } = entry as { name?: unknown; values?: unknown };
    if (typeof name !== 'string' || !name.trim()) return [];
    const clean = Array.isArray(values)
      ? values.filter((v): v is string => typeof v === 'string')
      : [];
    return [{ name, values: clean }];
  });
}

/** Shape a Lead row into the frontend `Lead` interface (mock/crm.ts). */
function toView(l: any) {
  return {
    id: l.id,
    ref: l.ref,
    customer: l.customerName,
    phone: l.phone ?? '',
    value: l.value ? Number(l.value) : 0,
    source: l.source,
    stage: l.stage,
    assignedRep: l.owner?.name ?? '',
    storeId: l.storeId,
    interest: l.interest ?? '',
    address: l.address ?? '',
    location: l.location ?? '',
    birthday: l.birthday ? l.birthday.toISOString().slice(0, 10) : null,
    anniversary: l.anniversary ? l.anniversary.toISOString().slice(0, 10) : null,
    createdAt: l.createdAt.toISOString().slice(0, 10),
    lastActivity: (l.lastActivity ?? l.updatedAt).toISOString().slice(0, 10),
    outcome: l.outcome ?? 'open',
    lostReason: l.lostReason ?? null,
    closedAt: l.closedAt ? l.closedAt.toISOString() : null,
    temperature: computeTemperature(l),
    formAnswers: metaFormAnswers(l.attributes),
    notes: (l.notes ?? []).map((n: any) => ({
      id: n.id,
      kind: n.kind ?? 'note',
      at: n.createdAt.toISOString().slice(0, 10),
      createdAt: n.createdAt.toISOString(),
      author: n.authorName ?? n.author?.name ?? '',
      text: n.text,
    })),
    reminders: (l.reminders ?? []).map((r: any) => ({
      id: r.id,
      occasion: r.occasion,
      date: r.date.toISOString().slice(0, 10),
    })),
    followUps: (l.followUps ?? []).map((f: any) => ({
      id: f.id,
      seq: f.seq,
      dueDate: f.dueDate.toISOString().slice(0, 10),
      done: f.done,
      doneAt: f.doneAt ? f.doneAt.toISOString() : null,
      note: f.note ?? null,
      reminder: reminderView(f, l.store?.timezone),
    })),
  };
}

/** Shape a LeadFollowUp (+lead +store) row into a reminders-section item. */
function toReminderView(f: any) {
  return {
    id: f.id,
    leadId: f.leadId,
    leadRef: f.lead?.ref ?? '',
    customer: f.lead?.customerName ?? '',
    phone: f.lead?.phone ?? '',
    storeId: f.storeId,
    storeName: f.lead?.store?.name ?? '',
    seq: f.seq,
    dueDate: f.dueDate.toISOString().slice(0, 10),
    done: f.done,
    interest: f.lead?.interest ?? '',
    source: f.lead?.source ?? null,
    reminder: reminderView(f, f.lead?.store?.timezone),
  };
}

@Injectable()
export class LeadsService {
  private readonly log = new Logger(LeadsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly sequence: SequenceService,
    private readonly identity: IdentityService,
    private readonly activity: ActivityService,
    private readonly attribution: AttributionService,
    private readonly followUpReminders: FollowUpRemindersService,
  ) {}

  /**
   * The leads this caller may change: their branches, and for a salesperson only
   * the ones they own. Writes used the store alone, so any salesperson could add
   * notes to, close, or take a colleague's lead.
   */
  private ownLead(user: AuthUser): Prisma.LeadWhereInput {
    return { ...this.scope.storeFilter(user), ...(isSalesScoped(user) ? { ownerId: user.id } : {}) };
  }

  /**
   * Who a lead may be given to. A salesperson does not reassign — their leads
   * move by a manager or the round-robin queue. A manager assigns within the
   * organisation, to an active person who works the lead's branch.
   */
  private async assertAssignableOwner(user: AuthUser, ownerId: string | null | undefined, storeId: string) {
    if (isSalesScoped(user)) {
      if (ownerId && ownerId === user.id) return;
      throw new ForbiddenException('Only a manager can reassign a lead.');
    }
    if (!ownerId) return;
    const owner = await this.prisma.user.findFirst({
      where: {
        id: ownerId,
        organisationId: user.organisationId,
        isActive: true,
        OR: [{ role: 'head_office' }, { userStores: { some: { storeId } } }],
      },
      select: { id: true },
    });
    if (!owner) throw new BadRequestException('That person cannot take leads at this branch.');
  }

  async list(user: AuthUser, q: ListLeadsQuery, headerStore?: string) {
    const where: Prisma.LeadWhereInput = {
      ...this.scope.storeFilter(user, q.storeId ?? headerStore),
    };
    // A salesperson only ever sees the leads they own (their own customers);
    // store_manager+ see the whole store. Mirrors the OP-5 leaderboard rule.
    if (user.role === 'salesperson') where.ownerId = user.id;
    if (q.stage) where.stage = q.stage;
    // Default to open leads so the kanban board keeps showing only active work.
    const outcome = q.outcome ?? 'open';
    if (outcome !== 'all') where.outcome = outcome;
    if (q.source) where.source = q.source;
    if (q.from || q.to) {
      where.createdAt = {
        ...(q.from ? { gte: parseYmd(q.from) } : {}),
        ...(q.to ? { lte: endOfDayUtc(q.to) } : {}),
      };
    }
    // Each OR-shaped filter is its own AND term: assigning two of them to
    // `where.OR` would let the second silently replace the first.
    const and: Prisma.LeadWhereInput[] = [];
    if (q.rep) and.push({ OR: [{ ownerId: q.rep }, { owner: { name: { contains: q.rep, mode: 'insensitive' } } }] });
    const tagged = leadTagWhere(user.organisationId, q.tagIds);
    if (tagged) and.push(tagged);
    const searched = leadSearchWhere(q.q);
    if (searched) and.push(searched);
    if (and.length) where.AND = and;

    const leads = await this.prisma.lead.findMany({
      where,
      include: {
        owner: true,
        store: { select: { timezone: true } },
        notes: { include: { author: true } },
        reminders: true,
        followUps: followUpInclude,
      },
      orderBy: { createdAt: 'desc' },
    });
    return leads.map(toView);
  }

  async get(user: AuthUser, id: string) {
    const where: Prisma.LeadWhereInput = { id, ...this.scope.storeFilter(user) };
    // A salesperson can only open a lead they own (mirrors list()).
    if (user.role === 'salesperson') where.ownerId = user.id;
    const lead = await this.prisma.lead.findFirst({
      where,
      include: {
        owner: true,
        store: { select: { timezone: true } },
        notes: { include: { author: true }, orderBy: { createdAt: 'desc' } },
        reminders: { orderBy: { date: 'asc' } },
        followUps: followUpInclude,
      },
    });
    if (!lead) throw new NotFoundException('Lead not found');
    return toView(lead);
  }

  async create(user: AuthUser, dto: CreateLeadDto) {
    this.scope.assertStoreAllowed(user, dto.storeId);
    if (dto.ownerId && dto.ownerId !== user.id) {
      await this.assertAssignableOwner(user, dto.ownerId, dto.storeId);
    }
    // Sequence-backed: `count() + 1` handed the same number to two reps
    // creating a lead at once, and re-used a number after any deletion.
    const seq = await this.sequence.next('LD:global');
    const lead = await this.prisma.lead.create({
      data: {
        organisationId: user.organisationId,
        ref: `LD-${5000 + seq}`,
        storeId: dto.storeId,
        customerName: dto.customerName,
        phone: dto.phone,
        value: dto.value != null ? new Prisma.Decimal(dto.value) : null,
        source: dto.source,
        stage: dto.stage ?? 'inquiry',
        interest: dto.interest,
        address: dto.address,
        location: dto.location,
        birthday: dto.birthday ? parseYmd(dto.birthday) : undefined,
        anniversary: dto.anniversary ? parseYmd(dto.anniversary) : undefined,
        ownerId: dto.ownerId ?? user.id,
        lastActivity: new Date(),
      },
    });

    // Auto follow-ups: SOP defaults +7d (seq 1) and +30d (seq 2) from create date.
    const base = todayUtc();
    await this.prisma.leadFollowUp.createMany({
      data: [
        { leadId: lead.id, storeId: lead.storeId, seq: 1, dueDate: addDaysUtc(base, FU1_DAYS) },
        { leadId: lead.id, storeId: lead.storeId, seq: 2, dueDate: addDaysUtc(base, FU2_DAYS) },
      ],
    });

    // CaratOS Phase A6 — give the lead a real customer identity.
    //
    // Until now `Lead.partyId` was written by nothing except the legacy sync, so
    // a lead captured at the counter and a sale to the same person six weeks
    // later were two unrelated records and Customer 360 had nothing to join on.
    //
    // Best-effort by design: a lead is a commercial record and must be created
    // even when the phone number is unusable. A failure here downgrades the lead
    // to identity-less — exactly what it was before — and never loses it.
    const identity = await this.identity.resolveForRecord(user, {
      phone: dto.phone,
      name: dto.customerName,
      storeId: dto.storeId,
      source: 'lead',
    });
    const partyId = identity.partyId;
    if (partyId) {
      await this.prisma.lead.update({ where: { id: lead.id }, data: { partyId } });
    } else if (dto.phone) {
      // The lead stands; it simply is not joined to a customer record yet. Logged
      // rather than swallowed so a systematically failing normaliser is visible.
      this.log.warn(`Lead ${lead.ref} has no linked customer: ${identity.unresolvedReason}`);
    }

    // Phase A10 — the DECLARED source becomes an attribution touch. Declared, not
    // measured: someone chose it from a dropdown, and the evidence column says so
    // for the rest of this record's life. Best-effort, like the identity link
    // above — marketing provenance is never worth losing a lead over.
    await this.attribution.recordLeadSource(user.organisationId, {
      id: lead.id,
      partyId,
      source: dto.source,
      createdAt: lead.createdAt,
    });

    await this.activity.recordFor(user, {
      type: 'lead.created',
      summary: `${user.name} created lead ${lead.ref} for ${dto.customerName}`,
      partyId,
      leadId: lead.id,
      storeId: lead.storeId,
      entityType: 'Lead',
      entityId: lead.id,
      channel: 'store',
      metadata: { source: dto.source, stage: lead.stage },
    });

    // Optional opening remark becomes the lead's first note.
    if (dto.remark && dto.remark.trim()) {
      await this.prisma.leadNote.create({
        data: {
          leadId: lead.id,
          authorId: user.id,
          authorName: user.name,
          text: dto.remark,
        },
      });
    }

    const full = await this.prisma.lead.findUnique({
      where: { id: lead.id },
      include: {
        owner: true,
        store: { select: { timezone: true } },
        notes: { include: { author: true }, orderBy: { createdAt: 'desc' } },
        reminders: true,
        followUps: followUpInclude,
      },
    });
    return toView(full);
  }

  async update(user: AuthUser, id: string, dto: UpdateLeadDto) {
    const existing = await this.prisma.lead.findFirst({
      where: { id, ...this.ownLead(user) },
    });
    if (!existing) throw new NotFoundException('Lead not found');
    if (dto.ownerId !== undefined && dto.ownerId !== existing.ownerId) {
      await this.assertAssignableOwner(user, dto.ownerId, existing.storeId);
    }

    const enteredQuotation = dto.stage === 'quotation' && existing.stage !== 'quotation';
    const enteredOrderPlaced = dto.stage === 'order_placed' && existing.stage !== 'order_placed';

    // Stage automation (Zoho-style): moving to quotation seeds a +2d follow-up
    // task unless an open one is already due within the next 3 days.
    if (enteredQuotation) {
      const today = todayUtc();
      const dupe = await this.prisma.leadFollowUp.findFirst({
        where: {
          leadId: id,
          done: false,
          dueDate: { gte: today, lte: addDaysUtc(today, 3) },
        },
      });
      if (!dupe) {
        const max = await this.prisma.leadFollowUp.aggregate({
          where: { leadId: id },
          _max: { seq: true },
        });
        await this.prisma.leadFollowUp.create({
          data: {
            leadId: id,
            storeId: existing.storeId,
            seq: (max._max.seq ?? 0) + 1,
            dueDate: addDaysUtc(today, 2),
            note: 'Follow up on the shared quotation',
          },
        });
      }
    }

    const lead = await this.prisma.lead.update({
      where: { id },
      data: {
        stage: dto.stage,
        interest: dto.interest,
        value: dto.value != null ? new Prisma.Decimal(dto.value) : undefined,
        ownerId: dto.ownerId,
        address: dto.address,
        location: dto.location,
        birthday: dto.birthday ? parseYmd(dto.birthday) : undefined,
        anniversary: dto.anniversary ? parseYmd(dto.anniversary) : undefined,
        lastActivity: new Date(),
        // Stage automation: an order placed means the lead is won.
        ...(enteredOrderPlaced ? { outcome: 'won', closedAt: new Date() } : {}),
      },
      include: {
        owner: true,
        store: { select: { timezone: true } },
        notes: { include: { author: true } },
        reminders: true,
        followUps: followUpInclude,
      },
    });
    return toView(lead);
  }

  // ---- Activities (Zoho: calls/visits/notes logged on the record) ---------

  /** Log an activity (note/call/visit/whatsapp) as a LeadNote and bump lastActivity. */
  async addActivity(user: AuthUser, leadId: string, dto: CreateActivityDto) {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, ...this.ownLead(user) },
    });
    if (!lead) throw new NotFoundException('Lead not found');

    await this.prisma.leadNote.create({
      data: {
        leadId,
        authorId: user.id,
        authorName: user.name,
        kind: dto.kind,
        text: dto.text,
      },
    });
    await this.prisma.lead.update({
      where: { id: leadId },
      data: { lastActivity: new Date() },
    });

    return this.get(user, leadId);
  }

  /** Add an ad-hoc follow-up task (next seq after the lead's current max). */
  async addFollowUp(user: AuthUser, leadId: string, dto: CreateFollowUpDto) {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, ...this.ownLead(user) },
    });
    if (!lead) throw new NotFoundException('Lead not found');

    const max = await this.prisma.leadFollowUp.aggregate({
      where: { leadId },
      _max: { seq: true },
    });
    const store = await this.prisma.store.findUnique({
      where: { id: lead.storeId },
      select: { timezone: true },
    });
    const reminderAt = await this.followUpReminders.resolveReminderAt({
      organisationId: user.organisationId,
      timezone: store?.timezone,
      dueDay: parseYmd(dto.dueDate),
      explicitLocal: dto.reminderAt,
    });
    const created = await this.prisma.leadFollowUp.create({
      data: {
        leadId,
        storeId: lead.storeId, // denormalized, same as the auto-seeded ones
        seq: (max._max.seq ?? 0) + 1,
        dueDate: parseYmd(dto.dueDate),
        note: dto.note,
        assigneeId: lead.ownerId ?? user.id,
        reminderAt,
      },
      include: { lead: { include: { store: true } } },
    });
    return toReminderView(created);
  }

  /** Set won/lost/open outcome; 'lost' requires a reason (Zoho closed-lost). */
  async setOutcome(user: AuthUser, id: string, dto: UpdateOutcomeDto) {
    const existing = await this.prisma.lead.findFirst({
      where: { id, ...this.ownLead(user) },
    });
    if (!existing) throw new NotFoundException('Lead not found');

    if (dto.outcome === 'lost' && !dto.lostReason?.trim()) {
      throw new BadRequestException('lostReason is required when marking a lead lost');
    }

    const lead = await this.prisma.lead.update({
      where: { id },
      data:
        dto.outcome === 'open'
          ? { outcome: 'open', lostReason: null, closedAt: null }
          : {
              outcome: dto.outcome,
              lostReason: dto.outcome === 'lost' ? dto.lostReason!.trim() : null,
              closedAt: new Date(),
            },
      include: {
        owner: true,
        store: { select: { timezone: true } },
        notes: { include: { author: true }, orderBy: { createdAt: 'desc' } },
        reminders: true,
        followUps: followUpInclude,
      },
    });
    return toView(lead);
  }

  // ---- Follow-up reminders (Module 1, in-app only) ------------------------

  /** List follow-up reminders in the user's store scope, ordered by dueDate asc. */
  async reminders(user: AuthUser, q: ReminderQuery, headerStore?: string) {
    const scope: ReminderScope = q.scope ?? 'pending';
    const where: Prisma.LeadFollowUpWhereInput = {
      ...this.scope.storeFilter(user, headerStore),
    };
    // A salesperson only sees follow-ups on leads they own (mirrors list()).
    if (user.role === 'salesperson') where.lead = { ownerId: user.id };
    const today = todayUtc();
    switch (scope) {
      case 'overdue':
        where.done = false;
        where.dueDate = { lt: today };
        break;
      case 'today':
        where.done = false;
        where.dueDate = today;
        break;
      case 'upcoming':
        where.done = false;
        where.dueDate = { gt: today };
        break;
      case 'all':
        break;
      case 'pending':
      default:
        where.done = false;
        break;
    }

    const rows = await this.prisma.leadFollowUp.findMany({
      where,
      include: { lead: { include: { store: true } } },
      orderBy: { dueDate: 'asc' },
    });
    return rows.map(toReminderView);
  }

  /** Reschedule or mark-done a single follow-up (store-scoped write). */
  async updateFollowUp(user: AuthUser, id: string, dto: UpdateFollowUpDto) {
    const existing = await this.prisma.leadFollowUp.findUnique({
      where: { id },
      include: { lead: { include: { store: true } } },
    });
    if (!existing) throw new NotFoundException('Follow-up not found');
    this.scope.assertStoreAllowed(user, existing.storeId);
    // A salesperson can only touch follow-ups on their own leads.
    if (user.role === 'salesperson' && existing.lead.ownerId !== user.id) {
      throw new ForbiddenException('You can only update follow-ups on your own leads');
    }

    const data: Prisma.LeadFollowUpUpdateInput = {};
    if (dto.dueDate) data.dueDate = parseYmd(dto.dueDate);
    const newDueDay = dto.dueDate ? parseYmd(dto.dueDate) : existing.dueDate;
    if (dto.reminderAt) {
      // An explicit new time is a new reminder, even if the old one already went.
      data.reminderAt = await this.followUpReminders.resolveReminderAt({
        organisationId: existing.lead.organisationId,
        timezone: existing.lead.store?.timezone,
        dueDay: newDueDay,
        explicitLocal: dto.reminderAt,
      });
      data.reminderNotifiedAt = null;
    } else if (dto.dueDate && existing.reminderAt && !existing.reminderNotifiedAt) {
      // Moving the due day moves a pending reminder by the same number of days,
      // keeping whatever time of day was chosen.
      const shift = newDueDay.getTime() - existing.dueDate.getTime();
      data.reminderAt = new Date(existing.reminderAt.getTime() + shift);
    }
    if (dto.note !== undefined) data.note = dto.note;
    if (dto.done !== undefined) {
      data.done = dto.done;
      if (dto.done) {
        data.doneAt = new Date();
        data.doneBy = { connect: { id: user.id } };
      } else {
        data.doneAt = null;
        data.doneBy = { disconnect: true };
      }
    }

    const updated = await this.prisma.leadFollowUp.update({
      where: { id },
      data,
      include: { lead: { include: { store: true } } },
    });

    // A supplied note becomes a lead note (the in-app "record" on approve).
    if (dto.note && dto.note.trim()) {
      await this.prisma.leadNote.create({
        data: {
          leadId: existing.leadId,
          authorId: user.id,
          authorName: user.name,
          text: dto.note,
        },
      });
      await this.prisma.lead.update({
        where: { id: existing.leadId },
        data: { lastActivity: new Date() },
      });
    }

    return toReminderView(updated);
  }
}
