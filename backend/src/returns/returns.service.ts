import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { AuditService } from '../common/audit.service';
import { SequenceService } from '../common/sequence.service';
import { NotificationsService } from '../notifications/notifications.service';
import { assertNotSelfApproval, assertUndecided } from '../common/approval.util';
import { CreateDiamondRateDto, CreateReturnDto, ValuateReturnDto } from './dto/return.dto';

function num(v: Prisma.Decimal | number | null | undefined): number {
  return v == null ? 0 : Number(v);
}

/** Round a Decimal to whole rupees (ROUND_HALF_UP — Decimal.js default). */
function rupees(d: Prisma.Decimal): number {
  return d.toDecimalPlaces(0).toNumber();
}

/**
 * Live gold rate per gram (INR/g) by karat — fallback when no MetalRate row
 * exists yet. The 22k rate is the default "today's gold rate" for the calculator.
 */
const GOLD_RATE_PER_GRAM: Record<number, number> = { 24: 7180, 22: 6580, 18: 5390 };

// Module 14 calculator constants (client rules, CLIENT-CALL-2026-07 § Module 14).
const GOLD_PCT = 100; // gold: 100% of today's rate for both options.
const EXCHANGE_DIA_PCT = 100; // exchange: diamond at 100% of today's rate.
const BUYBACK_DIA_PCT = 80; // buyback/return (cash): diamond at 80% of today's rate.

/** Shape of a computed valuation (shared by /valuate preview + persisted create). */
interface Valuation {
  todayGoldRate: number;
  todayDiaRate: number;
  goldValueToday: number;
  diaValueToday: number;
  exchangeValue: number;
  buybackValue: number;
  breakdown: { makingReturned: 0; gstReturned: 0 };
}

function toView(r: any) {
  return {
    id: r.id,
    ref: r.ref,
    storeId: r.storeId,
    customer: r.customerName,
    phone: r.phone ?? '',
    type: r.type,
    item: r.item ?? '',
    originalValue: 0,
    oldGoldGrams: r.weightGrams != null ? num(r.weightGrams) : undefined,
    creditValue: num(r.value),
    deductions: 0,
    settlement: r.settlement,
    status: r.status,
    reason: r.reason ?? '',
    decisionNote: r.decisionNote ?? null,
    entryMode: r.entryMode ?? 'manual',
    invoiceNo: r.invoiceNo ?? undefined,
    createdAt: r.createdAt.toISOString(),
    raisedBy: r.raisedBy ?? '',
    photos: (r.photos ?? []).map((p: any) => ({ id: p.id, label: p.label ?? '', swatch: '' })),
    // Module 14 exchange/buyback calculator fields (undefined on legacy rows).
    chosenOption: r.chosenOption ?? undefined,
    exchangeValue: r.exchangeValue != null ? num(r.exchangeValue) : undefined,
    buybackValue: r.buybackValue != null ? num(r.buybackValue) : undefined,
    todayGoldRate: r.todayGoldRate != null ? num(r.todayGoldRate) : undefined,
    todayDiaRate: r.todayDiaRate != null ? num(r.todayDiaRate) : undefined,
    purchaseGoldWtG: r.purchaseGoldWtG != null ? num(r.purchaseGoldWtG) : undefined,
    purchaseGoldRate: r.purchaseGoldRate != null ? num(r.purchaseGoldRate) : undefined,
    purchaseDiaCarat: r.purchaseDiaCarat != null ? num(r.purchaseDiaCarat) : undefined,
    purchaseDiaRate: r.purchaseDiaRate != null ? num(r.purchaseDiaRate) : undefined,
    diaSpec: r.diaSpec ?? undefined,
    purchaseMaking: r.purchaseMaking != null ? num(r.purchaseMaking) : undefined,
  };
}

