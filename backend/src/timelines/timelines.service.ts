import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { OrderKind, OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { AuditService } from '../common/audit.service';
import { StorageService } from '../storage/storage.service';
import {
  AdvanceStageDto,
  CreateOrderDto,
  CreateWorkflowDto,
  OrdersQueryDto,
} from './dto/timelines.dto';

/** Terminal production stages — an order here can no longer be advanced. */
const TERMINAL_STAGES: OrderStatus[] = [OrderStatus.delivered, OrderStatus.cancelled];

function num(v: Prisma.Decimal | number | null | undefined): number {
  return v == null ? 0 : Number(v);
}

/**
 * Frontend ORDER_STAGES (mock/timelines.ts) are 5 collapsed stages:
 *   0 Gold melting · 1 Designing · 2 Stone setting · 3 Polishing · 4 Ready for collection
 * Map the schema's finer OrderStatus enum onto that index.
 */
const STAGE_INDEX: Record<OrderStatus, number> = {
  booked: 0,
  casting: 0,
  designing: 1,
  stone_setting: 2,
  polishing: 3,
  qc: 3,
  ready: 4,
  delivered: 4,
  cancelled: 4,
};

@Injectable()
export class TimelinesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
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
      where.stage = { notIn: [OrderStatus.delivered, OrderStatus.cancelled] };
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
    return rows.map((o) => this.toView(o));
  }

  /** GET /timelines/orders/:id — one custom order plus its full event history. */
  async order(user: AuthUser, id: string) {
    const o = await this.prisma.customOrder.findFirst({
      where: { id, ...this.scope.storeFilter(user) },
      include: { store: true, events: { orderBy: { occurredAt: 'asc' } } },
    });
    if (!o) throw new NotFoundException('Custom order not found');
    return {
      ...this.toView(o),
      events: o.events.map((e) => ({
        id: e.id,
        stage: e.stage,
        stageIndex: STAGE_INDEX[e.stage],
        note: e.note ?? '',
        byRole: e.byRole,
        byName: e.byName ?? '',
        at: e.occurredAt.toISOString(),
      })),
    };
  }

  /**
   * PATCH /timelines/orders/:id/stage — advance an order to a new production
   * stage (Module 8). Updates CustomOrder.stage AND appends a CustomOrderEvent
   * mirroring how createOrder seeds the initial `booked` event. Rejects moves on
   * orders already in a terminal stage (delivered / cancelled). Store-scoped.
   */
  async advanceStage(user: AuthUser, id: string, dto: AdvanceStageDto) {
    const o = await this.prisma.customOrder.findUnique({ where: { id } });
    if (!o) throw new NotFoundException('Custom order not found');
    this.scope.assertStoreAllowed(user, o.storeId);

    if (TERMINAL_STAGES.includes(o.stage)) {
      throw new BadRequestException(
        `Order is already ${o.stage} and cannot be advanced`,
      );
    }

    const from = o.stage;
    const to = dto.stage;

    await this.prisma.customOrder.update({
      where: { id },
      data: {
        stage: to,
        events: {
          create: {
            stage: to,
            note: dto.note ?? null,
            // Stage changes are driven from the back office in this timeline model.
            byRole: 'back_office',
            byName: user.name,
          },
        },
      },
    });

    await this.audit.record(user, {
      action: 'order.stage_change',
      entityType: 'CustomOrder',
      entityId: id,
      storeId: o.storeId,
      summary: `Advanced order ${o.ref}: ${from} → ${to}`,
      metadata: { from, to },
    });

    // Return the same detail view as GET /timelines/orders/:id.
    return this.order(user, id);
  }

  /**
   * POST /timelines/workflows — open a new custom-order workflow at the earliest
   * stage (booked → "Gold melting", stage index 0), owned by the salesperson role.
   */
  async createWorkflow(user: AuthUser, dto: CreateWorkflowDto) {
    this.scope.assertStoreAllowed(user, dto.storeId);

    const order = await this.prisma.customOrder.create({
      data: {
        ref: `CO-${Date.now()}`,
        storeId: dto.storeId,
        customerName: dto.customer,
        item: dto.item,
        stage: OrderStatus.booked,
        ownerRole: 'salesperson',
        ownerName: user.name,
        bookedOn: new Date(),
      },
      include: { store: true },
    });
    return this.toView(order);
  }

  /**
   * POST /timelines/orders — Module 2 order booking. Books either a customer
   * custom order (`kind: 'custom'`, ref `CO-…`) or a stock/replenishment order
   * (`kind: 'stock'`, ref `SO-…`, 21-day default timeline). Enters the timeline
   * at stage `booked`, owned by the salesperson role, and seeds an initial event.
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

    const order = await this.prisma.customOrder.create({
      data: {
        ref: `${prefix}-${Date.now()}`,
        storeId: dto.storeId,
        customerName: dto.customerName,
        kind,
        category: dto.category ?? null,
        qty: dto.qty ?? 1,
        details: dto.details ?? null,
        item,
        value: dto.estimation ?? null,
        advanceReceived: dto.advanceReceived ?? null,
        ringSize: dto.ringSize ?? null,
        bangleSize: dto.bangleSize ?? null,
        metalColor: dto.metalColor ?? null,
        advanceMode: dto.advanceMode ?? null,
        deliveryDate: dto.deliveryDate ? new Date(dto.deliveryDate) : null,
        stage: OrderStatus.booked,
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
    return this.toView(order);
  }

  /**
   * POST /timelines/orders/:id/image — attach a reference image to an order.
   * Reuses the shared StorageService (same provider as product images), storing
   * only the returned public URL on CustomOrder.imageUrl. Store-scoped.
   */
  async setOrderImage(
    user: AuthUser,
    id: string,
    file?: { buffer?: Buffer; originalname?: string; mimetype?: string },
  ) {
    if (!file?.buffer?.length) throw new BadRequestException('No image file uploaded');
    if (file.mimetype && !file.mimetype.startsWith('image/')) {
      throw new BadRequestException('Uploaded file is not an image');
    }

    const o = await this.prisma.customOrder.findUnique({ where: { id } });
    if (!o) throw new NotFoundException('Custom order not found');
    this.scope.assertStoreAllowed(user, o.storeId);

    const ext = (file.originalname?.split('.').pop() || 'jpg')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
    const imageUrl = await this.storage.save('orders', `${id}.${ext}`, file.buffer);
    const updated = await this.prisma.customOrder.update({
      where: { id },
      data: { imageUrl },
      include: { store: true },
    });
    return this.toView(updated);
  }

  /**
   * POST /timelines/orders/:id/receipt — attach the advance-payment receipt photo
   * to an order. Mirrors setOrderImage but writes CustomOrder.advanceReceiptUrl
   * (separate from imageUrl, which is the design reference). Store-scoped.
   */
  async setOrderReceipt(
    user: AuthUser,
    id: string,
    file?: { buffer?: Buffer; originalname?: string; mimetype?: string },
  ) {
    if (!file?.buffer?.length) throw new BadRequestException('No image file uploaded');
    if (file.mimetype && !file.mimetype.startsWith('image/')) {
      throw new BadRequestException('Uploaded file is not an image');
    }

    const o = await this.prisma.customOrder.findUnique({ where: { id } });
    if (!o) throw new NotFoundException('Custom order not found');
    this.scope.assertStoreAllowed(user, o.storeId);

    const ext = (file.originalname?.split('.').pop() || 'jpg')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
    const advanceReceiptUrl = await this.storage.save(
      'orders',
      `${id}-receipt.${ext}`,
      file.buffer,
    );
    const updated = await this.prisma.customOrder.update({
      where: { id },
      data: { advanceReceiptUrl },
      include: { store: true },
    });
    return this.toView(updated);
  }

  private toView(o: any) {
    const eta: Date | null = o.eta ?? null;
    const delayed =
      !!eta && eta.getTime() < Date.now() && !['ready', 'delivered'].includes(o.stage);
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
      estimation: num(o.value),
      advanceReceived: o.advanceReceived == null ? null : Number(o.advanceReceived),
      ringSize: o.ringSize ?? null,
      bangleSize: o.bangleSize ?? null,
      metalColor: o.metalColor ?? null,
      advanceMode: o.advanceMode ?? null,
      advanceReceiptUrl: o.advanceReceiptUrl ?? null,
      deliveryDate: o.deliveryDate ? o.deliveryDate.toISOString().slice(0, 10) : '',
      grams: num(o.value) > 0 ? 0 : 0, // grams not modelled on CustomOrder; see flags.
      storeId: o.storeId,
      storeName: o.store?.name ?? '',
      currentStageIndex: STAGE_INDEX[o.stage as OrderStatus],
      ownerRole: o.ownerRole,
      ownerName: o.ownerName ?? '',
      bookedOn: o.bookedOn.toISOString().slice(0, 10),
      eta: eta ? eta.toISOString().slice(0, 10) : '',
      delayed,
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
