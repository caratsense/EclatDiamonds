import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PaymentMode, Prisma, SaleDocType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { StorageService } from '../storage/storage.service';
import { CreateSaleDto, SalesQueryDto } from './dto/sales.dto';

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly storage: StorageService,
  ) {}

  /**
   * POST /sales — record a manual direct sale (Module 10 reporting) with the
   * advance payment folded in (Module 12). Discount is derived as
   * salesValue - afterDiscountValue; a Payment is created when an advance was
   * taken with a known payment mode.
   */
  async create(user: AuthUser, dto: CreateSaleDto) {
    this.scope.assertStoreAllowed(user, dto.storeId);

    const gross = new Prisma.Decimal(dto.salesValue);
    const total = new Prisma.Decimal(dto.afterDiscountValue);
    const discount = gross.minus(total);
    const advance =
      dto.advanceReceived != null ? new Prisma.Decimal(dto.advanceReceived) : null;

    let saleId: string;
    try {
      const created = await this.prisma.sale.create({
        data: {
          storeId: dto.storeId,
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
          storeId: dto.storeId,
          saleId,
          mode: dto.paymentMode,
          amount: advance,
          paidAt: new Date(),
        },
      });
    }

    return this.get(user, saleId);
  }

  /**
   * GET /sales?scope=manual|all — store-scoped list. Defaults to manual direct
   * sales only; `all` includes legacy-synced sales too.
   */
  async list(user: AuthUser, query: SalesQueryDto = {}, headerStore?: string) {
    const scope = query.scope ?? 'manual';
    const where: Prisma.SaleWhereInput = {
      ...this.scope.storeFilter(user, headerStore),
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
      where: { id, ...this.scope.storeFilter(user) },
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
    const url = await this.savePhoto('quotations', id, file);
    await this.prisma.sale.update({ where: { id }, data: { quotationUrl: url } });
    return this.get(user, sale.id);
  }

  /** POST /sales/:id/invoice — attach/replace the invoice photo. Managers+. */
  async setInvoice(user: AuthUser, id: string, file?: UploadedPhoto) {
    const sale = await this.loadScoped(user, id);
    const url = await this.savePhoto('invoices', id, file);
    await this.prisma.sale.update({ where: { id }, data: { invoiceUrl: url } });
    return this.get(user, sale.id);
  }

  /**
   * POST /sales/:id/receipt — attach the receipt photo to the latest (advance)
   * payment on this sale, or create a payment to hold it if none exists yet.
   */
  async setReceipt(user: AuthUser, id: string, file?: UploadedPhoto) {
    const sale = await this.loadScoped(user, id);
    const url = await this.savePhoto('receipts', id, file);

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
  private async savePhoto(folder: string, id: string, file?: UploadedPhoto) {
    if (!file?.buffer?.length) throw new BadRequestException('No file uploaded');
    if (file.mimetype && !file.mimetype.startsWith('image/')) {
      throw new BadRequestException('Uploaded file is not an image');
    }
    const ext = (file.originalname?.split('.').pop() || 'jpg')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
    return this.storage.save(`sales/${folder}`, `${id}-${Date.now()}.${ext}`, file.buffer);
  }

  /** Shape a Sale (with party + payments included) into the list row. */
  private toRow(s: any) {
    const total = num(s.totalAmount);
    const advance = s.advanceReceived == null ? 0 : num(s.advanceReceived);
    const receiptUrl =
      (s.payments ?? []).find((p: any) => p.receiptUrl)?.receiptUrl ?? null;
    return {
      id: s.id,
      docNo: s.docNo,
      invoiceNo: s.docNo,
      customer: s.customerName ?? s.party?.name ?? 'Walk-in',
      description: s.remarks ?? '',
      salesValue: num(s.grossAmount),
      afterDiscountValue: total,
      advanceReceived: advance,
      balance: total - advance,
      paymentMode: s.paymentMode ?? null,
      quotationUrl: s.quotationUrl ?? null,
      invoiceUrl: s.invoiceUrl ?? null,
      receiptUrl,
      docDate: s.docDate.toISOString(),
    };
  }
}