@Injectable()
export class ReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly audit: AuditService,
    private readonly sequence: SequenceService,
    private readonly notifications: NotificationsService,
  ) {}

  /** GET /returns — returns/exchanges/buybacks, store-scoped. */
  async list(user: AuthUser, headerStore?: string) {
    const rows = await this.prisma.returnRecord.findMany({
      where: this.scope.storeFilter(user, headerStore),
      include: { photos: true },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toView);
  }

  /** GET /returns/:id — one record with intake photos. */
  async get(user: AuthUser, id: string) {
    const r = await this.prisma.returnRecord.findFirst({
      where: { id, ...this.scope.storeFilter(user) },
      include: { photos: true },
    });
    if (!r) throw new NotFoundException('Return not found');
    return toView(r);
  }

  // -------------------------------------------------------------------------
  // Module 14 — exchange / buyback calculator
  // -------------------------------------------------------------------------

  /**
   * POST /returns/valuate — preview only, nothing persisted. Resolves today's
   * gold + diamond rates (request overrides win) and returns both option values.
   */
  async valuate(dto: ValuateReturnDto): Promise<Valuation> {
    const todayGoldRate = await this.resolveGoldRate(dto.storeId, dto.todayGoldRate);
    const todayDiaRate = await this.resolveDiaRate(dto.diaSpec, dto.storeId, dto.todayDiaRate);
    return this.computeValuation(
      dto.goldWtG,
      dto.diaCarat,
      todayGoldRate,
      todayDiaRate,
      dto.purchaseDiscountType,
      dto.purchaseDiscountValue,
    );
  }

  /**
   * Core exchange/buyback math (exact, Decimal-safe, whole-rupee rounded):
   *   goldValueToday = goldWeightG × todayGoldRatePerGram        (×100%)
   *   diaValueToday  = diaCarat    × todayDiaRatePerCarat        (100% base)
   *   EXCHANGE = goldValueToday×100% + diaValueToday×100% - purchaseDiscount   (making 0, GST 0)
   *   BUYBACK  = goldValueToday×100% + diaValueToday×80% - purchaseDiscount    (making 0, GST 0)
   */
  private computeValuation(
    goldWtG: number | undefined,
    diaCarat: number | undefined,
    todayGoldRate: number,
    todayDiaRate: number,
    purchaseDiscountType?: string,
    purchaseDiscountValue?: number,
  ): Valuation {
    const goldWt = new Prisma.Decimal(goldWtG ?? 0);
    const goldRate = new Prisma.Decimal(todayGoldRate ?? 0);
    const diaCt = new Prisma.Decimal(diaCarat ?? 0);
    const diaRate = new Prisma.Decimal(todayDiaRate ?? 0);

    const goldValueTodayD = goldWt.mul(goldRate).mul(GOLD_PCT).div(100);
    const diaValueTodayD = diaCt.mul(diaRate); // 100% diamond base value

    let rawExchange = goldValueTodayD.add(diaValueTodayD.mul(EXCHANGE_DIA_PCT).div(100));
    let rawBuyback = goldValueTodayD.add(diaValueTodayD.mul(BUYBACK_DIA_PCT).div(100));

    // Deduct purchase discount if specified (e.g. client voice note rule)
    let discountAmount = new Prisma.Decimal(0);
    if (purchaseDiscountValue && purchaseDiscountValue > 0) {
      if (purchaseDiscountType === 'percent') {
        discountAmount = diaValueTodayD.mul(purchaseDiscountValue).div(100);
      } else {
        discountAmount = new Prisma.Decimal(purchaseDiscountValue);
      }
    }

    const exchangeD = Prisma.Decimal.max(0, rawExchange.sub(discountAmount));
    const buybackD = Prisma.Decimal.max(0, rawBuyback.sub(discountAmount));

    return {
      todayGoldRate: Number(todayGoldRate ?? 0),
      todayDiaRate: Number(todayDiaRate ?? 0),
      goldValueToday: rupees(goldValueTodayD),
      diaValueToday: rupees(diaValueTodayD),
      exchangeValue: rupees(exchangeD),
      buybackValue: rupees(buybackD),
      breakdown: { makingReturned: 0, gstReturned: 0 },
    };
  }


  /**
   * POST /returns — raise a return/exchange/buyback.
   *
   * New Module-14 calculator flow (when `chosenOption` is supplied): computes
   * BOTH option values, persists the full purchase snapshot, sets `value` to the
   * chosen one and `type` = exchange | return, status `pending_approval` (HO must
   * approve). Otherwise falls back to the original exchange-value / old-gold /
   * return branches unchanged.
   */
  async create(user: AuthUser, dto: CreateReturnDto) {
    this.scope.assertStoreAllowed(user, dto.storeId);

    // Round 2: By-Invoice intake must carry the source invoice number.
    if (dto.entryMode === 'invoice' && !dto.invoiceNo?.trim()) {
      throw new BadRequestException('invoiceNo is required when entryMode is "invoice"');
    }

    // Sequence-backed ref. `count()`-derived numbers collide when two stores
    // raise a return in the same instant, and re-use a number after a deletion.
    const year = new Date().getFullYear();
    const ref = `RTN-${year}-${1000 + (await this.sequence.next(`RTN:${year}`))}`;

    // --- Module 14 exchange/buyback calculator branch ---
    if (dto.chosenOption) {
      const todayGoldRate = await this.resolveGoldRate(dto.storeId, dto.todayGoldRate);
      const todayDiaRate = await this.resolveDiaRate(dto.diaSpec, dto.storeId, dto.todayDiaRate);
      const v = this.computeValuation(dto.goldWtG, dto.diaCarat, todayGoldRate, todayDiaRate);

      const isExchange = dto.chosenOption === 'exchange';
      const value = isExchange ? v.exchangeValue : v.buybackValue;

      const row = await this.prisma.returnRecord.create({
        data: {
          ref,
          storeId: dto.storeId,
          customerName: dto.customerName,
          phone: dto.phone,
          type: isExchange ? 'exchange' : 'return',
          item: dto.item,
          value: new Prisma.Decimal(value),
          weightGrams: dto.goldWtG != null ? new Prisma.Decimal(dto.goldWtG) : null,
          settlement: dto.settlement ?? (isExchange ? 'exchange' : 'refund'),
          status: 'pending_approval',
          reason: dto.reason,
          raisedBy: user.name,
          raisedById: user.id,
          entryMode: dto.entryMode,
          invoiceNo: dto.invoiceNo,
          // Purchase snapshot + computed option values.
          purchaseGoldWtG: dto.goldWtG != null ? new Prisma.Decimal(dto.goldWtG) : null,
          purchaseGoldRate:
            dto.goldRateAtPurchase != null ? new Prisma.Decimal(dto.goldRateAtPurchase) : null,
          purchaseDiaCarat: dto.diaCarat != null ? new Prisma.Decimal(dto.diaCarat) : null,
          purchaseDiaRate:
            dto.diaRateAtPurchase != null ? new Prisma.Decimal(dto.diaRateAtPurchase) : null,
          diaSpec: dto.diaSpec,
          purchaseMaking: dto.making != null ? new Prisma.Decimal(dto.making) : null,
          todayGoldRate: new Prisma.Decimal(todayGoldRate),
          todayDiaRate: new Prisma.Decimal(todayDiaRate),
          exchangeValue: new Prisma.Decimal(v.exchangeValue),
          buybackValue: new Prisma.Decimal(v.buybackValue),
          chosenOption: dto.chosenOption,
        },
        include: { photos: true },
      });
      await this.notifyReturnRaised(user, row);
      return toView(row);
    }

    // --- Legacy branches (exchange-value / old-gold / return) — unchanged ---
    if (!dto.type) {
      throw new BadRequestException('type or chosenOption is required');
    }

    let creditValue = 0;
    if (dto.type === 'old_gold' || dto.type === 'exchange') {
      const rate = dto.ratePerGram ?? GOLD_RATE_PER_GRAM[dto.oldGoldKarat ?? 22] ?? 0;
      const grams = dto.oldGoldGrams ?? 0;
      creditValue = grams * rate - (dto.deductions ?? 0);
    } else if (dto.type === 'return') {
      creditValue = (dto.originalValue ?? 0) - (dto.deductions ?? 0);
    } else {
      creditValue = 0; // repair: estimate handled separately
    }
    creditValue = Math.max(0, Math.round(creditValue));

    const row = await this.prisma.returnRecord.create({
      data: {
        ref,
        storeId: dto.storeId,
        customerName: dto.customerName,
        phone: dto.phone,
        type: dto.type,
        item: dto.item,
        value: new Prisma.Decimal(creditValue),
        weightGrams: dto.oldGoldGrams != null ? new Prisma.Decimal(dto.oldGoldGrams) : null,
        settlement: dto.settlement ?? 'credit_note',
        status: 'pending_approval',
        reason: dto.reason,
        raisedBy: user.name,
        raisedById: user.id,
        entryMode: dto.entryMode,
        invoiceNo: dto.invoiceNo,
      },
      include: { photos: true },
    });
    await this.notifyReturnRaised(user, row);
    return toView(row);
  }

  /**
   * Tell head office a return is waiting. Returns are HO-approved and move money
   * out of the business, so they should never depend on someone thinking to
   * check the approvals screen.
   */
  private async notifyReturnRaised(user: AuthUser, row: any) {
    await this.notifications.emitToApprovers(
      row.storeId,
      'head_office',
      {
        kind: 'return_request',
        title: `${row.type === 'exchange' ? 'Exchange' : 'Return'} awaiting approval — ${row.ref}`,
        body: `${row.customerName} · ₹${num(row.value)}${row.reason ? ` — ${row.reason}` : ''}`,
        href: '/approvals',
        storeId: row.storeId,
        entityType: 'ReturnRecord',
        entityId: row.id,
        priority: 'high',
        actorId: user.id,
        actorName: user.name,
        dedupeKey: `return:${row.id}:raised`,
        metadata: { ref: row.ref, value: num(row.value), type: row.type },
      },
      user.id,
    );
  }

  /** PATCH /returns/:id/approve — HO signs off; store-access checked. */
  async approve(user: AuthUser, id: string, note?: string) {
    return this.setStatus(user, id, 'approved', note);
  }

  /** PATCH /returns/:id/reject — HO declines; store-access checked. */
  async reject(user: AuthUser, id: string, note?: string) {
    return this.setStatus(user, id, 'rejected', note);
  }

  private async setStatus(
    user: AuthUser,
    id: string,
    status: 'approved' | 'rejected',
    note?: string,
  ) {
    const existing = await this.prisma.returnRecord.findFirst({
      where: { id, ...this.scope.storeFilter(user) },
      select: { id: true, status: true, raisedById: true },
    });
    if (!existing) throw new NotFoundException('Return not found');

    // Double-decision guard: never flip an already-settled decision.
    assertUndecided(existing.status, ['approved', 'rejected', 'settled'], 'return');

    // Separation of duties. Returns are approved by head_office, so a head_office
    // user raising one would otherwise be able to sign off their own buyback —
    // the exact transaction that pays cash out against goods coming back in.
    assertNotSelfApproval(user, existing.raisedById, 'return');

    const row = await this.prisma.returnRecord.update({
      where: { id },
      data: { status, ...(note !== undefined ? { decisionNote: note } : {}) },
      include: { photos: true },
    });

    await this.audit.record(user, {
      action: status === 'approved' ? 'return.approve' : 'return.reject',
      entityType: 'ReturnRecord',
      entityId: row.id,
      storeId: row.storeId,
      summary: `${status === 'approved' ? 'Approved' : 'Rejected'} return ${row.ref} for ${
        row.customerName
      }`,
      metadata: { note: note ?? null },
    });

    if (row.raisedById) {
      await this.notifications.emit([row.raisedById], {
        kind: 'return_request',
        title: `${row.ref} ${status}`,
        body: `${row.customerName} · ₹${num(row.value)} — ${status} by ${user.name}${
          note?.trim() ? `: ${note.trim()}` : ''
        }`,
        href: '/returns',
        storeId: row.storeId,
        entityType: 'ReturnRecord',
        entityId: row.id,
        priority: status === 'rejected' ? 'high' : 'normal',
        actorId: user.id,
        actorName: user.name,
        dedupeKey: `return:${row.id}:decided`,
        metadata: { status },
      });
    }

    return toView(row);
  }

  // -------------------------------------------------------------------------
  // Rate tables (calculator UI + HO management)
  // -------------------------------------------------------------------------

  /** GET /returns/rates — current gold (per karat/gram) + diamond (per spec) rates. */
  async rates(headerStore?: string) {
    const scoped = headerStore && headerStore !== 'all' ? headerStore : undefined;
    const goldMetals: Array<[number, string]> = [
      [24, 'gold_24k'],
      [22, 'gold_22k'],
      [18, 'gold_18k'],
    ];
    const gold = [] as Array<{ karat: number; ratePerGram: number }>;
    for (const [karat, metal] of goldMetals) {
      gold.push({ karat, ratePerGram: await this.latestGoldRate(metal, scoped, karat) });
    }
    const diamond = await this.currentDiamondRates(scoped);
    return { gold, diamond };
  }

  /** GET /returns/diamond-rates — full diamond-rate table (HO management view). */
  async diamondRates(headerStore?: string) {
    const scoped = headerStore && headerStore !== 'all' ? headerStore : undefined;
    const rows = await this.prisma.diamondRate.findMany({
      where: scoped ? { OR: [{ storeId: scoped }, { storeId: null }] } : {},
      orderBy: [{ spec: 'asc' }, { effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map((r) => ({
      id: r.id,
      spec: r.spec,
      ratePerCarat: num(r.ratePerCarat),
      effectiveFrom: r.effectiveFrom.toISOString(),
      storeId: r.storeId ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /** POST /returns/diamond-rates — HO sets/updates a diamond rate for a spec. */
  async createDiamondRate(dto: CreateDiamondRateDto) {
    const row = await this.prisma.diamondRate.create({
      data: {
        spec: dto.spec,
        ratePerCarat: new Prisma.Decimal(dto.ratePerCarat),
        effectiveFrom: dto.effectiveFrom ? new Date(dto.effectiveFrom) : new Date(),
        storeId: dto.storeId ?? null,
      },
    });
    return {
      id: row.id,
      spec: row.spec,
      ratePerCarat: num(row.ratePerCarat),
      effectiveFrom: row.effectiveFrom.toISOString(),
      storeId: row.storeId ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Rate resolution helpers
  // -------------------------------------------------------------------------

  /** Latest gold rate (INR/g) for a metal; store override wins, else fallback table. */
  private async latestGoldRate(metal: string, scoped: string | undefined, karat: number): Promise<number> {
    const row = await this.prisma.metalRate.findFirst({
      where: { metal: metal as any, ...(scoped ? { OR: [{ storeId: scoped }, { storeId: null }] } : {}) },
      orderBy: [{ storeId: 'desc' }, { effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    });
    return row ? Number(row.ratePerGram) : (GOLD_RATE_PER_GRAM[karat] ?? GOLD_RATE_PER_GRAM[22]);
  }

  /** Resolve today's gold rate/gram: request override → latest 22k MetalRate → fallback. */
  private async resolveGoldRate(storeId: string | undefined, override?: number): Promise<number> {
    if (override != null) return override;
    const scoped = storeId && storeId !== 'all' ? storeId : undefined;
    return this.latestGoldRate('gold_22k', scoped, 22);
  }

  /** Resolve today's diamond rate/carat by spec: override → latest DiamondRate → 0. */
  private async resolveDiaRate(
    spec: string | undefined,
    storeId: string | undefined,
    override?: number,
  ): Promise<number> {
    if (override != null) return override;
    if (!spec) return 0;
    const scoped = storeId && storeId !== 'all' ? storeId : undefined;
    const row = await this.prisma.diamondRate.findFirst({
      where: { spec, ...(scoped ? { OR: [{ storeId: scoped }, { storeId: null }] } : {}) },
      orderBy: [{ storeId: 'desc' }, { effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    });
    return row ? Number(row.ratePerCarat) : 0;
  }

  /** Latest diamond rate per distinct spec (store override + most-recent wins). */
  private async currentDiamondRates(scoped?: string) {
    const rows = await this.prisma.diamondRate.findMany({
      where: scoped ? { OR: [{ storeId: scoped }, { storeId: null }] } : {},
      orderBy: [{ storeId: 'desc' }, { effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    });
    const seen = new Map<string, (typeof rows)[number]>();
    for (const r of rows) if (!seen.has(r.spec)) seen.set(r.spec, r);
    return [...seen.values()].map((r) => ({
      spec: r.spec,
      ratePerCarat: num(r.ratePerCarat),
      effectiveFrom: r.effectiveFrom.toISOString(),
      storeId: r.storeId ?? null,
    }));
  }
}
