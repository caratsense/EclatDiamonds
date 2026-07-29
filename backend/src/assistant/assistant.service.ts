import { Injectable } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { ROLE_LABELS, ROLE_RANK } from '../common/role.util';
import { REQUEST_KIND_LABELS } from '../special-requests/request-routing';
import { AskDto } from './dto/assistant.dto';

/**
 * A row the assistant hands back — deliberately uniform whatever the intent, so
 * the chat panel renders one card component rather than a branch per answer.
 */
export interface AssistantResultItem {
  id: string;
  title: string;
  subtitle?: string | null;
  meta?: string | null;
  href?: string | null;
  /** Renders the row's status chip: 'neutral' | 'warn' | 'danger' | 'ok'. */
  tone?: 'neutral' | 'warn' | 'danger' | 'ok';
}

export interface AssistantAnswer {
  intent: string;
  /** One-line natural answer, already phrased for display. */
  answer: string;
  items: AssistantResultItem[];
  /** Follow-up prompts offered as tappable chips. */
  suggestions: string[];
}

/**
 * A recognised question. `match` is deliberately a keyword predicate rather than
 * a single regex: real users type "whats pending for me", "pending approvals?"
 * and "anything waiting on me" for the same thing, and a keyword set covers that
 * spread far better than a phrase pattern.
 */
interface Intent {
  id: string;
  /** Chip label offered in the UI. */
  label: string;
  /** Any of these must appear. */
  any: string[];
  /** …and at least one of these too, when present (narrows an overlapping match). */
  and?: string[];
  /** Minimum role for the intent to be offered/answered at all. */
  minRole?: Role;
}

const INTENTS: Intent[] = [
  {
    id: 'pending_approvals',
    label: 'What needs my approval?',
    any: ['approv', 'pending', 'waiting', 'sign off', 'signoff', 'authorise', 'authorize'],
    minRole: 'store_manager',
  },
  {
    id: 'diamond_rate_requests',
    label: 'Diamond rate requests',
    any: ['diamond', 'rate', 'carat'],
  },
  {
    id: 'branch_requests',
    label: 'Branch requests',
    any: ['branch', 'special request', 'requests from', 'store request'],
  },
  {
    id: 'my_requests',
    label: 'My requests',
    any: ['my request', 'i raised', 'i sent', 'my special', 'raised by me'],
  },
  { id: 'notifications', label: 'My notifications', any: ['notification', 'alert', 'unread', 'bell'] },
  { id: 'leave', label: 'Leave requests', any: ['leave', 'holiday request', 'time off', 'absent'] },
  { id: 'delayed_orders', label: 'Delayed orders', any: ['order', 'delay', 'late order', 'overdue', 'stuck'] },
  { id: 'discounts', label: 'Discount approvals', any: ['discount', 'markdown', 'concession'] },
  { id: 'returns', label: 'Returns & buybacks', any: ['return', 'buyback', 'exchange', 'refund'] },
  { id: 'attendance', label: "Today's attendance", any: ['attendance', 'who is in', 'punch', 'checked in', 'late today'] },
  { id: 'help', label: 'What can you do?', any: ['help', 'what can you', 'how do i', 'commands'] },
];

/** Normalise for matching: lowercase, strip punctuation, collapse whitespace. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function money(v: Prisma.Decimal | number | null | undefined): string {
  if (v == null) return '—';
  return `₹${Number(v).toLocaleString('en-IN')}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * AssistantService — a deterministic question-answering layer over the data the
 * caller can already see.
 *
 * ## Why no model
 *
 * Every answer here is a scoped Prisma query. Running it through an LLM would
 * add latency, cost and a class of failure (a confidently wrong number about
 * money or approvals) in exchange for tolerating phrasings a keyword match
 * already handles. If natural-language coverage later proves too narrow, this
 * service is the right seam to put a model in FRONT of: it would pick the intent
 * and these methods would still produce the data.
 *
 * ## Access
 *
 * Nothing here bypasses store-scoping or role rank. Each intent runs the same
 * `StoreScopeService` filter the REST endpoints use, so the assistant can only
 * ever surface what the user could already reach by navigating — it is a faster
 * route to their own data, never a wider one.
 */
