import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StoreScopeService } from '../common/store-scope.service';
import { AuthUser } from '../common/auth-user';
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
    birthday: l.birthday ? l.birthday.toISOString().slice(0, 10) : null,
    anniversary: l.anniversary ? l.anniversary.toISOString().slice(0, 10) : null,
    createdAt: l.createdAt.toISOString().slice(0, 10),
    lastActivity: (l.lastActivity ?? l.updatedAt).toISOString().slice(0, 10),
    outcome: l.outcome ?? 'open',
    lostReason: l.lostReason ?? null,
    closedAt: l.closedAt ? l.closedAt.toISOString() : null,
    temperature: computeTemperature(l),
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
  };
}

@Injectable()
export class LeadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
  ) {}

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
    if (q.rep) where.OR = [{ ownerId: q.rep }, { owner: { name: { contains: q.rep, mode: 'insensitive' } } }];
    if (q.from || q.to) {
      where.createdAt = {
        ...(q.from ? { gte: parseYmd(q.from) } : {}),
        ...(q.to ? { lte: endOfDayUtc(q.to) } : {}),
      };
    }

    const leads = await this.prisma.lead.findMany({
      where,
      include: {
        owner: true,
        notes: { include: { author: true } },
        reminders: true,
        followUps: followUpInclude,
      },
      orderBy: { createdAt: 'desc' },
    });
    return leads.map(toView);
  }

  async get(user: AuthUser, id: string) {
    const lead = await this.prisma.lead.findFirst({
      where: { id, ...this.scope.storeFilter(user) },
      include: {
        owner: true,
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
    const count = await this.prisma.lead.count();
    const lead = await this.prisma.lead.create({
      data: {
        ref: `LD-${5000 + count + 1}`,
        storeId: dto.storeId,
        customerName: dto.customerName,
        phone: dto.phone,
        value: dto.value != null ? new Prisma.Decimal(dto.value) : null,
        source: dto.source,
        stage: dto.stage ?? 'inquiry',
        interest: dto.interest,
        address: dto.address,
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
        notes: { include: { author: true }, orderBy: { createdAt: 'desc' } },
        reminders: true,
        followUps: followUpInclude,
      },
    });
    return toView(full);
  }

  async update(user: AuthUser, id: string, dto: UpdateLeadDto) {
    const existing = await this.prisma.lead.findFirst({
      where: { id, ...this.scope.storeFilter(user) },
    });
    if (!existing) throw new NotFoundException('Lead not found');

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
        birthday: dto.birthday ? parseYmd(dto.birthday) : undefined,
        anniversary: dto.anniversary ? parseYmd(dto.anniversary) : undefined,
        lastActivity: new Date(),
        // Stage automation: an order placed means the lead is won.
        ...(enteredOrderPlaced ? { outcome: 'won', closedAt: new Date() } : {}),
      },
      include: {
        owner: true,
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
      where: { id: leadId, ...this.scope.storeFilter(user) },
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
      where: { id: leadId, ...this.scope.storeFilter(user) },
    });
    if (!lead) throw new NotFoundException('Lead not found');

    const max = await this.prisma.leadFollowUp.aggregate({
      where: { leadId },
      _max: { seq: true },
    });
    const created = await this.prisma.leadFollowUp.create({
      data: {
        leadId,
        storeId: lead.storeId, // denormalized, same as the auto-seeded ones
        seq: (max._max.seq ?? 0) + 1,
        dueDate: parseYmd(dto.dueDate),
        note: dto.note,
      },
      include: { lead: { include: { store: true } } },
    });
    return toReminderView(created);
  }

  /** Set won/lost/open outcome; 'lost' requires a reason (Zoho closed-lost). */
  async setOutcome(user: AuthUser, id: string, dto: UpdateOutcomeDto) {
    const existing = await this.prisma.lead.findFirst({
      where: { id, ...this.scope.storeFilter(user) },
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

    const data: Prisma.LeadFollowUpUpdateInput = {};
    if (dto.dueDate) data.dueDate = parseYmd(dto.dueDate);
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
