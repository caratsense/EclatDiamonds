import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, StockStatus, StockTransferStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StoreScopeService } from '../common/store-scope.service';
import { AuditService } from '../common/audit.service';
import { SequenceService } from '../common/sequence.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuthUser } from '../common/auth-user';
import { ROLE_LABELS } from '../common/role.util';
import { assertTransition } from './stock-transfer-status';
import {
  CreateStockTransferDto,
  ListStockTransferDto,
  ReasonDto,
} from './dto/stock-transfer.dto';

/** Statuses from which a piece may be pulled into a transfer / reserved. */
const AVAILABLE: StockStatus[] = ['in_stock', 'aging', 'dead_stock'];

/**
 * Module 9 — inter-store Stock Transfer workflow.
 *
 * State machine (see stock-transfer-status.ts): draft → submitted → ho_approved
 * → dispatched → received → acknowledged, with reject/cancel off-ramps.
 *
 * ## Non-negotiable invariants
 *  - **Backend is authoritative for store.** The DTO's `fromStoreId` is a hint;
 *    every stage re-checks the caller against the source/destination store via
 *    StoreScopeService. A store manager can never act on a store outside scope.
 *  - **Inventory changes exactly once, at receive.** Approval only *reserves*
 *    (a lock, not a location change); dispatch is a paperwork step; receive is
 *    the single point that re-homes each piece and writes a StockMovement.
 *  - **Every transition is a compare-and-set.** Status moves via
 *    `updateMany({ where: { id, status: <expected> } })`; a 0-row result means a
 *    concurrent actor already moved it, so the action 409s instead of double
 *    applying. This is what makes every endpoint idempotent under retry.
 *  - **Piece re-homing is atomic.** Reservation (approve) and re-homing (receive)
 *    run inside `$transaction` alongside the status CAS, so a piece that has been
 *    sold/melted/already-moved out from under the transfer aborts the whole
 *    stage rather than leaving a half-applied move.
 */
