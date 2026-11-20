import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, StockTransferStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StoreScopeService } from '../common/store-scope.service';
import { AuditService } from '../common/audit.service';
import { SequenceService } from '../common/sequence.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuthUser } from '../common/auth-user';
import { assertNotSelfApproval } from '../common/approval.util';
import { ROLE_LABELS } from '../common/role.util';
import { assertTransition, submitTarget } from './stock-transfer-status';
import {
  pullableStockView,
  pullableStockWhere,
  TRANSFERABLE_STATUSES,
} from './pullable-stock';
import {
  CreateStockTransferDto,
  ListStockTransferDto,
  PullableStockQueryDto,
  ReasonDto,
} from './dto/stock-transfer.dto';

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
 *
 * ## Push and pull are one workflow
 *
 * A PULL — a branch asking another branch for a piece a customer is standing in
 * front of them wanting — is this same record with `initiatedBy =
 * 'destination'`. It is a direction, not a second transfer system, and not a
 * `SpecialRequest`: the thing being asked for is a set of physical pieces that
 * then have to be reserved, dispatched, received and signed for, which is
 * exactly what this workflow already is. The special-request ladder routes
 * UPWARDS by role rank within one branch; a pull is sideways, to a peer manager
 * at a branch the asker cannot even see, and bending the ladder into that shape
 * would change how every other kind of request is routed and read.
 *
 * Direction changes three things and nothing else: which end must be the
 * caller's own store (destination instead of source, at create/submit/cancel),
 * one consent step in front of the ladder (`pending_source` — the holding
 * branch accepts or declines before head office is asked), and the picker that
 * lets the asker see what to ask for (see pullable-stock.ts). Approve,
 * dispatch, receive and acknowledge run byte-for-byte the same for both.
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

  /** Fulfilment stages (dispatch/receive/ack/cancel) are a store_manager's job
   * at a physical branch. head_office has no branch and only approves/rejects;
   * a salesperson may RAISE a transfer (see assertBranchRequester) but never
   * move goods. */
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

  /** Raising a request (create/submit) is open to branch STAFF — the client's
   * ask (9 Oct): a salesperson at the counter must be able to request a piece
   * without waiting for an administrator. head_office still has no branch to
   * raise from. Approval, dispatch and receipt keep their stricter gates. */
  private assertBranchRequester(user: AuthUser): void {
    if (user.role === 'head_office') {
      throw new ForbiddenException(
        'Head office approves/rejects transfers; branch staff raise them',
      );
    }
  }

  /**
   * The branch a pull may be addressed to.
   *
   * Narrower than the source of a push, on purpose. A push may drain the import
   * holding pen or a branch that has closed, because somebody who runs that
   * location is pushing the stock out. A pull has to be ANSWERED by a manager
   * at the branch it names, and the holding pen, an attendance-only office and
   * a closed branch have no such manager — the ask would sit there forever. So
   * it must be a trading branch of the caller's own organisation, and not one
   * of their own: their own stock is already on their own stock list, and a
   * branch cannot ask itself.
   */
  private async assertAskableStore(user: AuthUser, storeId: string) {
    if (user.storeIds.includes(storeId)) {
      throw new BadRequestException(
        'That branch is already yours — move its stock with an ordinary transfer.',
      );
    }
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true, name: true, code: true, isActive: true, isAggregate: true, organisationId: true },
    });
    if (!store) throw new BadRequestException('Branch not found');
    // A pull can NEVER cross organisations: the store must be the caller's own
    // tenant before anything of its stock is read.
    this.scope.assertOrgAllowed(user, store.organisationId);
    if (store.isAggregate) {
      throw new BadRequestException('Choose a single branch to ask, not the all-stores view.');
    }
    if (!store.isActive) {
      throw new BadRequestException(`${store.name} is not active.`);
    }
    await this.scope.assertTradingStore(storeId);
    return store;
  }

  /**
   * The store whose staff raised a transfer — the source on a push, the
   * destination on a pull. Submitting and withdrawing belong to that end;
   * everything else is keyed off the store that physically acts.
   */
  private initiatingStoreId(t: { initiatedBy: string; fromStoreId: string; toStoreId: string }): string {
    return t.initiatedBy === 'destination' ? t.toStoreId : t.fromStoreId;
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
    this.assertBranchRequester(user);
    // Authoritative: the source must be in the caller's scope, never trust the
    // body alone. Deliberately source-initiated: a single-store salesperson can
    // therefore only raise OUTBOUND transfers. Letting destination staff draft
    // a pull from another branch would also need cross-store stock visibility
    // for the piece picker — a separate, explicit decision, not a gate tweak.
    this.scope.assertStoreAllowed(user, dto.fromStoreId);
    // Emptying a branch is exactly what you do when it closes, and draining the
    // holding bucket is the only way its pieces ever reach a real shop, so the
    // SOURCE only has to be a physical location. The destination must be one a
    // customer can buy from.
    await this.scope.assertTradingStore(dto.fromStoreId, 'physical');
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

    const pieces = await this.loadTransferablePieces(dto.stockItemIds, dto.fromStoreId);

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

  /**
   * Every piece must currently live at the source and be available.
   *
   * Shared by the push and the pull so the two can never disagree about what is
   * movable: a pull is raised against pieces the asker read from the picker,
   * which filters on exactly `TRANSFERABLE_STATUSES`, and this is the check
   * that re-reads them at the moment the request is actually made.
   */
  private async loadTransferablePieces(stockItemIds: string[], fromStoreId: string) {
    const pieces = await this.prisma.stockItem.findMany({
      where: { id: { in: stockItemIds } },
      select: { id: true, storeId: true, status: true, sku: true, name: true },
    });
    if (pieces.length !== stockItemIds.length) {
      throw new BadRequestException('One or more stock items do not exist');
    }
    for (const p of pieces) {
      if (p.storeId !== fromStoreId) {
        throw new BadRequestException(
          `Piece ${p.sku ?? p.id} is not at the source store`,
        );
      }
      if (!TRANSFERABLE_STATUSES.includes(p.status)) {
        throw new BadRequestException(
          `Piece ${p.sku ?? p.id} is not available (status ${p.status})`,
        );
      }
    }
    return pieces;
  }

  // ==========================================================================
  // Pull — a branch asks another branch for a piece
  // ==========================================================================

  /**
   * GET /stock-transfers/pullable — one other branch's available pieces.
   *
   * The whole visibility change lives here and in `pullableStockWhere`, which
   * states what is exposed and why. Guarded three ways: the caller must be
   * branch staff (head office already sees every branch and has no branch to
   * pull to), they must actually run a branch themselves (otherwise there is
   * nowhere for the piece to go and no purpose to serve), and the branch they
   * name must be an askable trading branch of their own organisation.
   *
   * Not audited. The picker refetches as somebody types, so a row per keystroke
   * would bury the trail; what is worth recording is the ask, and `createPull`
   * records that.
   */
  async pullableStock(user: AuthUser, query: PullableStockQueryDto) {
    this.assertBranchRequester(user);
    if (user.storeIds.length === 0) {
      throw new ForbiddenException('You have no branch to request stock for');
    }
    const store = await this.assertAskableStore(user, query.fromStoreId);

    const rows = await this.prisma.stockItem.findMany({
      where: pullableStockWhere(user.organisationId, store.id, query.q),
      // `select`, not `include`: the price columns never leave the database at
      // all, rather than being fetched and then dropped by the mapper.
      select: {
        id: true,
        sku: true,
        name: true,
        styleNumber: true,
        category: true,
        metal: true,
        karat: true,
        grossWeight: true,
        status: true,
        storeId: true,
        store: { select: { name: true } },
        product: { select: { name: true, styleNumber: true } },
      },
      orderBy: { sku: 'asc' },
      // A picker, not an export: enough to find the piece you came looking for,
      // and not enough to walk another branch's shelf end to end.
      take: 50,
    });

    return rows.map(pullableStockView);
  }

  /**
   * POST /stock-transfers/pull — raise a DRAFT pull.
   *
   * The mirror of `create`: the end that must be the caller's own branch is the
   * DESTINATION, the counter the customer is standing at. The source is
   * deliberately outside their scope — not being able to see it is the problem
   * this solves — so it is checked as an askable branch of the same
   * organisation instead.
   */
  async createPull(user: AuthUser, dto: CreateStockTransferDto) {
    this.assertBranchRequester(user);
    this.scope.assertStoreAllowed(user, dto.toStoreId);
    await this.scope.assertTradingStore(dto.toStoreId);
    const source = await this.assertAskableStore(user, dto.fromStoreId);

    const pieces = await this.loadTransferablePieces(dto.stockItemIds, source.id);

    // The ref carries the branch that RAISED it, as it does for a push — there
    // that happens to be the source; here it is the asker.
    const asker = await this.prisma.store.findUnique({
      where: { id: dto.toStoreId },
      select: { code: true, name: true },
    });
    const ref = await this.sequence.nextRef('ST', asker?.code ?? 'GLOBAL');

    const transfer = await this.prisma.stockTransfer.create({
      data: {
        organisationId: user.organisationId,
        ref,
        status: 'draft',
        initiatedBy: 'destination',
        fromStoreId: source.id,
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
      action: 'stock_transfer.create_pull',
      entityType: 'StockTransfer',
      entityId: transfer.id,
      // Attributed to the asking branch: it is their request, and the holding
      // branch has not agreed to anything yet.
      storeId: dto.toStoreId,
      summary: `Created pull ${ref} (${pieces.length} pcs) from ${source.name}`,
      metadata: { fromStoreId: source.id, pieces: dto.stockItemIds },
    });

    return this.view(transfer.id);
  }

  /**
   * pending_source → submitted (store_manager at the HOLDING branch).
   *
   * The holding branch agrees to give the pieces up; only then does the request
   * join the ordinary ladder and go to head office. Nothing is reserved here —
   * reservation still happens at HO approval, exactly as for a push, so an
   * accepted pull does not lock a piece the branch may still sell if head
   * office says no.
   */
  async acceptPull(user: AuthUser, id: string) {
    const t = await this.loadPullForSource(user, id);
    assertTransition(t.status, 'submitted');

    const { count } = await this.prisma.stockTransfer.updateMany({
      where: { id, status: 'pending_source' },
      data: { status: 'submitted', sourceDecidedById: user.id, sourceDecidedAt: new Date() },
    });
    if (count === 0) throw new ConflictException('Transfer already moved on');

    await this.audit.record(user, {
      action: 'stock_transfer.accept_pull',
      entityType: 'StockTransfer',
      entityId: id,
      storeId: t.fromStoreId,
      summary: `Accepted pull ${t.ref}; sent for head-office approval`,
    });
    // Head office now sees it exactly as it sees a submitted push.
    await this.notifications
      .emitToApprovers(
        t.fromStoreId,
        'head_office',
        {
          kind: 'special_request',
          title: `Stock transfer ${t.ref} awaiting approval`,
          body: `${t.items.length} piece(s) agreed by the holding branch`,
          href: `/stock-transfers/${id}`,
          storeId: t.fromStoreId,
          entityType: 'StockTransfer',
          entityId: id,
        },
        user.id,
      )
      .catch(() => undefined);
    await this.notifications
      .emit([t.requestedById], {
        kind: 'special_request',
        title: `${t.ref} accepted — awaiting head office`,
        href: `/stock-transfers/${id}`,
        storeId: t.toStoreId,
        entityType: 'StockTransfer',
        entityId: id,
        actorId: user.id,
        actorName: user.name,
      })
      .catch(() => undefined);

    return this.view(id);
  }

  /**
   * pending_source → declined (store_manager at the HOLDING branch).
   *
   * Saying no is a normal answer, not a failure: the piece may be promised to a
   * customer there, or be the only one on the shelf. It costs the same single
   * action as accepting, it is terminal (the asker raises a fresh pull if
   * something changes), and nothing is reserved at this stage so there is no
   * inventory effect to unwind.
   */
  async declinePull(user: AuthUser, id: string, dto: ReasonDto) {
    const t = await this.loadPullForSource(user, id);
    assertTransition(t.status, 'declined');

    const { count } = await this.prisma.stockTransfer.updateMany({
      where: { id, status: 'pending_source' },
      data: {
        status: 'declined',
        reason: dto.reason ?? null,
        sourceDecidedById: user.id,
        sourceDecidedAt: new Date(),
      },
    });
    if (count === 0) throw new ConflictException('Transfer already moved on');

    await this.audit.record(user, {
      action: 'stock_transfer.decline_pull',
      entityType: 'StockTransfer',
      entityId: id,
      storeId: t.fromStoreId,
      summary: `Declined pull ${t.ref}`,
      metadata: { reason: dto.reason ?? null },
    });
    await this.notifications
      .emit([t.requestedById], {
        kind: 'special_request',
        title: `${t.ref} declined by the holding branch`,
        body: dto.reason ?? undefined,
        href: `/stock-transfers/${id}`,
        storeId: t.toStoreId,
        entityType: 'StockTransfer',
        entityId: id,
        priority: 'high',
        actorId: user.id,
        actorName: user.name,
      })
      .catch(() => undefined);

    return this.view(id);
  }

  /**
   * Load a pull for the branch that holds the pieces, and check they may answer
   * it: a manager at that branch, who is not the person who asked.
   *
   * The self-approval check is not theoretical. Five users in production run
   * more than one branch, so the same person can be the staffer at the asking
   * counter and the manager of the branch being asked — which would turn a pull
   * into a way to move stock between your own two branches with nobody else
   * involved.
   */
  private async loadPullForSource(user: AuthUser, id: string) {
    this.assertStoreOperator(user);
    const t = await this.load(user, id);
    if (t.initiatedBy !== 'destination') {
      throw new BadRequestException(
        'Only a pull is answered by the holding branch; this transfer was sent by its source.',
      );
    }
    this.scope.assertStoreAllowed(user, t.fromStoreId);
    assertNotSelfApproval(user, t.requestedById, 'stock request');
    return t;
  }

  // ==========================================================================
  // Transitions
  // ==========================================================================

  /**
   * draft → submitted (push) or draft → pending_source (pull), by the staff of
   * the branch that RAISED it — submitting is part of raising.
   *
   * The one place direction changes where a transfer goes next: a push goes
   * straight to head office, a pull stops at the branch holding the pieces
   * until they agree. See `submitTarget`.
   */
  async submit(user: AuthUser, id: string) {
    this.assertBranchRequester(user);
    const t = await this.load(user, id);
    this.scope.assertStoreAllowed(user, this.initiatingStoreId(t));
    const next = submitTarget(t.initiatedBy);
    assertTransition(t.status, next);

    const { count } = await this.prisma.stockTransfer.updateMany({
      where: { id, status: 'draft' },
      data: { status: next, submittedAt: new Date() },
    });
    if (count === 0) throw new ConflictException('Transfer already moved on');

    const pulling = next === 'pending_source';
    // Named rather than left as "another branch": the manager being asked is
    // deciding whether to give a piece to a specific shop, and the answer
    // depends on which one.
    const asker = pulling
      ? await this.prisma.store.findUnique({
          where: { id: t.toStoreId },
          select: { name: true },
        })
      : null;
    await this.audit.record(user, {
      action: 'stock_transfer.submit',
      entityType: 'StockTransfer',
      entityId: id,
      storeId: this.initiatingStoreId(t),
      summary: pulling
        ? `Sent pull ${t.ref} to the holding branch`
        : `Submitted transfer ${t.ref} for head-office approval`,
    });
    // A pull is answered by the holding branch's manager; a push goes to head
    // office. Both are approvers AT THE SOURCE store, which is where the pieces
    // are and whose managers would have to let them go either way.
    await this.notifications
      .emitToApprovers(
        t.fromStoreId,
        pulling ? 'store_manager' : 'head_office',
        {
          kind: 'special_request',
          title: pulling
            ? `${asker?.name ?? 'Another branch'} is asking for ${t.items.length} piece(s)`
            : `Stock transfer ${t.ref} awaiting approval`,
          body: pulling
            ? `${t.ref} — accept to send it for head-office approval, or decline`
            : `${t.items.length} piece(s) requested for transfer`,
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
            status: { in: TRANSFERABLE_STATUSES },
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
   * draft | pending_source | submitted | ho_approved → cancelled (store_manager
   * at the branch that RAISED it). Only before dispatch — once goods are in
   * transit the transfer must be received. A cancel from ho_approved releases
   * the reservation the approval placed.
   *
   * Withdrawing belongs to whoever asked, which on a pull is the destination:
   * the customer who wanted the piece has left, so the asking branch takes its
   * own request back rather than needing the holding branch to decline it.
   */
  async cancel(user: AuthUser, id: string, dto: ReasonDto) {
    this.assertStoreOperator(user);
    const t = await this.load(user, id);
    this.scope.assertStoreAllowed(user, this.initiatingStoreId(t));
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
      storeId: this.initiatingStoreId(t),
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
      for (const k of [
        'requestedById', 'sourceDecidedById', 'approvedById', 'dispatchedById',
        'receivedById', 'acknowledgedById',
      ]) {
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
      /// `source` = this branch is sending stock away; `destination` = this
      /// branch asked another one for it. The screen reads very differently
      /// either way, so it is told rather than inferred from who requested it.
      initiatedBy: r.initiatedBy,
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
      sourceDecidedBy: actor(r.sourceDecidedById),
      approvedBy: actor(r.approvedById),
      dispatchedBy: actor(r.dispatchedById),
      receivedBy: actor(r.receivedById),
      acknowledgedBy: actor(r.acknowledgedById),
      submittedAt: r.submittedAt,
      sourceDecidedAt: r.sourceDecidedAt,
      approvedAt: r.approvedAt,
      dispatchedAt: r.dispatchedAt,
      receivedAt: r.receivedAt,
      acknowledgedAt: r.acknowledgedAt,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }
}
