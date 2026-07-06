import { Injectable, NotFoundException } from '@nestjs/common';
import { TicketCategory } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import {
  CreateTicketDto,
  CreateTicketMessageDto,
  UpdateTicketDto,
} from './dto/ticket.dto';

/** Auto-routing table (Module 13): category -> resolver team. */
const RESOLVER_TEAM: Record<TicketCategory, string> = {
  it: 'IT Helpdesk',
  hr: 'People Ops',
  maintenance: 'Facilities',
  logistics: 'Supply Chain',
};

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function toListView(t: any) {
  return {
    id: t.id,
    ref: t.ref,
    subject: t.subject,
    store: t.store?.name ?? 'Head Office',
    category: t.category,
    priority: t.priority,
    status: t.status,
    assignee: t.assigneeName ?? 'Unassigned',
    reporter: t.reporterName ?? '—',
    createdAt: dateOnly(t.createdAt),
    updatedAt: dateOnly(t.updatedAt),
    patternTag: t.patternTag ?? undefined,
  };
}

@Injectable()
export class TicketingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
  ) {}

  /**
   * Tickets may be store-less (HO-level). Build a where that admits the user's
   * scoped stores plus null-store tickets (visible to everyone in scope).
   */
  private scopedWhere(user: AuthUser, headerStore?: string) {
    const f = this.scope.storeFilter(user, headerStore);
    if (Object.keys(f).length === 0) return {}; // head_office, no narrowing
    return { OR: [f, { storeId: null }] };
  }

  /** GET /tickets — issue list with auto-routing + recurring-pattern clusters. */
  async list(user: AuthUser, headerStore?: string) {
    const tickets = await this.prisma.ticket.findMany({
      where: this.scopedWhere(user, headerStore),
      include: { store: true },
      orderBy: { createdAt: 'desc' },
    });
    return { tickets: tickets.map(toListView), patterns: detectPatterns(tickets) };
  }

  /** GET /tickets/:id — one ticket with its message thread. */
  async get(user: AuthUser, id: string) {
    const t = await this.prisma.ticket.findFirst({
      where: { id, ...this.scopedWhere(user) },
      include: { store: true, messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!t) throw new NotFoundException('Ticket not found');
    return {
      ...toListView(t),
      thread: t.messages.map((m) => ({
        id: m.id,
        author: m.authorName ?? 'System',
        system: !m.authorId,
        at: dateOnly(m.createdAt),
        body: m.body,
      })),
    };
  }

  /** POST /tickets — raise a ticket; auto-routes to the resolver team for the category. */
  async create(user: AuthUser, dto: CreateTicketDto) {
    if (dto.storeId) this.scope.assertStoreAllowed(user, dto.storeId);
    const count = await this.prisma.ticket.count();
    const team = RESOLVER_TEAM[dto.category];

    const ticket = await this.prisma.ticket.create({
      data: {
        ref: `TKT-${2061 + count + 1}`,
        storeId: dto.storeId ?? null,
        subject: dto.subject,
        category: dto.category,
        priority: dto.priority ?? 'medium',
        status: 'routed',
        assigneeName: team,
        reporterName: dto.reporterName ?? user.name,
        patternTag: dto.patternTag,
        messages: {
          create: {
            body: `Auto-routed to ${team} based on category: ${dto.category.toUpperCase()}.`,
          },
        },
      },
      include: { store: true, messages: true },
    });
    return toListView(ticket);
  }

  /** PATCH /tickets/:id — update status / priority / assignee. */
  async update(user: AuthUser, id: string, dto: UpdateTicketDto) {
    const existing = await this.prisma.ticket.findFirst({
      where: { id, ...this.scopedWhere(user) },
    });
    if (!existing) throw new NotFoundException('Ticket not found');
    const ticket = await this.prisma.ticket.update({
      where: { id },
      data: {
        status: dto.status,
        priority: dto.priority,
        assigneeId: dto.assigneeId,
        assigneeName: dto.assigneeName,
      },
      include: { store: true },
    });
    return toListView(ticket);
  }

  /** POST /tickets/:id/messages — append a reply to the thread. */
  async addMessage(user: AuthUser, id: string, dto: CreateTicketMessageDto) {
    const existing = await this.prisma.ticket.findFirst({
      where: { id, ...this.scopedWhere(user) },
    });
    if (!existing) throw new NotFoundException('Ticket not found');
    await this.prisma.ticketMessage.create({
      data: { ticketId: id, authorId: user.id, authorName: user.name, body: dto.body },
    });
    await this.prisma.ticket.update({ where: { id }, data: { updatedAt: new Date() } });
    return this.get(user, id);
  }
}

interface RecurringPattern {
  tag: string;
  label: string;
  category: string;
  count: number;
  stores: string[];
  insight: string;
}

/** Cluster >=2 tickets sharing a patternTag (structural-fix detection). */
function detectPatterns(tickets: any[]): RecurringPattern[] {
  const groups = new Map<string, any[]>();
  for (const t of tickets) {
    if (!t.patternTag) continue;
    const arr = groups.get(t.patternTag) ?? [];
    arr.push(t);
    groups.set(t.patternTag, arr);
  }
  const out: RecurringPattern[] = [];
  for (const [tag, arr] of groups) {
    if (arr.length < 2) continue;
    out.push({
      tag,
      label: tag.replace(/-/g, ' '),
      category: arr[0].category,
      count: arr.length,
      stores: [...new Set(arr.map((t) => t.store?.name ?? 'Head Office'))],
      insight: `Recurring across ${arr.length} tickets — likely a structural issue, not isolated incidents.`,
    });
  }
  return out.sort((a, b) => b.count - a.count);
}