@Injectable()
export class StockTransfersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly audit: AuditService,
    private readonly sequence: SequenceService,
    private readonly notifications: NotificationsService,
  ) {}

  // ==========================================================================
  // Guards
  // ==========================================================================

  /** Store-floor operations (create/submit/dispatch/receive/ack/cancel) are a
   * store_manager's job at a physical branch. head_office has no branch and only
   * approves/rejects; a salesperson has no transfer rights at all. */
  private assertStoreOperator(user: AuthUser): void {
    if (user.role === 'head_office') {
      throw new ForbiddenException(
        'Head office approves/rejects transfers; branch operations are the store manager’s',
      );
    }
    if (user.role === 'salesperson') {
      throw new ForbiddenException('Salespeople cannot operate stock transfers');
    }
  }

  private async load(user: AuthUser, id: string) {
    const t = await this.prisma.stockTransfer.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!t) throw new NotFoundException('Transfer not found');
    // Tenant boundary for EVERY transition (incl. HO approve/reject, which reserve
    // inventory). storeId re-checks below cover branch operators; this covers HO,
    // whose scope is org-wide but must still not cross organisations.
    this.scope.assertOrgAllowed(user, t.organisationId);
    return t;
  }

  // ==========================================================================
  // Create (draft)
  // ==========================================================================

  async create(user: AuthUser, dto: CreateStockTransferDto) {
    this.assertStoreOperator(user);
    // Authoritative: the source must be in the caller's scope, never trust the body alone.
    this.scope.assertStoreAllowed(user, dto.fromStoreId);
    await this.scope.assertTradingStore(dto.fromStoreId);
    await this.scope.assertTradingStore(dto.toStoreId);

    if (dto.fromStoreId === dto.toStoreId) {
      throw new BadRequestException('Source and destination must differ');
    }

    const dest = await this.prisma.store.findUnique({
      where: { id: dto.toStoreId },
      select: { id: true, isActive: true, organisationId: true },
    });
    if (!dest) throw new BadRequestException('Destination store not found');
    // A transfer can NEVER cross organisations. The source is already in the
    // caller's (org-bounded) scope; the destination must be the same organisation.
    this.scope.assertOrgAllowed(user, dest.organisationId);
    if (!dest.isActive) {
      throw new BadRequestException('Destination store is not active');
    }

    // Every piece must currently live at the source and be available.
    const pieces = await this.prisma.stockItem.findMany({
      where: { id: { in: dto.stockItemIds } },
      select: { id: true, storeId: true, status: true, sku: true, name: true },
    });
    if (pieces.length !== dto.stockItemIds.length) {
      throw new BadRequestException('One or more stock items do not exist');
    }
    for (const p of pieces) {
      if (p.storeId !== dto.fromStoreId) {
        throw new BadRequestException(
          `Piece ${p.sku ?? p.id} is not at the source store`,
        );
      }
      if (!AVAILABLE.includes(p.status)) {
        throw new BadRequestException(
          `Piece ${p.sku ?? p.id} is not available (status ${p.status})`,
        );
      }
    }

    const store = await this.prisma.store.findUnique({
      where: { id: dto.fromStoreId },
      select: { code: true },
    });
    const ref = await this.sequence.nextRef('ST', store?.code ?? 'GLOBAL');

    const transfer = await this.prisma.stockTransfer.create({
      data: {
        organisationId: user.organisationId,
        ref,
        status: 'draft',
        fromStoreId: dto.fromStoreId,
        toStoreId: dto.toStoreId,
        reason: dto.note ?? null,
        requestedById: user.id,
        items: {
          create: pieces.map((p) => ({
            stockItemId: p.id,
            sku: p.sku,
            name: p.name,
          })),
        },
      },
      include: { items: true },
    });

    await this.audit.record(user, {
      action: 'stock_transfer.create',
      entityType: 'StockTransfer',
      entityId: transfer.id,
      storeId: dto.fromStoreId,
      summary: `Created transfer ${ref} (${pieces.length} pcs) to store ${dto.toStoreId}`,
      metadata: { toStoreId: dto.toStoreId, pieces: dto.stockItemIds },
    });

    return this.view(transfer.id);
  }

  // ==========================================================================
  // Transitions
  // ==========================================================================

  /** draft → submitted (source store_manager). */
  async submit(user: AuthUser, id: string) {
    this.assertStoreOperator(user);
    const t = await this.load(user, id);
    this.scope.assertStoreAllowed(user, t.fromStoreId);
    assertTransition(t.status, 'submitted');

    const { count } = await this.prisma.stockTransfer.updateMany({
      where: { id, status: 'draft' },
      data: { status: 'submitted', submittedAt: new Date() },
    });
    if (count === 0) throw new ConflictException('Transfer already moved on');

    await this.audit.record(user, {
      action: 'stock_transfer.submit',
      entityType: 'StockTransfer',
      entityId: id,
      storeId: t.fromStoreId,
      summary: `Submitted transfer ${t.ref} for head-office approval`,
    });
    await this.notifications
      .emitToApprovers(
        t.fromStoreId,
        'head_office',
        {
          kind: 'special_request',
          title: `Stock transfer ${t.ref} awaiting approval`,
          body: `${t.items.length} piece(s) requested for transfer`,
          href: `/stock-transfers/${id}`,
          storeId: t.fromStoreId,
          entityType: 'StockTransfer',
          entityId: id,
        },
        user.id,
      )
      .catch(() => undefined);

    return this.view(id);
  }

  /**
   * submitted → ho_approved (head_office). Reserves every piece in one
   * transaction: the piece CAS (available → reserved) is what stops the SAME
   * piece being approved onto two transfers — the second approval finds nothing
   * available and the whole stage rolls back.
   */
  async approve(user: AuthUser, id: string) {
    if (user.role !== 'head_office') {
      throw new ForbiddenException('Only head office approves transfers');
    }
    const t = await this.load(user, id);
    assertTransition(t.status, 'ho_approved');

    await this.prisma.$transaction(async (tx) => {
      const moved = await tx.stockTransfer.updateMany({
        where: { id, status: 'submitted' },
        data: { status: 'ho_approved', approvedById: user.id, approvedAt: new Date() },
      });
      if (moved.count === 0) throw new ConflictException('Transfer already moved on');

      for (const item of t.items) {
        const res = await tx.stockItem.updateMany({
          where: {
            id: item.stockItemId,
            storeId: t.fromStoreId,
            status: { in: AVAILABLE },
          },
          data: { status: 'reserved' },
        });
        if (res.count !== 1) {
          throw new ConflictException(
            `Piece ${item.sku ?? item.stockItemId} is no longer available to reserve`,
          );
        }
      }
    });

    await this.audit.record(user, {
      action: 'stock_transfer.approve',
      entityType: 'StockTransfer',
      entityId: id,
      storeId: t.fromStoreId,
      summary: `Approved transfer ${t.ref}; ${t.items.length} piece(s) reserved`,
    });
    await this.notifications
      .emitToApprovers(
        t.fromStoreId,
        'store_manager',
        {
          kind: 'special_request',
          title: `Transfer ${t.ref} approved — ready to dispatch`,
          href: `/stock-transfers/${id}`,
          storeId: t.fromStoreId,
          entityType: 'StockTransfer',
          entityId: id,
        },
        user.id,
      )
      .catch(() => undefined);

    return this.view(id);
  }

  /** submitted → rejected (head_office). Nothing is reserved yet, so this only
   * closes the request. */
  async reject(user: AuthUser, id: string, dto: ReasonDto) {
    if (user.role !== 'head_office') {
      throw new ForbiddenException('Only head office rejects transfers');
    }
    const t = await this.load(user, id);
    assertTransition(t.status, 'rejected');

    const { count } = await this.prisma.stockTransfer.updateMany({
      where: { id, status: 'submitted' },
      data: { status: 'rejected', reason: dto.reason ?? null, approvedById: user.id, approvedAt: new Date() },
    });
    if (count === 0) throw new ConflictException('Transfer already moved on');

    await this.audit.record(user, {
      action: 'stock_transfer.reject',
      entityType: 'StockTransfer',
      entityId: id,
      storeId: t.fromStoreId,
      summary: `Rejected transfer ${t.ref}`,
      metadata: { reason: dto.reason ?? null },
    });
    await this.notifications
      .emitToApprovers(
        t.fromStoreId,
        'store_manager',
        {
          kind: 'special_request',
          title: `Transfer ${t.ref} rejected`,
          body: dto.reason ?? undefined,
          href: `/stock-transfers/${id}`,
          storeId: t.fromStoreId,
          entityType: 'StockTransfer',
          entityId: id,
        },
        user.id,
      )
      .catch(() => undefined);

    return this.view(id);
  }

  /** ho_approved → dispatched (source store_manager). Paperwork only: pieces
   * stay reserved and stay at the source in the ledger until received. */
  async dispatch(user: AuthUser, id: string) {
    this.assertStoreOperator(user);
    const t = await this.load(user, id);
    this.scope.assertStoreAllowed(user, t.fromStoreId);
    assertTransition(t.status, 'dispatched');

    const { count } = await this.prisma.stockTransfer.updateMany({
      where: { id, status: 'ho_approved' },
      data: { status: 'dispatched', dispatchedById: user.id, dispatchedAt: new Date() },
    });
    if (count === 0) throw new ConflictException('Transfer already moved on');

    await this.audit.record(user, {
      action: 'stock_transfer.dispatch',
      entityType: 'StockTransfer',
      entityId: id,
      storeId: t.fromStoreId,
      summary: `Dispatched transfer ${t.ref} to store ${t.toStoreId}`,
    });
    await this.notifications
      .emitToApprovers(
        t.toStoreId,
        'store_manager',
        {
          kind: 'special_request',
          title: `Incoming transfer ${t.ref} dispatched`,
          body: `${t.items.length} piece(s) in transit — receive on arrival`,
          href: `/stock-transfers/${id}`,
          storeId: t.toStoreId,
          entityType: 'StockTransfer',
          entityId: id,
        },
        user.id,
      )
      .catch(() => undefined);

    return this.view(id);
  }

  /**
   * dispatched → received (destination store_manager). THE ONLY inventory
   * mutation in the whole workflow: each reserved piece is re-homed to the
   * destination (storeId → toStore, status → in_stock) and a StockMovement is
   * appended — all inside one transaction with the status CAS, so a retry or a
   * piece that vanished mid-transit aborts cleanly rather than half-applying.
   */
  async receive(user: AuthUser, id: string) {
    this.assertStoreOperator(user);
    const t = await this.load(user, id);
    this.scope.assertStoreAllowed(user, t.toStoreId);
    assertTransition(t.status, 'received');

    await this.prisma.$transaction(async (tx) => {
      const moved = await tx.stockTransfer.updateMany({
        where: { id, status: 'dispatched' },
        data: { status: 'received', receivedById: user.id, receivedAt: new Date() },
      });
      if (moved.count === 0) throw new ConflictException('Transfer already received');

      for (const item of t.items) {
        const res = await tx.stockItem.updateMany({
          where: {
            id: item.stockItemId,
            storeId: t.fromStoreId,
            status: 'reserved',
          },
          data: { storeId: t.toStoreId, status: 'in_stock' },
        });
        if (res.count !== 1) {
          throw new ConflictException(
            `Piece ${item.sku ?? item.stockItemId} was not in the expected reserved state`,
          );
        }
        await tx.stockMovement.create({
          data: {
            organisationId: user.organisationId,
            stockItemId: item.stockItemId,
            fromStoreId: t.fromStoreId,
            toStoreId: t.toStoreId,
            status: 'in_stock',
            note: `Transfer ${t.ref}`,
            stockTransferId: id,
          },
        });
      }
    });

    await this.audit.record(user, {
      action: 'stock_transfer.receive',
      entityType: 'StockTransfer',
      entityId: id,
      storeId: t.toStoreId,
      summary: `Received transfer ${t.ref}; ${t.items.length} piece(s) re-homed to store ${t.toStoreId}`,
    });

    return this.view(id);
  }

  /** received → acknowledged (destination store_manager). No inventory effect —
   * a final sign-off that the physical count matched. Terminal. */
  async acknowledge(user: AuthUser, id: string) {
    this.assertStoreOperator(user);
    const t = await this.load(user, id);
    this.scope.assertStoreAllowed(user, t.toStoreId);
    assertTransition(t.status, 'acknowledged');

    const { count } = await this.prisma.stockTransfer.updateMany({
      where: { id, status: 'received' },
      data: { status: 'acknowledged', acknowledgedById: user.id, acknowledgedAt: new Date() },
    });
    if (count === 0) throw new ConflictException('Transfer already moved on');

    await this.audit.record(user, {
      action: 'stock_transfer.acknowledge',
      entityType: 'StockTransfer',
      entityId: id,
      storeId: t.toStoreId,
      summary: `Acknowledged transfer ${t.ref}`,
    });

    return this.view(id);
  }

  /**
   * draft | submitted | ho_approved → cancelled (source store_manager). Only
   * before dispatch — once goods are in transit the transfer must be received.
   * A cancel from ho_approved releases the reservation the approval placed.
   */
  async cancel(user: AuthUser, id: string, dto: ReasonDto) {
    this.assertStoreOperator(user);
    const t = await this.load(user, id);
    this.scope.assertStoreAllowed(user, t.fromStoreId);
    assertTransition(t.status, 'cancelled');

    const from = t.status;
    await this.prisma.$transaction(async (tx) => {
      const moved = await tx.stockTransfer.updateMany({
        where: { id, status: from },
        data: { status: 'cancelled', reason: dto.reason ?? null },
      });
      if (moved.count === 0) throw new ConflictException('Transfer already moved on');

      // Reservation only exists once approved; release it on cancel.
      if (from === 'ho_approved') {
        for (const item of t.items) {
          await tx.stockItem.updateMany({
            where: { id: item.stockItemId, storeId: t.fromStoreId, status: 'reserved' },
            data: { status: 'in_stock' },
          });
        }
      }
    });

    await this.audit.record(user, {
      action: 'stock_transfer.cancel',
      entityType: 'StockTransfer',
      entityId: id,
      storeId: t.fromStoreId,
      summary: `Cancelled transfer ${t.ref}`,
      metadata: { from, reason: dto.reason ?? null },
    });

    return this.view(id);
  }

  // ==========================================================================
  // Reads
  // ==========================================================================

  async list(user: AuthUser, headerStore: string | undefined, query: ListStockTransferDto) {
    const ids = this.scope.effectiveStoreIds(user, headerStore);
    const direction = query.direction ?? 'all';

    let storeWhere: Prisma.StockTransferWhereInput;
    if (user.allStores && (!headerStore || headerStore === 'all')) {
      // HO sees every transfer IN THEIR ORGANISATION — never a global {} that would
      // list another tenant's transfers.
      storeWhere = { organisationId: user.organisationId };
    } else if (direction === 'in') {
      storeWhere = { toStoreId: { in: ids } };
    } else if (direction === 'out') {
      storeWhere = { fromStoreId: { in: ids } };
    } else {
      storeWhere = { OR: [{ fromStoreId: { in: ids } }, { toStoreId: { in: ids } }] };
    }

    const rows = await this.prisma.stockTransfer.findMany({
      where: { ...storeWhere, ...(query.status ? { status: query.status } : {}) },
      include: { items: true, fromStore: { select: { name: true } }, toStore: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return this.decorate(rows);
  }

  async detail(user: AuthUser, id: string) {
    const t = await this.prisma.stockTransfer.findUnique({
      where: { id },
      include: {
        items: { include: { stockItem: { select: { status: true, storeId: true } } } },
        fromStore: { select: { name: true } },
        toStore: { select: { name: true } },
      },
    });
    if (!t) throw new NotFoundException('Transfer not found');
    // Tenant boundary first: even org-wide HO must not read another org's transfer.
    this.scope.assertOrgAllowed(user, t.organisationId);
    // Visible to HO, or to a store_manager on either side of the transfer.
    if (!user.allStores) {
      const onSource = user.storeIds.includes(t.fromStoreId);
      const onDest = user.storeIds.includes(t.toStoreId);
      if (!onSource && !onDest) throw new ForbiddenException('Transfer not in your scope');
    }
    const [decorated] = await this.decorate([t]);
    return decorated;
  }

  /** Re-fetch + decorate a single transfer for a mutation response. */
  private async view(id: string) {
    const t = await this.prisma.stockTransfer.findUnique({
      where: { id },
      include: {
        items: { include: { stockItem: { select: { status: true, storeId: true } } } },
        fromStore: { select: { name: true } },
        toStore: { select: { name: true } },
      },
    });
    const [decorated] = await this.decorate([t!]);
    return decorated;
  }

  /** Attach actor names/roles (batched) to a set of transfers. */
  private async decorate(rows: any[]) {
    const userIds = new Set<string>();
    for (const r of rows) {
      for (const k of ['requestedById', 'approvedById', 'dispatchedById', 'receivedById', 'acknowledgedById']) {
        if (r[k]) userIds.add(r[k]);
      }
    }
    const users = userIds.size
      ? await this.prisma.user.findMany({
          where: { id: { in: [...userIds] } },
          select: { id: true, name: true, role: true },
        })
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    const actor = (uid?: string | null) => {
      if (!uid) return null;
      const u = byId.get(uid);
      return u ? { id: u.id, name: u.name, role: u.role, roleLabel: ROLE_LABELS[u.role] } : { id: uid };
    };

    return rows.map((r) => ({
      id: r.id,
      ref: r.ref,
      status: r.status,
      reason: r.reason,
      fromStoreId: r.fromStoreId,
      fromStoreName: r.fromStore?.name,
      toStoreId: r.toStoreId,
      toStoreName: r.toStore?.name,
      itemCount: r.items?.length ?? 0,
      items: (r.items ?? []).map((it: any) => ({
        stockItemId: it.stockItemId,
        sku: it.sku,
        name: it.name,
        currentStatus: it.stockItem?.status ?? null,
        currentStoreId: it.stockItem?.storeId ?? null,
      })),
      requestedBy: actor(r.requestedById),
      approvedBy: actor(r.approvedById),
      dispatchedBy: actor(r.dispatchedById),
      receivedBy: actor(r.receivedById),
      acknowledgedBy: actor(r.acknowledgedById),
      submittedAt: r.submittedAt,
      approvedAt: r.approvedAt,
      dispatchedAt: r.dispatchedAt,
      receivedAt: r.receivedAt,
      acknowledgedAt: r.acknowledgedAt,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }
}
