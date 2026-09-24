import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PaymentMode, Prisma, SaleDocType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { isSalesScoped } from '../common/sales-scope';
import { AttributionService } from '../crm/attribution.service';
import { AuditService } from '../common/audit.service';
import { ActivityService } from '../crm/activity.service';
import { IdentityService } from '../crm/identity.service';
import { ROLE_RANK } from '../common/role.util';
import { StoreScopeService } from '../common/store-scope.service';
import { StorageService } from '../storage/storage.service';
import { DiscountsService } from '../discounts/discounts.service';
import { CancelSaleDto, CreateSaleDto, SalesQueryDto } from './dto/sales.dto';

function num(v: Prisma.Decimal | number | null | undefined): number {
  return v == null ? 0 : Number(v);
}

/** Uploaded multipart file shape (Express.Multer.File subset we rely on). */
type UploadedPhoto = {
  buffer?: Buffer;
  originalname?: string;
  mimetype?: string;
};

/**
 * Sales (Direct Sales) format + Module 12 payment capture folded in.
 *
 * Manual direct sales (isManual=true) are keyed by store staff for reporting and
 * carry the advance/total split + quotation/invoice/receipt photos. This is
 * ADDITIVE to the legacy-synced sales (isManual=false, sourced by the sync agent).
 */
@Injectable()
export class SalesService {
  private readonly logger = new Logger(SalesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly storage: StorageService,
    private readonly discounts: DiscountsService,
    private readonly audit: AuditService,
    private readonly identity: IdentityService,
    private readonly activity: ActivityService,
    private readonly attribution: AttributionService,
  ) {}

