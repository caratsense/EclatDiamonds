import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StoreScopeService } from '../common/store-scope.service';
import { AuthUser } from '../common/auth-user';
import {
  CreateLeadDto,
  ListLeadsQuery,
  ReminderQuery,
  ReminderScope,
  UpdateFollowUpDto,
  UpdateLeadDto,
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
    notes: (l.notes ?? []).map((n: any) => ({
      id: n.id,
      at: n.createdAt.toISOString().slice(0, 10),
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
    if (q.stage) where.stage = q.stage;
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