@Injectable()
export class AssistantService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
  ) {}

  /** The chips shown before the user types anything, filtered by role. */
  suggestionsFor(user: AuthUser): string[] {
    return INTENTS.filter(
      (i) => i.id !== 'help' && (!i.minRole || ROLE_RANK[user.role] >= ROLE_RANK[i.minRole]),
    ).map((i) => i.label);
  }

  /** Pick the best intent for a question, or null when nothing matches. */
  private resolveIntent(text: string, user: AuthUser): Intent | null {
    const q = normalise(text);
    if (!q) return null;

    let best: { intent: Intent; score: number } | null = null;
    for (const intent of INTENTS) {
      if (intent.minRole && ROLE_RANK[user.role] < ROLE_RANK[intent.minRole]) continue;
      const hits = intent.any.filter((k) => q.includes(k)).length;
      if (hits === 0) continue;
      const andHits = intent.and ? intent.and.filter((k) => q.includes(k)).length : 0;
      const score = hits * 2 + andHits;
      if (!best || score > best.score) best = { intent, score };
    }
    return best?.intent ?? null;
  }

  /** POST /assistant/ask — answer a question about the caller's own workload. */
  async ask(user: AuthUser, dto: AskDto, headerStore?: string): Promise<AssistantAnswer> {
    const intent = this.resolveIntent(dto.text, user);
    if (!intent) return this.help(user, true);

    switch (intent.id) {
      case 'pending_approvals':
        return this.pendingApprovals(user, headerStore);
      case 'diamond_rate_requests':
        return this.diamondRateRequests(user, headerStore);
      case 'branch_requests':
        return this.branchRequests(user, headerStore);
      case 'my_requests':
        return this.myRequests(user);
      case 'notifications':
        return this.notifications(user);
      case 'leave':
        return this.leave(user, headerStore);
      case 'delayed_orders':
        return this.delayedOrders(user, headerStore);
      case 'discounts':
        return this.discounts(user, headerStore);
      case 'returns':
        return this.returns(user, headerStore);
      case 'attendance':
        return this.attendance(user, headerStore);
      default:
        return this.help(user, false);
    }
  }

  // ==========================================================================
  // Intent handlers — every query is store-scoped and role-filtered
  // ==========================================================================

  /** Roles this user outranks-or-equals, i.e. requests they may decide. */
  private actableRoles(user: AuthUser): Role[] {
    return (Object.keys(ROLE_RANK) as Role[]).filter(
      (r) => ROLE_RANK[user.role] >= ROLE_RANK[r],
    );
  }

  /** Everything across every queue that is genuinely waiting on THIS person. */
  private async pendingApprovals(user: AuthUser, headerStore?: string): Promise<AssistantAnswer> {
    const where = this.scope.storeFilter(user, headerStore);
    const actable = this.actableRoles(user);

    const [special, discounts, leave, returns] = await Promise.all([
      this.prisma.specialRequest.findMany({
        where: {
          ...where,
          status: { in: ['pending', 'escalated'] },
          requiredRole: { in: actable },
          requestedById: { not: user.id },
        },
        include: { store: { select: { name: true } } },
        orderBy: { createdAt: 'asc' },
        take: 10,
      }),
      this.prisma.discountRequest.findMany({
        where: {
          ...where,
          status: { in: ['pending', 'escalated'] },
          requestedById: { not: user.id },
          OR: [
            { requiredRole: { in: actable } },
            { requiredRole: null, requestedRole: { in: actable } },
          ],
        },
        orderBy: { createdAt: 'asc' },
        take: 10,
      }),
      this.prisma.leaveRequest.findMany({
        where: { ...where, status: 'pending', staffId: { not: user.id } },
        orderBy: { fromDate: 'asc' },
        take: 10,
      }),
      user.role === 'head_office'
        ? this.prisma.returnRecord.findMany({
            where: { ...where, status: 'pending_approval' },
            orderBy: { createdAt: 'asc' },
            take: 10,
          })
        : Promise.resolve([]),
    ]);

    const items: AssistantResultItem[] = [
      ...special.map((r) => ({
        id: r.id,
        title: `${r.ref} · ${REQUEST_KIND_LABELS[r.kind]}`,
        subtitle: `${r.store?.name ?? ''} — ${r.title}`,
        meta: r.amount != null ? money(r.amount) : null,
        href: `/requests?open=${r.id}`,
        tone: r.neededBy && r.neededBy.getTime() < Date.now()
          ? ('danger' as const)
          : ('warn' as const),
      })),
      ...discounts.map((d) => ({
        id: d.id,
        title: `${d.ref} · Discount`,
        subtitle: `${d.customerName} — ${Number(d.diamondPercent ?? 0)}% diamond / ${Number(
          d.makingPercent ?? 0,
        )}% making`,
        href: '/approvals',
        tone: 'warn' as const,
      })),
      ...leave.map((l) => ({
        id: l.id,
        title: `Leave · ${l.staffName ?? l.staffId}`,
        subtitle: `${l.type} — ${l.fromDate.toISOString().slice(0, 10)} → ${l.toDate
          .toISOString()
          .slice(0, 10)}`,
        href: '/approvals',
        tone: 'neutral' as const,
      })),
      ...returns.map((r) => ({
        id: r.id,
        title: `${r.ref} · ${r.type}`,
        subtitle: `${r.customerName} — ${money(r.value)}`,
        href: '/approvals',
        tone: 'warn' as const,
      })),
    ];

    const answer = items.length
      ? `You have ${plural(items.length, 'item')} waiting on your decision — ` +
        [
          special.length ? plural(special.length, 'branch request') : null,
          discounts.length ? plural(discounts.length, 'discount') : null,
          leave.length ? plural(leave.length, 'leave request') : null,
          returns.length ? plural(returns.length, 'return') : null,
        ]
          .filter(Boolean)
          .join(', ') +
        '.'
      : 'Nothing is waiting on your approval right now.';

    return {
      intent: 'pending_approvals',
      answer,
      items,
      suggestions: ['Diamond rate requests', 'Branch requests', 'Delayed orders'],
    };
  }

  /** Diamond-rate requests, the flow HO cares about most. */
  private async diamondRateRequests(user: AuthUser, headerStore?: string): Promise<AssistantAnswer> {
    const where = this.scope.storeFilter(user, headerStore);
    const isApprover = ROLE_RANK[user.role] >= ROLE_RANK.store_manager;

    const rows = await this.prisma.specialRequest.findMany({
      where: {
        ...where,
        kind: 'diamond_rate',
        // A salesperson only sees the ones they raised themselves.
        ...(isApprover ? {} : { requestedById: user.id }),
      },
      include: { store: { select: { name: true } } },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 20,
    });

    const open = rows.filter((r) => r.status === 'pending' || r.status === 'escalated');
    const items: AssistantResultItem[] = rows.map((r) => ({
      id: r.id,
      title: `${r.ref} · ${r.diamondSpec ?? 'Diamond rate'}`,
      subtitle: `${r.store?.name ?? ''} — asking ${money(r.requestedRatePerCarat)}/carat${
        r.currentRatePerCarat != null ? ` (current ${money(r.currentRatePerCarat)})` : ''
      }`,
      meta: r.status,
      href: `/requests?open=${r.id}`,
      tone:
        r.status === 'approved'
          ? ('ok' as const)
          : r.status === 'rejected' || r.status === 'cancelled'
            ? ('neutral' as const)
            : ('warn' as const),
    }));

    return {
      intent: 'diamond_rate_requests',
      answer: rows.length
        ? `${plural(open.length, 'diamond-rate request')} awaiting a decision, ${
            rows.length - open.length
          } already decided.`
        : 'No diamond-rate requests have been raised.',
      items,
      suggestions: ['What needs my approval?', 'Branch requests'],
    };
  }

  /** Everything branches have raised, whatever the kind. */
  private async branchRequests(user: AuthUser, headerStore?: string): Promise<AssistantAnswer> {
    const where = this.scope.storeFilter(user, headerStore);
    const isApprover = ROLE_RANK[user.role] >= ROLE_RANK.store_manager;

    const rows = await this.prisma.specialRequest.findMany({
      where: {
        ...where,
        status: { in: ['pending', 'escalated'] },
        ...(isApprover ? {} : { requestedById: user.id }),
      },
      include: { store: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    const byStore = new Map<string, number>();
    for (const r of rows) {
      const name = r.store?.name ?? r.storeId;
      byStore.set(name, (byStore.get(name) ?? 0) + 1);
    }
    const breakdown = [...byStore.entries()]
      .map(([name, n]) => `${name} (${n})`)
      .join(', ');

    return {
      intent: 'branch_requests',
      answer: rows.length
        ? `${plural(rows.length, 'open branch request')} — ${breakdown}.`
        : 'No branch has an open request right now.',
      items: rows.map((r) => ({
        id: r.id,
        title: `${r.ref} · ${REQUEST_KIND_LABELS[r.kind]}`,
        subtitle: `${r.store?.name ?? ''} — ${r.title}`,
        meta: `needs ${ROLE_LABELS[r.requiredRole]}`,
        href: `/requests?open=${r.id}`,
        tone: r.neededBy && r.neededBy.getTime() < Date.now()
          ? ('danger' as const)
          : ('warn' as const),
      })),
      suggestions: ['Diamond rate requests', 'What needs my approval?'],
    };
  }

  /** What the caller has asked for and where it got to. */
  private async myRequests(user: AuthUser): Promise<AssistantAnswer> {
    const rows = await this.prisma.specialRequest.findMany({
      where: { requestedById: user.id },
      include: { store: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    const open = rows.filter((r) => r.status === 'pending' || r.status === 'escalated');

    return {
      intent: 'my_requests',
      answer: rows.length
        ? `You have raised ${plural(rows.length, 'request')}; ${open.length} still awaiting a decision.`
        : "You haven't raised any requests yet.",
      items: rows.map((r) => ({
        id: r.id,
        title: `${r.ref} · ${REQUEST_KIND_LABELS[r.kind]}`,
        subtitle: r.title,
        meta:
          r.status === 'approved' || r.status === 'rejected'
            ? `${r.status} by ${r.decidedByName ?? 'a manager'}`
            : `with ${ROLE_LABELS[r.requiredRole]}`,
        href: `/requests?open=${r.id}`,
        tone:
          r.status === 'approved'
            ? ('ok' as const)
            : r.status === 'rejected'
              ? ('danger' as const)
              : ('warn' as const),
      })),
      suggestions: ['My notifications', 'What needs my approval?'],
    };
  }

  /** The caller's own notification feed, summarised. */
  private async notifications(user: AuthUser): Promise<AssistantAnswer> {
    const rows = await this.prisma.notification.findMany({
      where: { userId: user.id, dismissedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    const unread = rows.filter((r) => r.readAt == null).length;

    return {
      intent: 'notifications',
      answer: rows.length
        ? `${plural(rows.length, 'notification')} in your bell, ${unread} unread.`
        : 'Your notifications are all clear.',
      items: rows.map((r) => ({
        id: r.id,
        title: r.title,
        subtitle: r.body,
        meta: r.readAt ? null : 'unread',
        href: r.href,
        tone: r.priority === 'high' ? ('danger' as const) : ('neutral' as const),
      })),
      suggestions: ['What needs my approval?', 'My requests'],
    };
  }

  private async leave(user: AuthUser, headerStore?: string): Promise<AssistantAnswer> {
    const where = this.scope.storeFilter(user, headerStore);
    const isApprover = ROLE_RANK[user.role] >= ROLE_RANK.store_manager;
    const rows = await this.prisma.leaveRequest.findMany({
      where: {
        ...where,
        status: 'pending',
        ...(isApprover ? {} : { staffId: user.id }),
      },
      orderBy: { fromDate: 'asc' },
      take: 20,
    });

    return {
      intent: 'leave',
      answer: rows.length
        ? `${plural(rows.length, 'pending leave request')}.`
        : 'No leave requests are pending.',
      items: rows.map((l) => ({
        id: l.id,
        title: l.staffName ?? l.staffId,
        subtitle: `${l.type} · ${l.fromDate.toISOString().slice(0, 10)} → ${l.toDate
          .toISOString()
          .slice(0, 10)}`,
        meta: l.reason,
        href: isApprover ? '/approvals' : '/hrms',
        tone: 'neutral' as const,
      })),
      suggestions: ["Today's attendance", 'What needs my approval?'],
    };
  }

  private async delayedOrders(user: AuthUser, headerStore?: string): Promise<AssistantAnswer> {
    const where = this.scope.storeFilter(user, headerStore);
    const rows = await this.prisma.customOrder.findMany({
      where: {
        ...where,
        stage: { notIn: ['delivered', 'cancelled'] },
        eta: { lt: new Date() },
      },
      include: { store: { select: { name: true } } },
      orderBy: { eta: 'asc' },
      take: 20,
    });

    return {
      intent: 'delayed_orders',
      answer: rows.length
        ? `${plural(rows.length, 'order')} past the promised date.`
        : 'Every open order is still inside its promised date.',
      items: rows.map((o) => ({
        id: o.id,
        title: `${o.ref} · ${o.item}`,
        subtitle: `${o.customerName} — ${o.store?.name ?? ''}`,
        meta: `due ${o.eta ? o.eta.toISOString().slice(0, 10) : '—'} · ${o.stage}`,
        href: '/timelines',
        tone: 'danger' as const,
      })),
      suggestions: ['What needs my approval?', 'Branch requests'],
    };
  }

  private async discounts(user: AuthUser, headerStore?: string): Promise<AssistantAnswer> {
    const where = this.scope.storeFilter(user, headerStore);
    const actable = this.actableRoles(user);
    const rows = await this.prisma.discountRequest.findMany({
      where: {
        ...where,
        status: { in: ['pending', 'escalated'] },
        ...(ROLE_RANK[user.role] >= ROLE_RANK.store_manager
          ? { requestedById: { not: user.id }, requiredRole: { in: actable } }
          : { requestedById: user.id }),
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    return {
      intent: 'discounts',
      answer: rows.length
        ? `${plural(rows.length, 'discount request')} awaiting a decision.`
        : 'No discount requests are waiting.',
      items: rows.map((d) => ({
        id: d.id,
        title: `${d.ref} · ${d.customerName}`,
        subtitle: `${Number(d.diamondPercent ?? 0)}% diamond / ${Number(
          d.makingPercent ?? 0,
        )}% making`,
        meta: d.requiredRole ? `needs ${ROLE_LABELS[d.requiredRole]}` : null,
        href: '/approvals',
        tone: 'warn' as const,
      })),
      suggestions: ['What needs my approval?', 'Returns & buybacks'],
    };
  }

  private async returns(user: AuthUser, headerStore?: string): Promise<AssistantAnswer> {
    const where = this.scope.storeFilter(user, headerStore);
    const rows = await this.prisma.returnRecord.findMany({
      where: { ...where, status: 'pending_approval' },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    return {
      intent: 'returns',
      answer: rows.length
        ? `${plural(rows.length, 'return')} awaiting head-office sign-off.`
        : 'No returns are awaiting approval.',
      items: rows.map((r) => ({
        id: r.id,
        title: `${r.ref} · ${r.type}`,
        subtitle: `${r.customerName} — ${money(r.value)}`,
        meta: r.reason,
        href: '/returns',
        tone: 'warn' as const,
      })),
      suggestions: ['What needs my approval?', 'Discount approvals'],
    };
  }

  private async attendance(user: AuthUser, headerStore?: string): Promise<AssistantAnswer> {
    const where = this.scope.storeFilter(user, headerStore);
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const rows = await this.prisma.attendanceRecord.findMany({
      where: {
        ...where,
        date: today,
        // A salesperson only ever sees their own attendance.
        ...(ROLE_RANK[user.role] < ROLE_RANK.store_manager ? { staffId: user.id } : {}),
      },
      orderBy: { staffName: 'asc' },
      take: 60,
    });

    const late = rows.filter((r) => r.isLate).length;
    const absent = rows.filter((r) => r.status === 'absent').length;
    const offsite = rows.filter((r) => r.checkInAt != null && !r.geoVerified).length;

    return {
      intent: 'attendance',
      answer: rows.length
        ? `${plural(rows.length, 'record')} for today — ${late} late, ${absent} absent${
            offsite ? `, ${offsite} punched off-site` : ''
          }.`
        : 'No attendance has been recorded for today yet.',
      items: rows.map((r) => ({
        id: r.id,
        title: r.staffName ?? r.staffId,
        subtitle: r.status,
        meta: r.isLate ? `late ${r.lateMinutes ?? 0}m` : null,
        href: '/hrms',
        tone:
          r.status === 'absent'
            ? ('danger' as const)
            : r.isLate || (r.checkInAt != null && !r.geoVerified)
              ? ('warn' as const)
              : ('ok' as const),
      })),
      suggestions: ['Leave requests', 'What needs my approval?'],
    };
  }

  /** Fallback: say plainly what is answerable rather than guessing. */
  private help(user: AuthUser, unmatched: boolean): AssistantAnswer {
    const chips = this.suggestionsFor(user);
    return {
      intent: 'help',
      answer: unmatched
        ? "I didn't catch that. Here's what I can look up for you:"
        : 'I can look up anything waiting on you, and anything you have raised:',
      items: [],
      suggestions: chips,
    };
  }
}