  /**
   * POST /sales — record a manual direct sale (Module 10 reporting) with the
   * advance payment folded in (Module 12).
   *
   * Module 15: a discount is captured as a diamond/making SPLIT (gold is never
   * discounted) and the configured caps are enforced HERE — a salesperson cannot
   * bypass the discount-request workflow by keying an over-cap discount straight
   * into a sale. Within cap → the sale is recorded. Over cap → NO sale is created;
   * an escalated DiscountRequest is raised, and the sale is recorded later by
   * re-submitting with the approved `discountRequestId`.
   */
  async create(user: AuthUser, dto: CreateSaleDto) {
    this.scope.assertStoreAllowed(user, dto.storeId);
    await this.scope.assertTradingStore(dto.storeId);

    const gross = new Prisma.Decimal(dto.salesValue);
    const dPct = dto.diamondDiscountPercent ?? 0;
    const mPct = dto.makingDiscountPercent ?? 0;
    const diamondValue = new Prisma.Decimal(dto.diamondValue ?? 0);
    const makingValue = new Prisma.Decimal(dto.makingValue ?? 0);
    const hasSplitDiscount = dPct > 0 || mPct > 0;

    let discount = new Prisma.Decimal(0);
    let total = gross;
    let linkedRequestId: string | null = null;

    if (hasSplitDiscount) {
      // The discountable bases cannot exceed the sale value (metal = remainder ≥ 0).
      if (diamondValue.plus(makingValue).greaterThan(gross)) {
        throw new BadRequestException(
          'Diamond + making value cannot exceed the sales value',
        );
      }
      // Decimal-safe: discount = diamondValue×d% + makingValue×m%.
      discount = diamondValue
        .times(dPct)
        .dividedBy(100)
        .plus(makingValue.times(mPct).dividedBy(100));
      total = gross.minus(discount);

      if (dto.discountRequestId) {
        // Re-submission after an over-cap discount was approved — verify the approval.
        const req = await this.prisma.discountRequest.findUnique({
          where: { id: dto.discountRequestId },
        });
        if (!req) throw new NotFoundException('Discount approval not found');
        this.scope.assertStoreAllowed(user, req.storeId);
        if (req.status !== 'approved') {
          throw new BadRequestException('The linked discount request is not approved');
        }
        // The applied split may not exceed what was approved.
        if (
          dPct > Number(req.diamondPercent ?? 0) ||
          mPct > Number(req.makingPercent ?? 0)
        ) {
          throw new BadRequestException('Discount exceeds the approved amount');
        }
        const already = await this.prisma.sale.findUnique({
          where: { discountRequestId: req.id },
        });
        if (already) {
          throw new ConflictException(
            'This approval has already been used on another sale',
          );
        }
        linkedRequestId = req.id;
      } else {
        // First submission — enforce the caps via the shared Module 15 evaluator.
        const { withinOwn, requiredRole } = await this.discounts.evaluateDiscount(
          user,
          dto.storeId,
          dPct,
          mPct,
        );
        if (!withinOwn) {
          // Over cap — do NOT create the sale. Raise the escalated request instead,
          // reusing the discount-request workflow (ref, notifications, approvals).
          const request = await this.discounts.create(user, {
            storeId: dto.storeId,
            customerName: dto.customerName,
            item: dto.description?.trim() || `Direct sale ${dto.invoiceNo}`,
            diamondPercent: dPct,
            makingPercent: mPct,
            sellingPrice: Number(gross),
          });
          return {
            requiresApproval: true as const,
            discountRequest: request,
            message: `This discount exceeds your limit — sent to ${requiredRole} for approval. Record the sale once it is approved.`,
          };
        }
        // Within cap → auto-approved; proceed (no request row needed).
      }
    } else if (
      dto.afterDiscountValue != null &&
      new Prisma.Decimal(dto.afterDiscountValue).lessThan(gross)
    ) {
      // A blended discount with no diamond/making split is the old cap bypass.
      throw new BadRequestException(
        'Enter the diamond/making discount breakdown so the discount can be authorised',
      );
    }

    const advance =
      dto.advanceReceived != null ? new Prisma.Decimal(dto.advanceReceived) : null;
    if (advance && advance.greaterThan(total)) {
      throw new BadRequestException('Advance cannot exceed the total value');
    }

    // Phase A6 — link the sale to a customer when a number was given. Never
    // blocks the sale: money changing hands is the fact that must be recorded,
    // and a bad phone number is not a reason to refuse an invoice.
    const identity = await this.identity.resolveForRecord(user, {
      phone: dto.phone,
      name: dto.customerName,
      storeId: dto.storeId,
      source: 'sale',
    });
    const partyId = identity.partyId;

    let saleId: string;
    try {
      const created = await this.prisma.sale.create({
        data: {
          organisationId: user.organisationId,
          storeId: dto.storeId,
          partyId,
          // The person who rang the bill up: their own sales list and the
          // leaderboard both read it.
          salesPersonId: user.isMachine ? null : user.id,
          docNo: dto.invoiceNo,
          docType: SaleDocType.sale,
          docDate: new Date(),
          isManual: true,
          customerName: dto.customerName,
          remarks: dto.description ?? null,
          grossAmount: gross,
          discountAmount: discount,
          totalAmount: total,
          paymentMode: dto.paymentMode ?? null,
          advanceReceived: advance,
          // Module 15 split snapshot + approval link (null on a no-discount sale).
          diamondValue: hasSplitDiscount ? diamondValue : null,
          makingValue: hasSplitDiscount ? makingValue : null,
          diamondDiscountPercent: hasSplitDiscount ? new Prisma.Decimal(dPct) : null,
          makingDiscountPercent: hasSplitDiscount ? new Prisma.Decimal(mPct) : null,
          discountRequestId: linkedRequestId,
        },
      });
      saleId = created.id;
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException(
          `A sale with invoice number "${dto.invoiceNo}" already exists for this store.`,
        );
      }
      throw e;
    }

    // Fold the advance payment into the sale (Module 12 — no standalone screen).
    if (advance && advance.greaterThan(0) && dto.paymentMode) {
      await this.prisma.payment.create({
        data: {
          organisationId: user.organisationId,
          storeId: dto.storeId,
          partyId,
          saleId,
          mode: dto.paymentMode,
          amount: advance,
          paidAt: new Date(),
        },
      });
    }

    await this.audit.record(user, {
      action: 'sale.create',
      entityType: 'Sale',
      entityId: saleId,
      storeId: dto.storeId,
      summary: `Sale ${dto.invoiceNo} recorded (₹${Number(total)})${
        discount.greaterThan(0) ? ` · discount ₹${Number(discount)}` : ''
      }`,
      metadata: {
        total: Number(total),
        discount: Number(discount),
        diamondPercent: dPct,
        makingPercent: mPct,
        discountRequestId: linkedRequestId,
      },
    });

