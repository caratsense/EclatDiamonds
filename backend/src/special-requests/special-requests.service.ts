import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  Role,
  SpecialRequestKind,
  SpecialRequestStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { AuditService } from '../common/audit.service';
import { SequenceService } from '../common/sequence.service';
import { NotificationsService } from '../notifications/notifications.service';
import { assertNotSelfApproval, assertUndecided } from '../common/approval.util';
import { ROLE_LABELS, ROLE_RANK } from '../common/role.util';
import {
  canDecide,
  REQUEST_KIND_LABELS,
  resolveRequiredRole,
  roleAbove,
} from './request-routing';
import {
  AddRequestMessageDto,
  CancelSpecialRequestDto,
  CreateSpecialRequestDto,
  DecideSpecialRequestDto,
  EscalateSpecialRequestDto,
  ListSpecialRequestsQueryDto,
} from './dto/special-request.dto';

/** States a request can no longer be decided from. */
const TERMINAL: readonly string[] = ['approved', 'rejected', 'cancelled'];

function num(v: Prisma.Decimal | number | null | undefined): number | null {
  return v == null ? null : Number(v);
}

function parseDateOnly(s: string): Date {
  const d = new Date(s);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

@Injectable()
export class SpecialRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly audit: AuditService,
    private readonly sequence: SequenceService,
    private readonly notifications: NotificationsService,
  ) {}

  // ==========================================================================
  // Create
  // ==========================================================================

  /**
   * POST /requests — a branch raises a request.
   *
   * The approver level is derived, never chosen by the requester: letting the
   * branch pick its own approver would make the ladder advisory. See
   * `request-routing.ts` for the rules.
   */
  async create(user: AuthUser, dto: CreateSpecialRequestDto) {
    this.scope.assertStoreAllowed(user, dto.storeId);

    // A diamond-rate request without a spec and a number is not actionable —
    // the approver would have nothing to say yes to.
    let currentRate: number | null = null;
    if (dto.kind === SpecialRequestKind.diamond_rate) {
      if (!dto.diamondSpec?.trim() || dto.requestedRatePerCarat == null) {
        throw new BadRequestException(
          'A diamond-rate request needs both the spec and the requested rate per carat',
        );
      }
      currentRate = await this.currentDiamondRate(
        user.organisationId,
        dto.diamondSpec.trim(),
        dto.storeId,
      );
    }

    const requiredRole = resolveRequiredRole(dto.kind, user.role, dto.amount ?? null);

    const store = await this.prisma.store.findUnique({
      where: { id: dto.storeId },
      select: { code: true, name: true },
    });
    const now = new Date();
    const period = `${String(now.getUTCFullYear()).slice(2)}${String(
      now.getUTCMonth() + 1,
    ).padStart(2, '0')}`;
    const branch = (store?.code ?? dto.storeId.slice(-4)).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const ref = await this.sequence.nextRef('SR', `${branch}-${period}`);

    const row = await this.prisma.specialRequest.create({
      data: {
        organisationId: user.organisationId,
        ref,
        storeId: dto.storeId,
        kind: dto.kind,
        title: dto.title.trim(),
        details: dto.details?.trim() || null,
        amount: dto.amount != null ? new Prisma.Decimal(dto.amount) : null,
        priority: dto.priority ?? 'medium',
        neededBy: dto.neededBy ? parseDateOnly(dto.neededBy) : null,
        requestedById: user.id,
        requestedByName: user.name,
        requestedRole: user.role,
        requiredRole,
        status: 'pending',
        diamondSpec: dto.diamondSpec?.trim() || null,
        currentRatePerCarat:
          currentRate != null ? new Prisma.Decimal(currentRate) : null,
        requestedRatePerCarat:
          dto.requestedRatePerCarat != null
            ? new Prisma.Decimal(dto.requestedRatePerCarat)
            : null,
      },
      include: { messages: true },
    });

    await this.notifications.emitToApprovers(
      dto.storeId,
      requiredRole,
      {
        kind:
          dto.kind === SpecialRequestKind.diamond_rate
            ? 'diamond_rate_request'
            : 'special_request',
        title: `${REQUEST_KIND_LABELS[dto.kind]} request from ${store?.name ?? 'a branch'}`,
        body: dto.title.trim(),
        href: `/requests?open=${row.id}`,
        storeId: dto.storeId,
        entityType: 'SpecialRequest',
        entityId: row.id,
        priority:
          dto.priority === 'urgent' || dto.priority === 'high' ? 'high' : 'normal',
        actorId: user.id,
        actorName: user.name,
        // One notification per approver per request, however many times the
        // create path is retried.
        dedupeKey: `special_request:${row.id}:raised`,
        metadata: { ref: row.ref, kind: dto.kind, amount: dto.amount ?? null },
      },
      user.id,
    );

    await this.audit.record(user, {
      action: 'special_request.raise',
      entityType: 'SpecialRequest',
      entityId: row.id,
      storeId: dto.storeId,
      summary: `Raised ${REQUEST_KIND_LABELS[dto.kind]} request ${row.ref}: ${row.title}`,
      metadata: { kind: dto.kind, amount: dto.amount ?? null, requiredRole },
    });

    return this.toView(row, user);
  }

  /** The rate currently in force for a spec — store override wins over global. */
  private async currentDiamondRate(
    organisationId: string,
    spec: string,
    storeId: string,
  ): Promise<number | null> {
    const rate = await this.prisma.diamondRate.findFirst({
      where: { spec, organisationId, effectiveFrom: { lte: new Date() }, OR: [{ storeId }, { storeId: null }] },
      orderBy: [{ storeId: 'desc' }, { effectiveFrom: 'desc' }],
    });
    return rate ? Number(rate.ratePerCarat) : null;
  }

  // ==========================================================================
  // Read
  // ==========================================================================

  /** GET /requests — store-scoped, with an approver-inbox view. */
  async list(user: AuthUser, query: ListSpecialRequestsQueryDto, headerStore?: string) {
    const scope = query.scope ?? 'inbox';
    const where: Prisma.SpecialRequestWhereInput = {
      ...this.scope.storeFilter(user, headerStore),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.status ? { status: query.status } : {}),
    };

    if (scope === 'mine') {
      where.requestedById = user.id;
    } else if (scope === 'inbox') {
      // Everything undecided that this user can actually act on — excluding
      // their own requests, which they are barred from deciding.
      const actable = (Object.keys(ROLE_RANK) as Role[]).filter(
        (r) => ROLE_RANK[user.role] >= ROLE_RANK[r],
      );
      where.status = { in: ['pending', 'escalated'] };
      where.requiredRole = { in: actable };
      where.requestedById = { not: user.id };
    } else if (scope === 'open') {
      where.status = { in: ['pending', 'escalated'] };
    }

    // A salesperson can never approve anything, so their only meaningful view is
    // what they raised themselves.
    if (ROLE_RANK[user.role] < ROLE_RANK.store_manager && scope !== 'mine') {
      where.requestedById = user.id;
      delete where.requiredRole;
    }

    const rows = await this.prisma.specialRequest.findMany({
      where,
      include: { store: { select: { name: true } } },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 200,
    });
    return rows.map((r) => this.toView(r, user));
  }

  /** GET /requests/:id — one request with its thread. */
  async get(user: AuthUser, id: string) {
    const row = await this.prisma.specialRequest.findFirst({
      where: { id, ...this.scope.storeFilter(user) },
      include: {
        store: { select: { name: true } },
        messages: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!row) throw new NotFoundException('Request not found');
    // A salesperson only ever sees their own.
    if (ROLE_RANK[user.role] < ROLE_RANK.store_manager && row.requestedById !== user.id) {
      throw new ForbiddenException('Request not in your scope');
    }
    return {
      ...this.toView(row, user),
      messages: (row.messages ?? []).map((m) => ({
        id: m.id,
        authorId: m.authorId,
        authorName: m.authorName ?? 'Unknown',
        body: m.body,
        createdAt: m.createdAt.toISOString(),
      })),
    };
  }

  private toView(r: any, viewer: AuthUser) {
    const decidable =
      !TERMINAL.includes(r.status) &&
      canDecide(viewer.role, r.requiredRole) &&
      r.requestedById !== viewer.id;
    const overdue =
      r.neededBy != null &&
      !TERMINAL.includes(r.status) &&
      r.neededBy.getTime() < Date.now();

    return {
      id: r.id,
      ref: r.ref,
      storeId: r.storeId,
      storeName: r.store?.name ?? '',
      kind: r.kind,
      kindLabel: REQUEST_KIND_LABELS[r.kind as SpecialRequestKind] ?? r.kind,
      title: r.title,
      details: r.details ?? null,
      amount: num(r.amount),
      priority: r.priority,
      status: r.status,
      neededBy: r.neededBy ? r.neededBy.toISOString().slice(0, 10) : null,
      overdue,
      requestedById: r.requestedById,
      requestedByName: r.requestedByName ?? '',
      requestedRole: r.requestedRole,
      requiredRole: r.requiredRole,
      requiredRoleLabel: ROLE_LABELS[r.requiredRole as Role] ?? r.requiredRole,
      decidedBy: r.decidedByName ?? null,
      decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
      decisionNote: r.decisionNote ?? null,
      diamondSpec: r.diamondSpec ?? null,
      currentRatePerCarat: num(r.currentRatePerCarat),
      requestedRatePerCarat: num(r.requestedRatePerCarat),
      appliedRateId: r.appliedRateId ?? null,
      createdAt: r.createdAt.toISOString(),
      /// Whether THIS viewer may decide it — drives the UI without the client
      /// having to reimplement the ladder.
      canDecide: decidable,
      canEscalate: decidable && roleAbove(r.requiredRole) != null,
      canCancel: r.requestedById === viewer.id && !TERMINAL.includes(r.status),
    };
  }

  // ==========================================================================
  // Decide
  // ==========================================================================

  /**
   * PATCH /requests/:id/decide — approve or reject.
   *
   * Approving a `diamond_rate` request has a side effect: it writes the new rate
   * into `DiamondRate`, which is what every branch then prices against. That
   * write and the status change run in one transaction, so a crash between them
   * cannot leave a rate live against a request still showing as pending.
   */
  async decide(user: AuthUser, id: string, dto: DecideSpecialRequestDto) {
    const row = await this.prisma.specialRequest.findFirst({
      where: { id, ...this.scope.storeFilter(user) },
      include: { store: { select: { name: true } } },
    });
    if (!row) throw new NotFoundException('Request not found');

    assertUndecided(row.status, TERMINAL, 'request');
    assertNotSelfApproval(user, row.requestedById, 'request');

    if (!canDecide(user.role, row.requiredRole)) {
      throw new ForbiddenException(
        `This request needs ${ROLE_LABELS[row.requiredRole]} approval or above`,
      );
    }

    const approving = dto.status === 'approved';
    const decidedAt = new Date();
    let appliedRate: number | null = null;

    const updated = await this.prisma.$transaction(async (tx) => {
      let appliedRateId: string | null = null;

      if (approving && row.kind === SpecialRequestKind.diamond_rate) {
        // The approver may settle at a different number than the one asked for —
        // meeting the branch partway is the usual outcome, not a flat yes/no.
        const rate = dto.approvedRatePerCarat ?? Number(row.requestedRatePerCarat ?? 0);
        if (!row.diamondSpec || !(rate > 0)) {
          throw new BadRequestException(
            'Cannot apply a diamond rate without a spec and a positive rate',
          );
        }
        const created = await tx.diamondRate.create({
          data: {
            spec: row.diamondSpec,
            ratePerCarat: new Prisma.Decimal(rate),
            effectiveFrom: decidedAt,
            // Scoped to the requesting branch. A rate approved for one store's
            // deal must not silently reprice every other branch.
            storeId: row.storeId,
            organisationId: user.organisationId,
          },
        });
        appliedRateId = created.id;
        appliedRate = rate;
      }

      return tx.specialRequest.update({
        where: { id },
        data: {
          status: dto.status as SpecialRequestStatus,
          decidedById: user.id,
          decidedByName: user.name,
          decidedRole: user.role,
          decidedAt,
          decisionNote: dto.note?.trim() || null,
          ...(appliedRateId ? { appliedRateId } : {}),
          ...(appliedRate != null
            ? { requestedRatePerCarat: new Prisma.Decimal(appliedRate) }
            : {}),
        },
        include: { store: { select: { name: true } } },
      });
    });

    // Tell the branch. This is the half that was missing entirely: a request
    // used to be decided with the requester finding out only by re-checking.
    await this.notifications.emit([row.requestedById], {
      kind: row.kind === SpecialRequestKind.diamond_rate ? 'diamond_rate_request' : 'special_request',
      title: `${row.ref} ${approving ? 'approved' : 'rejected'}`,
      body:
        appliedRate != null
          ? `${row.diamondSpec} approved at ₹${appliedRate}/carat by ${user.name}`
          : `${row.title} — ${approving ? 'approved' : 'rejected'} by ${user.name}${
              dto.note?.trim() ? `: ${dto.note.trim()}` : ''
            }`,
      href: `/requests?open=${row.id}`,
      storeId: row.storeId,
      entityType: 'SpecialRequest',
      entityId: row.id,
      priority: approving ? 'normal' : 'high',
      actorId: user.id,
      actorName: user.name,
      dedupeKey: `special_request:${row.id}:decided`,
      metadata: { status: dto.status, appliedRate },
    });

    await this.audit.record(user, {
      action: approving ? 'special_request.approve' : 'special_request.reject',
      entityType: 'SpecialRequest',
      entityId: row.id,
      storeId: row.storeId,
      summary: `${approving ? 'Approved' : 'Rejected'} ${
        REQUEST_KIND_LABELS[row.kind]
      } request ${row.ref}${appliedRate != null ? ` at ₹${appliedRate}/carat` : ''}`,
      metadata: {
        from: row.status,
        to: dto.status,
        note: dto.note ?? null,
        requestedRate: num(row.requestedRatePerCarat),
        appliedRate,
      },
    });

    return this.toView(updated, user);
  }

  /**
   * PATCH /requests/:id/escalate — hand it up a rung.
   *
   * For the approver who CAN decide but shouldn't: a store manager looking at a
   * request that is technically within their authority but that they want area
   * management to own. Without this the only options are approve, reject, or
   * leave it sitting.
   */
  async escalate(user: AuthUser, id: string, dto: EscalateSpecialRequestDto) {
    const row = await this.prisma.specialRequest.findFirst({
      where: { id, ...this.scope.storeFilter(user) },
      include: { store: { select: { name: true } } },
    });
    if (!row) throw new NotFoundException('Request not found');
    assertUndecided(row.status, TERMINAL, 'request');

    if (!canDecide(user.role, row.requiredRole)) {
      throw new ForbiddenException('Only an eligible approver may escalate this request');
    }

    const next = roleAbove(row.requiredRole);
    if (!next) {
      throw new BadRequestException(
        'This request already sits with head office — there is nobody above to escalate to',
      );
    }

    const updated = await this.prisma.specialRequest.update({
      where: { id },
      data: { status: 'escalated', requiredRole: next },
      include: { store: { select: { name: true } } },
    });

    if (dto.note?.trim()) {
      await this.prisma.specialRequestMessage.create({
        data: {
          requestId: id,
          authorId: user.id,
          authorName: user.name,
          body: `Escalated to ${ROLE_LABELS[next]}: ${dto.note.trim()}`,
        },
      });
    }

    await this.notifications.emitToApprovers(
      row.storeId,
      next,
      {
        kind: 'special_request',
        title: `${row.ref} escalated to ${ROLE_LABELS[next]}`,
        body: `${row.title} — escalated by ${user.name}${
          dto.note?.trim() ? `: ${dto.note.trim()}` : ''
        }`,
        href: `/requests?open=${row.id}`,
        storeId: row.storeId,
        entityType: 'SpecialRequest',
        entityId: row.id,
        priority: 'high',
        actorId: user.id,
        actorName: user.name,
        dedupeKey: `special_request:${row.id}:escalated:${next}`,
      },
      user.id,
    );

    await this.audit.record(user, {
      action: 'special_request.escalate',
      entityType: 'SpecialRequest',
      entityId: row.id,
      storeId: row.storeId,
      summary: `Escalated request ${row.ref} to ${ROLE_LABELS[next]}`,
      metadata: { from: row.requiredRole, to: next, note: dto.note ?? null },
    });

    return this.toView(updated, user);
  }

  /** PATCH /requests/:id/cancel — the branch withdraws its own request. */
  async cancel(user: AuthUser, id: string, dto: CancelSpecialRequestDto) {
    const row = await this.prisma.specialRequest.findFirst({
      where: { id, ...this.scope.storeFilter(user) },
    });
    if (!row) throw new NotFoundException('Request not found');
    if (row.requestedById !== user.id) {
      throw new ForbiddenException('Only the person who raised a request may withdraw it');
    }
    assertUndecided(row.status, TERMINAL, 'request');

    const updated = await this.prisma.specialRequest.update({
      where: { id },
      data: {
        status: 'cancelled',
        decidedAt: new Date(),
        decisionNote: dto.reason?.trim() || null,
      },
      include: { store: { select: { name: true } } },
    });

    await this.audit.record(user, {
      action: 'special_request.cancel',
      entityType: 'SpecialRequest',
      entityId: row.id,
      storeId: row.storeId,
      summary: `Withdrew request ${row.ref}`,
      metadata: { reason: dto.reason ?? null },
    });

    return this.toView(updated, user);
  }

  // ==========================================================================
  // Thread
  // ==========================================================================

  /**
   * POST /requests/:id/messages — add to the thread.
   *
   * Lets an approver ask for context without bouncing the request between
   * statuses, and notifies whichever side did not write the message.
   */
  async addMessage(user: AuthUser, id: string, dto: AddRequestMessageDto) {
    const row = await this.prisma.specialRequest.findFirst({
      where: { id, ...this.scope.storeFilter(user) },
      include: { store: { select: { name: true } } },
    });
    if (!row) throw new NotFoundException('Request not found');

    const isRequester = row.requestedById === user.id;
    if (!isRequester && ROLE_RANK[user.role] < ROLE_RANK.store_manager) {
      throw new ForbiddenException('Request not in your scope');
    }

    const message = await this.prisma.specialRequestMessage.create({
      data: {
        requestId: id,
        authorId: user.id,
        authorName: user.name,
        body: dto.body.trim(),
      },
    });

    // Notify the other side: the branch if an approver wrote, the approvers if
    // the branch did. No dedupe key — every message is its own event.
    if (isRequester) {
      await this.notifications.emitToApprovers(
        row.storeId,
        row.requiredRole,
        {
          kind: 'special_request',
          title: `New message on ${row.ref}`,
          body: `${user.name}: ${dto.body.trim().slice(0, 140)}`,
          href: `/requests?open=${row.id}`,
          storeId: row.storeId,
          entityType: 'SpecialRequest',
          entityId: row.id,
          actorId: user.id,
          actorName: user.name,
        },
        user.id,
      );
    } else {
      await this.notifications.emit([row.requestedById], {
        kind: 'special_request',
        title: `New message on ${row.ref}`,
        body: `${user.name}: ${dto.body.trim().slice(0, 140)}`,
        href: `/requests?open=${row.id}`,
        storeId: row.storeId,
        entityType: 'SpecialRequest',
        entityId: row.id,
        actorId: user.id,
        actorName: user.name,
      });
    }

    return {
      id: message.id,
      authorId: message.authorId,
      authorName: message.authorName ?? user.name,
      body: message.body,
      createdAt: message.createdAt.toISOString(),
    };
  }
}
