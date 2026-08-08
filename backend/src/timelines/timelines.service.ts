import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { OrderKind, OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { AuditService } from '../common/audit.service';
import { SequenceService } from '../common/sequence.service';
import { StorageService } from '../storage/storage.service';
import {
  assertStageRoleAllowed,
  assertTransitionAllowed,
  nextStages,
  STAGE_INDEX,
  STAGE_LABELS,
  STAGE_SLA_DAYS,
  TERMINAL_STAGES,
} from './order-stages';
import {
  AdvanceStageDto,
  CreateOrderDto,
  CreateWorkflowDto,
  OrdersQueryDto,
} from './dto/timelines.dto';

function num(v: Prisma.Decimal | number | null | undefined): number {
  return v == null ? 0 : Number(v);
}

const DAY_MS = 86_400_000;

/** Whole days elapsed since an instant (0 when it is in the future or unknown). */
function daysSince(from: Date | null | undefined): number | null {
  if (!from) return null;
  return Math.max(0, Math.floor((Date.now() - from.getTime()) / DAY_MS));
}

@Injectable()
export class TimelinesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly sequence: SequenceService,
  ) {}

  /**
   * GET /timelines/orders — custom + stock orders with current production stage,
   * store-scoped. `scope` defaults to 'ongoing' (excludes delivered + cancelled);
   * `kind` filters custom vs stock ('all' = both, default).
   */
  async orders(user: AuthUser, query: OrdersQueryDto = {}, headerStore?: string) {
    const where: Prisma.CustomOrderWhereInput = {
      ...this.scope.storeFilter(user, headerStore),
    };

    const scope = query.scope ?? 'ongoing';
    if (scope === 'ongoing') {
      where.stage = { notIn: [...TERMINAL_STAGES] };
    }

    const kind = query.kind ?? 'all';
    if (kind !== 'all') {
      where.kind = kind as OrderKind;
    }

    const rows = await this.prisma.customOrder.findMany({
      where,
      include: { store: true },
      orderBy: { bookedOn: 'desc' },
    });

    // Orders imported from the shop system land in ManufacturingOrder, while
    // this page has only ever read CustomOrder — so 190 real orders and their
    // 2,310 items were sitting in the database with nothing anywhere able to
    // show them. They are the same thing to a user ("an order being made"), so
    // they are mapped into the same shape and listed together rather than given
    // a second page that says the same words.
    //
    // Adapted rather than migrated: CustomOrder carries booking detail a legacy
    // order simply does not have (ring size, advance receipt, owner role), and
    // inventing empty columns for it would be worse than mapping what exists.
    const legacy = await this.prisma.manufacturingOrder.findMany({
      where: {
        ...this.scope.storeFilter(user, headerStore),
        ...(scope === 'ongoing' ? { status: { notIn: [...TERMINAL_STAGES] } } : {}),
      },
      include: { store: true, party: true, _count: { select: { items: true } } },
      orderBy: { orderDate: 'desc' },
    });

    const adapted = legacy.map((o) => ({
      ...this.toView({
        id: o.id,
        ref: o.orderNo,
        customerName: o.party?.name ?? 'Walk-in',
        // The order header carries no description; the piece count is the one
        // honest thing we can say about what is being made.
        item: `${o._count.items} item${o._count.items === 1 ? '' : 's'}`,
        kind: 'custom',
        category: null,
        qty: o._count.items,
        details: o.poNo ? `PO ${o.poNo}` : null,
        value: o.amount,
        advanceReceived: null,
        stage: o.status,
        bookedOn: o.orderDate,
        eta: o.expectedDelivery,
        createdAt: o.createdAt,
        store: o.store,
        storeId: o.storeId,
        ownerRole: 'salesperson',
        ownerName: null,
      }),
      // Flagged so the UI can tell a synced order from one booked in Eclat: a
      // legacy order has no stage history to open, and offering one would
      // promise a timeline this data cannot support.
      fromLegacy: true,
    }));

    return [...rows.map((o) => this.toView(o)), ...adapted].sort(
      (a, b) => +new Date(b.bookedOn) - +new Date(a.bookedOn),
    );
  }

  /** GET /timelines/orders/:id — one custom order plus its full event history. */
  async order(user: AuthUser, id: string) {
    const o = await this.prisma.customOrder.findFirst({
      where: { id, ...this.scope.storeFilter(user) },
      include: { store: true, events: { orderBy: { occurredAt: 'asc' } } },
    });
    if (!o) throw new NotFoundException('Custom order not found');

    // Time actually spent in each stage, derived from consecutive events. This is
    // what makes a bottleneck visible: "polishing took 9 days" rather than just
    // "the order is late".
    const events = o.events.map((e, i, all) => {
      const nextAt = all[i + 1]?.occurredAt ?? null;
      const endedAt = nextAt ?? new Date();
      return {
        id: e.id,
        stage: e.stage,
        stageLabel: STAGE_LABELS[e.stage],
        stageIndex: STAGE_INDEX[e.stage],
        note: e.note ?? '',
        byRole: e.byRole,
        byName: e.byName ?? '',
        at: e.occurredAt.toISOString(),
        durationDays: Math.max(
          0,
          Math.round(((endedAt.getTime() - e.occurredAt.getTime()) / DAY_MS) * 10) / 10,
        ),
        isCurrent: nextAt == null,
      };
    });

    return {
      ...this.toView(o),
      events,
      /// Exactly where this order may go next — the UI should offer these and
      /// nothing else, mirroring what the API will accept.
      allowedNextStages: nextStages(o.stage).map((s) => ({
        stage: s,
        label: STAGE_LABELS[s],
      })),
    };
  }

  /**
   * PATCH /timelines/orders/:id/stage — move an order through production.
   *
   * Every move is now validated against the state machine in `order-stages.ts`:
   * an order can only reach a stage that legitimately follows the one it is in,
   * delivery and cancellation carry their own minimum roles, and cancelling
   * requires a written reason. The stage clock (`stageEnteredAt`) is reset on
   * every move so time-in-stage and SLA breaches are measurable.
   */
  async advanceStage(user: AuthUser, id: string, dto: AdvanceStageDto) {
    const o = await this.prisma.customOrder.findUnique({ where: { id } });
    if (!o) throw new NotFoundException('Custom order not found');
    // Branch scope: a store manager only ever touches their own store's orders.
    // Role authority is enforced by the route guard (store_manager+) plus the
    // per-stage floors in assertStageRoleAllowed below.
    this.scope.assertStoreAllowed(user, o.storeId);

    const from = o.stage;
    const to = dto.stage;

    assertTransitionAllowed(from, to);
    assertStageRoleAllowed(user.role, to);

    // Cancelling writes off a booked order — and, where an advance was taken,
    // implies a refund. It must say why.
    if (to === OrderStatus.cancelled && !dto.note?.trim()) {
      throw new BadRequestException('A reason is required to cancel an order');
    }
    // Handover is a physical event: record who took the piece.
    if (to === OrderStatus.delivered && !dto.deliveredTo?.trim()) {
      throw new BadRequestException(
        'Record who collected the piece to mark this order delivered',
      );
    }

    const now = new Date();
    const balanceDue = Math.max(0, num(o.value) - num(o.advanceReceived));

    const updated = await this.prisma.customOrder.update({
      where: { id },
      data: {
        stage: to,
        stageEnteredAt: now,
        ...(to === OrderStatus.cancelled
          ? { cancelReason: dto.note!.trim(), cancelledAt: now }
          : {}),
        ...(to === OrderStatus.delivered
          ? { deliveredTo: dto.deliveredTo!.trim(), deliveredAt: now }
          : {}),
        events: {
          create: {
            stage: to,
            note: dto.note?.trim() || null,
            // Production moves are driven from the back office; handover and
            // cancellation are recorded against the person who performed them.
            byRole: to === OrderStatus.delivered ? 'salesperson' : 'back_office',
            byName: user.name,
          },
        },
      },
      include: { store: true },
    });

    await this.audit.record(user, {
      action:
        to === OrderStatus.cancelled
          ? 'order.cancel'
          : to === OrderStatus.delivered
            ? 'order.deliver'
            : 'order.stage_change',
      entityType: 'CustomOrder',
      entityId: id,
      storeId: o.storeId,
      summary:
        to === OrderStatus.cancelled
          ? `Cancelled order ${o.ref}: ${dto.note!.trim()}`
          : to === OrderStatus.delivered
            ? `Delivered order ${o.ref} to ${dto.deliveredTo!.trim()}${
                balanceDue > 0 ? ` (balance due ₹${balanceDue})` : ''
              }`
            : `Advanced order ${o.ref}: ${STAGE_LABELS[from]} → ${STAGE_LABELS[to]}`,
      metadata: {
        from,
        to,
        note: dto.note ?? null,
        deliveredTo: dto.deliveredTo ?? null,
        // Delivering with money still outstanding is legitimate in jewellery
        // retail, but it should be visible in the trail rather than inferred.
        balanceDue: to === OrderStatus.delivered ? balanceDue : undefined,
      },
    });

    // Return the same detail view as GET /timelines/orders/:id.
    return this.order(user, updated.id);
  }

  /**
   * POST /timelines/workflows — open a new custom-order workflow at the earliest
   * stage, owned by the salesperson role.
   */
  async createWorkflow(user: AuthUser, dto: CreateWorkflowDto) {
    this.scope.assertStoreAllowed(user, dto.storeId);
    const now = new Date();

    const order = await this.prisma.customOrder.create({
      data: {
        ref: await this.mintRef('CO', dto.storeId),
        storeId: dto.storeId,
        customerName: dto.customer,
        item: dto.item,
        stage: OrderStatus.booked,
        stageEnteredAt: now,
        ownerRole: 'salesperson',
        ownerName: user.name,
        bookedOn: now,
        events: {
          create: { stage: OrderStatus.booked, byRole: 'salesperson', byName: user.name },
        },
      },
      include: { store: true },
    });
    return this.toView(order);
  }

  /**
   * POST /timelines/orders — Module 2 order booking. Books either a customer
   * custom order (`kind: 'custom'`, ref `CO-…`) or a stock/replenishment order
   * (`kind: 'stock'`, ref `SO-…`, 21-day default timeline).
   */
  async createOrder(user: AuthUser, dto: CreateOrderDto) {
    this.scope.assertStoreAllowed(user, dto.storeId);

    const kind: OrderKind = dto.kind ?? OrderKind.custom;
    const prefix = kind === OrderKind.stock ? 'SO' : 'CO';
    const item = dto.item ?? dto.category ?? 'Custom piece';

    const bookedOn = dto.bookedOn ? new Date(dto.bookedOn) : new Date();
    let eta: Date | null = dto.eta ? new Date(dto.eta) : null;
    // Stock orders get a fixed 21-day back-office timeline when no ETA is given.
    if (kind === OrderKind.stock && !eta) {
      eta = new Date(bookedOn);
      eta.setDate(eta.getDate() + 21);
    }

    // An advance cannot exceed the quoted value — that is a data-entry slip, and
    // left unchecked it silently produces a negative balance on the order.
    const estimation = dto.estimation ?? null;
    const advance = dto.advanceReceived ?? null;
    if (estimation != null && advance != null && advance > estimation) {
      throw new BadRequestException(
        `Advance (₹${advance}) cannot exceed the estimated value (₹${estimation})`,
      );
    }

    const order = await this.prisma.customOrder.create({
      data: {
        ref: await this.mintRef(prefix, dto.storeId),
        storeId: dto.storeId,
        customerName: dto.customerName,
        kind,
        category: dto.category ?? null,
        qty: dto.qty ?? 1,
        details: dto.details ?? null,
        item,
        value: estimation,
        advanceReceived: advance,
        ringSize: dto.ringSize ?? null,
        bangleSize: dto.bangleSize ?? null,
        metalColor: dto.metalColor ?? null,
        advanceMode: dto.advanceMode ?? null,
        deliveryDate: dto.deliveryDate ? new Date(dto.deliveryDate) : null,
        stage: OrderStatus.booked,
        stageEnteredAt: bookedOn,
        ownerRole: 'salesperson',
        ownerName: user.name,
        bookedOn,
        eta,
        events: {
          create: {
            stage: OrderStatus.booked,
            byRole: 'salesperson',
            byName: user.name,
          },
        },
      },
      include: { store: true },
    });

    await this.audit.record(user, {
      action: 'order.book',
      entityType: 'CustomOrder',
      entityId: order.id,
      storeId: order.storeId,
      summary: `Booked ${kind} order ${order.ref} for ${order.customerName}`,
      metadata: { kind, estimation, advance, eta: eta?.toISOString() ?? null },
    });

    return this.toView(order);
  }

  /**
   * A human-readable, per-store, per-month order reference —
   * e.g. `CO-BAN-2607-0042`.
   *
   * Replaces `CO-${Date.now()}`, which produced a 13-digit epoch that means
   * nothing to a customer on a receipt, sorts by nothing useful, is identical
   * across every branch, and collides outright when two orders are booked inside
   * the same millisecond.
   */
  private async mintRef(prefix: string, storeId: string): Promise<string> {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { code: true },
    });
    const now = new Date();
    const period = `${String(now.getUTCFullYear()).slice(2)}${String(
      now.getUTCMonth() + 1,
    ).padStart(2, '0')}`;
    const branch = (store?.code ?? storeId.slice(-4)).toUpperCase().replace(/[^A-Z0-9]/g, '');
    return this.sequence.nextRef(prefix, `${branch}-${period}`);
  }

  /**
   * POST /timelines/orders/:id/image — attach a reference image to an order.
   */
  async setOrderImage(
    user: AuthUser,
    id: string,
    file?: { buffer?: Buffer; originalname?: string; mimetype?: string },
  ) {
    const o = await this.assertImageTarget(user, id, file);
    const imageUrl = await this.storage.save('orders', `${id}.${this.extOf(file!)}`, file!.buffer!);
    const updated = await this.prisma.customOrder.update({
      where: { id: o.id },
      data: { imageUrl },
      include: { store: true },
    });
    return this.toView(updated);
  }

  /**
   * POST /timelines/orders/:id/receipt — attach the advance-payment receipt photo
   * (separate from imageUrl, which is the design reference).
   */
  async setOrderReceipt(
    user: AuthUser,
    id: string,
    file?: { buffer?: Buffer; originalname?: string; mimetype?: string },
  ) {
    const o = await this.assertImageTarget(user, id, file);
    const advanceReceiptUrl = await this.storage.save(
      'orders',
      `${id}-receipt.${this.extOf(file!)}`,
      file!.buffer!,
    );
    const updated = await this.prisma.customOrder.update({
      where: { id: o.id },
      data: { advanceReceiptUrl },
      include: { store: true },
    });
    return this.toView(updated);
  }

  /** Shared validation for both image uploads: real image, real order, in scope. */
  private async assertImageTarget(
    user: AuthUser,
    id: string,
    file?: { buffer?: Buffer; mimetype?: string },
  ) {
    if (!file?.buffer?.length) throw new BadRequestException('No image file uploaded');
    if (file.mimetype && !file.mimetype.startsWith('image/')) {
      throw new BadRequestException('Uploaded file is not an image');
    }
    const o = await this.prisma.customOrder.findUnique({ where: { id } });
    if (!o) throw new NotFoundException('Custom order not found');
    this.scope.assertStoreAllowed(user, o.storeId);
    return o;
  }

  private extOf(file: { originalname?: string }): string {
    return (file.originalname?.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  private toView(o: any) {
    const eta: Date | null = o.eta ?? null;
    const isOpen = !TERMINAL_STAGES.includes(o.stage);
    const delayed = !!eta && eta.getTime() < Date.now() && isOpen && o.stage !== OrderStatus.ready;

    // Time-in-stage vs the stage's own budget: a piece can be inside its overall
    // ETA and still be stuck, which is exactly when intervening still helps.
    const daysInStage = daysSince(o.stageEnteredAt ?? o.createdAt);
    const slaDays = STAGE_SLA_DAYS[o.stage as OrderStatus] ?? null;
    const stageOverdue = isOpen && slaDays != null && daysInStage != null && daysInStage > slaDays;

    const value = num(o.value);
    const advance = num(o.advanceReceived);

    return {
      id: o.id,
      ref: o.ref,
      customer: o.customerName,
      item: o.item,
      kind: o.kind,
      category: o.category ?? null,
      qty: o.qty,
      details: o.details ?? null,
      imageUrl: o.imageUrl ?? null,
      estimation: value,
      advanceReceived: o.advanceReceived == null ? null : advance,
      /// What the customer still owes at handover.
      balanceDue: value > 0 ? Math.max(0, value - advance) : 0,
      ringSize: o.ringSize ?? null,
      bangleSize: o.bangleSize ?? null,
      metalColor: o.metalColor ?? null,
      advanceMode: o.advanceMode ?? null,
      advanceReceiptUrl: o.advanceReceiptUrl ?? null,
      deliveryDate: o.deliveryDate ? o.deliveryDate.toISOString().slice(0, 10) : '',
      storeId: o.storeId,
      storeName: o.store?.name ?? '',
      stage: o.stage,
      stageLabel: STAGE_LABELS[o.stage as OrderStatus],
      currentStageIndex: STAGE_INDEX[o.stage as OrderStatus],
      ownerRole: o.ownerRole,
      ownerName: o.ownerName ?? '',
      bookedOn: o.bookedOn.toISOString().slice(0, 10),
      eta: eta ? eta.toISOString().slice(0, 10) : '',
      delayed,
      /// Days the order has been sitting in its CURRENT stage, and whether that
      /// exceeds the stage's budget.
      daysInStage,
      stageSlaDays: slaDays,
      stageOverdue,
      ageDays: daysSince(o.bookedOn),
      cancelReason: o.cancelReason ?? null,
      cancelledAt: o.cancelledAt ? o.cancelledAt.toISOString() : null,
      deliveredTo: o.deliveredTo ?? null,
      deliveredAt: o.deliveredAt ? o.deliveredAt.toISOString() : null,
    };
  }

  /** GET /timelines/replenishment — factory→store stock movement from production bags. */
  async replenishment(user: AuthUser, headerStore?: string) {
    const storeIds = this.scope.effectiveStoreIds(user, headerStore);
    if (storeIds.length === 0) return [];

    // ProductionBag links to ManufacturingOrder which carries storeId (the destination store).
    const bags = await this.prisma.productionBag.findMany({
      where: { order: { storeId: { in: storeIds } } },
      include: { order: { include: { store: true } } },
      orderBy: { bagDate: 'desc' },
    });

    const STATUS_MAP: Record<string, string> = {
      requested: 'Requested',
      dispatched: 'Dispatched',
      in_transit: 'In transit',
      received: 'Received',
    };

    return bags.map((b) => ({
      id: b.id,
      material: b.barcode ? `${b.bagNo} · ${b.barcode}` : b.bagNo,
      source: b.department ?? 'Factory',
      destStoreId: b.order?.storeId ?? '',
      destStoreName: b.order?.store?.name ?? '',
      grams: num(b.grossWeight),
      status: STATUS_MAP[b.status ?? ''] ?? b.status ?? 'Requested',
      eta: b.bagDate ? b.bagDate.toISOString().slice(0, 10) : '',
    }));
  }
}