    // Phase A4 — a purchase is the strongest product-interest signal there is.
    // A manual sale carries a free-text description rather than catalogue lines,
    // so that description is the identifier; `sku` is deliberately free text on
    // ProductInteraction precisely for this case.
    try {
      await this.prisma.productInteraction.create({
        data: {
          organisationId: user.organisationId,
          storeId: dto.storeId,
          partyId,
          productId: null,
          sku: dto.description ?? null,
          kind: 'purchased',
          userId: user.id,
          channel: 'store',
          metadata: { saleId, invoiceNo: dto.invoiceNo, total: Number(total) },
        },
      });
    } catch (e) {
      // Never unwind a recorded sale for a secondary CRM signal.
      this.logger.warn(
        `Sale ${dto.invoiceNo}: product interest not recorded — ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // Phase A10 — credit this sale to the touches that preceded it, under BOTH
    // attribution models. Best-effort: a sale is money that has changed hands and
    // must never be unwound because a marketing join failed.
    try {
      await this.attribution.creditSale(user.organisationId, {
        id: saleId,
        partyId,
        // The sale was just written with `docDate: new Date()`; using now here
        // matches it. Passing a later time would let a touch recorded seconds
        // after the sale be credited for it.
        docDate: new Date(),
      });
    } catch (e) {
      this.logger.warn(
        `Sale ${dto.invoiceNo}: attribution not credited — ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    await this.activity.recordFor(user, {
      type: 'sale.completed',
      summary: `Sale ${dto.invoiceNo} to ${dto.customerName} — ₹${Number(total)}`,
      partyId,
      storeId: dto.storeId,
      entityType: 'Sale',
      entityId: saleId,
      channel: 'store',
      metadata: {
        total: Number(total),
        discount: Number(discount),
        // Why this sale has no customer, when it has none. Quotes and returns
        // already carried this; sales did not, which made an unattributed sale
        // indistinguishable from one nobody had tried to attribute.
        ...(identity.unresolvedReason ? { customerUnresolved: identity.unresolvedReason } : {}),
      },
    });

    return this.get(user, saleId);
  }

  /**
   * POST /sales/:id/cancel — soft-void a sale (store manager → head office). The
   * row stays in the DB (never hard-deleted); every revenue/KPI query already
   * excludes `isCancelled`. A reason is mandatory and the void is audited.
   */
  async cancel(user: AuthUser, id: string, dto: CancelSaleDto) {
    const sale = await this.prisma.sale.findUnique({ where: { id } });
    if (!sale) throw new NotFoundException('Sale not found');
    // Store isolation: a store manager cannot void another store's sale.
    this.scope.assertStoreAllowed(user, sale.storeId);
    // Only store manager and above may void; a salesperson cannot.
    if (ROLE_RANK[user.role] < ROLE_RANK.store_manager) {
      throw new ForbiddenException(
        'Only a store manager or head office can cancel a sale',
      );
    }
    if (sale.isCancelled) {
      throw new BadRequestException('This sale is already cancelled');
    }
    const reason = dto.reason.trim();
    if (!reason) throw new BadRequestException('A cancellation reason is required');

    await this.prisma.sale.update({
      where: { id },
      data: {
        isCancelled: true,
        cancelledAt: new Date(),
        cancelledById: user.id,
        cancelReason: reason,
      },
    });
    await this.audit.record(user, {
      action: 'sale.void',
      entityType: 'Sale',
      entityId: id,
      storeId: sale.storeId,
      summary: `Voided sale ${sale.docNo} — ${reason}`,
      metadata: { reason },
    });
    return this.get(user, id);
  }

  /**
   * GET /sales?scope=manual|all — store-scoped list. Defaults to manual direct
   * sales only; `all` includes legacy-synced sales too.
   */
  async list(user: AuthUser, query: SalesQueryDto = {}, headerStore?: string) {
    const scope = query.scope ?? 'manual';
    const where: Prisma.SaleWhereInput = {
      ...this.scope.storeFilter(user, headerStore),
      // A salesperson's own bills; the branch's sales are a manager's.
      ...(isSalesScoped(user) ? { salesPersonId: user.id } : {}),
    };
    if (scope === 'manual') where.isManual = true;

    const rows = await this.prisma.sale.findMany({
      where,
      include: {
        party: true,
        payments: { orderBy: { paidAt: 'desc' } },
      },
      orderBy: { docDate: 'desc' },
      take: 200,
    });
    return rows.map((s) => this.toRow(s));
  }

  /** GET /sales/:id — one sale plus its payments. Store-scoped. */
  async get(user: AuthUser, id: string) {
    const sale = await this.prisma.sale.findFirst({
      where: { id, ...this.scope.storeFilter(user), ...(isSalesScoped(user) ? { salesPersonId: user.id } : {}) },
      include: {
        party: true,
        store: true,
        payments: { orderBy: { paidAt: 'desc' } },
      },
    });
    if (!sale) throw new NotFoundException('Sale not found');
    return {
      ...this.toRow(sale),
      storeId: sale.storeId,
      storeName: sale.store?.name ?? '',
      isManual: sale.isManual,
      payments: sale.payments.map((p) => ({
        id: p.id,
        mode: p.mode,
        amount: num(p.amount),
        paidAt: p.paidAt.toISOString(),
        receiptUrl: p.receiptUrl ?? null,
        reference: p.reference ?? null,
      })),
    };
  }

  /** POST /sales/:id/quotation — attach/replace the quotation photo. Managers+. */
  async setQuotation(user: AuthUser, id: string, file?: UploadedPhoto) {
    const sale = await this.loadScoped(user, id);
    const url = await this.savePhoto(user, 'quotations', id, file);
    await this.prisma.sale.update({ where: { id }, data: { quotationUrl: url } });
    return this.get(user, sale.id);
  }

  /** POST /sales/:id/invoice — attach/replace the invoice photo. Managers+. */
  async setInvoice(user: AuthUser, id: string, file?: UploadedPhoto) {
    const sale = await this.loadScoped(user, id);
    const url = await this.savePhoto(user, 'invoices', id, file);
    await this.prisma.sale.update({ where: { id }, data: { invoiceUrl: url } });
    return this.get(user, sale.id);
  }

  /**
   * POST /sales/:id/receipt — attach the receipt photo to the latest (advance)
   * payment on this sale, or create a payment to hold it if none exists yet.
   */
  async setReceipt(user: AuthUser, id: string, file?: UploadedPhoto) {
    const sale = await this.loadScoped(user, id);
    const url = await this.savePhoto(user, 'receipts', id, file);

    const latest = await this.prisma.payment.findFirst({
      where: { saleId: id },
      orderBy: { paidAt: 'desc' },
    });

    if (latest) {
      await this.prisma.payment.update({
        where: { id: latest.id },
        data: { receiptUrl: url },
      });
    } else {
      await this.prisma.payment.create({
        data: {
          organisationId: user.organisationId,
          storeId: sale.storeId,
          partyId: sale.partyId,
          saleId: id,
          mode: sale.paymentMode ?? PaymentMode.cash,
          amount: sale.advanceReceived ?? new Prisma.Decimal(0),
          paidAt: new Date(),
          receiptUrl: url,
        },
      });
    }
    return this.get(user, sale.id);
  }

  /** Load a sale and assert the caller may touch its store. */
  private async loadScoped(user: AuthUser, id: string) {
    const sale = await this.prisma.sale.findUnique({ where: { id } });
    if (!sale) throw new NotFoundException('Sale not found');
    this.scope.assertStoreAllowed(user, sale.storeId);
    return sale;
  }

  /** Persist an uploaded photo under sales/<folder> and return its public URL. */
  private async savePhoto(user: AuthUser, folder: string, id: string, file?: UploadedPhoto) {
    if (!file?.buffer?.length) throw new BadRequestException('No file uploaded');
    if (file.mimetype && !file.mimetype.startsWith('image/')) {
      throw new BadRequestException('Uploaded file is not an image');
    }
    const ext = (file.originalname?.split('.').pop() || 'jpg')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
    return this.storage.save(
      user.organisationId,
      `sales/${folder}`,
      `${id}-${Date.now()}.${ext}`,
      file.buffer,
    );
  }

  /** Shape a Sale (with party + payments included) into the list row. */
  private toRow(s: any) {
    const total = num(s.totalAmount);
    const advance = s.advanceReceived == null ? 0 : num(s.advanceReceived);
    const receiptUrl =
      (s.payments ?? []).find((p: any) => p.receiptUrl)?.receiptUrl ?? null;
    return {
      id: s.id,
      // What kind of document this is. A branch transfer and a sale both live in
      // this table, and without this the two are indistinguishable from outside,
      // which is how a transfer can be read as revenue and nobody can tell.
      docType: s.docType,
      docNo: s.docNo,
      invoiceNo: s.docNo,
      customer: s.customerName ?? s.party?.name ?? 'Walk-in',
      description: s.remarks ?? '',
      salesValue: num(s.grossAmount),
      discount: num(s.discountAmount),
      afterDiscountValue: total,
      diamondDiscountPercent: s.diamondDiscountPercent != null ? num(s.diamondDiscountPercent) : null,
      makingDiscountPercent: s.makingDiscountPercent != null ? num(s.makingDiscountPercent) : null,
      advanceReceived: advance,
      balance: total - advance,
      paymentMode: s.paymentMode ?? null,
      quotationUrl: s.quotationUrl ?? null,
      invoiceUrl: s.invoiceUrl ?? null,
      receiptUrl,
      isCancelled: !!s.isCancelled,
      cancelReason: s.cancelReason ?? null,
      docDate: s.docDate.toISOString(),
    };
  }
}
