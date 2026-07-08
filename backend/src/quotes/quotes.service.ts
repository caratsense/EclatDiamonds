import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { OrderStatus, Prisma, QuoteKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { StorageService } from '../storage/storage.service';
import { ConvertToOrderDto, CreateQuoteDto, QuoteLineDto } from './dto/quote.dto';

const GST_RATE = 0.03;

function toView(q: any) {
  return {
    id: q.id,
    ref: q.ref,
    customer: q.customerName,
    phone: q.phone ?? '',
    originStoreId: q.storeId,
    redeemableStoreIds: (q.redeemableStores ?? []).map((r: any) => r.storeId),
    status: q.status,
    kind: q.kind,
    remarks: q.remarks ?? '',
    grossWeightG: q.grossWeightG == null ? null : Number(q.grossWeightG),
    createdAt: q.createdAt.toISOString().slice(0, 10),
    validUntil: q.validUntil ? q.validUntil.toISOString().slice(0, 10) : '',
    assignedRep: q.assignedRep?.name ?? '',
    lines: (q.lines ?? []).map((l: any) => ({
      id: l.id,
      description: l.description,
      karat: l.karat,
      weightGrams: Number(l.weightGrams),
      goldRatePerGram: Number(l.goldRatePerGram),
      makingCharges: Number(l.makingCharges),
      stoneCharges: Number(l.stoneCharges),
      caratWeight: Number(l.caratWeight),
    })),
    photos: (q.photos ?? []).map((p: any) => ({
      id: p.id,
      url: p.url,
      label: p.label ?? '',
      createdAt: p.createdAt.toISOString(),
    })),
    totals: {
      metalValue: Number(q.metalValue),
      makingCharges: Number(q.makingCharges),
      stoneCharges: Number(q.stoneCharges),
      taxable: Number(q.taxableAmount),
      gst: Number(q.gstAmount),
      grandTotal: Number(q.grandTotal),
    },
  };
}

/**
 * Server-side pricing rollup — the source of truth (never trust client totals).
 *
 * For a `sale` quote: taxable = metal + making + stone, GST 3% on the whole.
 * For a `repair` quote: making-ONLY — metal & stone are zeroed, taxable = sum of
 * line making charges, GST 3% on making, grandTotal = making + GST.
 */
function computeTotals(lines: QuoteLineDto[], kind: QuoteKind = QuoteKind.sale) {
  const repair = kind === QuoteKind.repair;
  let metalValue = 0;
  let makingCharges = 0;
  let stoneCharges = 0;
  for (const l of lines) {
    makingCharges += l.makingCharges ?? 0;
    if (!repair) {
      metalValue += l.weightGrams * l.goldRatePerGram;
      stoneCharges += l.stoneCharges ?? 0;
    }
  }
  const taxable = metalValue + makingCharges + stoneCharges;
  const gst = taxable * GST_RATE;
  return { metalValue, makingCharges, stoneCharges, taxable, gst, grandTotal: taxable + gst };
}

@Injectable()
export class QuotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly storage: StorageService,
  ) {}

  async list(user: AuthUser, headerStore?: string) {
    const quotes = await this.prisma.quote.findMany({
      where: this.scope.storeFilter(user, headerStore),
      include: { assignedRep: true, lines: true, redeemableStores: true },
      orderBy: { createdAt: 'desc' },
    });
    return quotes.map(toView);
  }

  async get(user: AuthUser, id: string) {
    const q = await this.prisma.quote.findFirst({
      where: { id, ...this.scope.storeFilter(user) },
      include: { assignedRep: true, lines: true, redeemableStores: true, photos: true },
    });
    if (!q) throw new NotFoundException('Quote not found');
    return toView(q);
  }

  async create(user: AuthUser, dto: CreateQuoteDto) {
    this.scope.assertStoreAllowed(user, dto.storeId);
    const kind = dto.kind ?? QuoteKind.sale;
    const t = computeTotals(dto.lines, kind);
    const count = await this.prisma.quote.count();
    const redeemable = [...new Set([dto.storeId, ...(dto.redeemableStoreIds ?? [])])];

    const quote = await this.prisma.quote.create({
      data: {
        ref: `QT-${2000 + count + 1}`,
        storeId: dto.storeId,
        leadId: dto.leadId,
        assignedRepId: user.id,
        customerName: dto.customerName,
        phone: dto.phone,
        status: dto.status ?? 'draft',
        kind,
        remarks: dto.remarks ?? null,
        grossWeightG:
          dto.grossWeightG != null ? new Prisma.Decimal(dto.grossWeightG) : null,
        validUntil: dto.validUntil ? new Date(dto.validUntil) : null,
        metalValue: new Prisma.Decimal(t.metalValue),
        makingCharges: new Prisma.Decimal(t.makingCharges),
        stoneCharges: new Prisma.Decimal(t.stoneCharges),
        taxableAmount: new Prisma.Decimal(t.taxable),
        gstAmount: new Prisma.Decimal(t.gst),
        grandTotal: new Prisma.Decimal(t.grandTotal),
        lines: {
          create: dto.lines.map((l) => ({
            productId: l.productId,
            description: l.description,
            karat: l.karat,
            weightGrams: new Prisma.Decimal(l.weightGrams),
            goldRatePerGram: new Prisma.Decimal(l.goldRatePerGram),
            makingCharges: new Prisma.Decimal(l.makingCharges ?? 0),
            stoneCharges: new Prisma.Decimal(l.stoneCharges ?? 0),
            caratWeight: new Prisma.Decimal(l.caratWeight ?? 0),
          })),
        },
        redeemableStores: { create: redeemable.map((storeId) => ({ storeId })) },
      },
      include: { assignedRep: true, lines: true, redeemableStores: true, photos: true },
    });
    return toView(quote);
  }

  /**
   * POST /quotes/:id/photo — attach a reference / repair photo to a quote.
   * Reuses the shared StorageService (only the public URL is persisted). Store
   * scope is enforced through the quote's storeId (findFirst + storeFilter).
   * Returns the updated quote (with photos).
   */
  async addPhoto(
    user: AuthUser,
    id: string,
    file?: { buffer?: Buffer; originalname?: string; mimetype?: string },
    label?: string,
  ) {
    if (!file?.buffer?.length) throw new BadRequestException('No image file uploaded');
    if (file.mimetype && !file.mimetype.startsWith('image/')) {
      throw new BadRequestException('Uploaded file is not an image');
    }

    const q = await this.prisma.quote.findFirst({
      where: { id, ...this.scope.storeFilter(user) },
      select: { id: true },
    });
    if (!q) throw new NotFoundException('Quote not found');

    const ext = (file.originalname?.split('.').pop() || 'jpg')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
    const url = await this.storage.save('quotes', `${id}-${Date.now()}.${ext}`, file.buffer);
    await this.prisma.quotePhoto.create({
      data: { quoteId: id, url, label: label ?? null },
    });
    return this.get(user, id);
  }

  /**
   * POST /quotes/:id/convert-to-order — fork a custom order (Module 8 timeline)
   * from an accepted quote. Creates the CustomOrder inline (no cross-module DI),
   * seeds an initial `booked` event, and flips the quote to `accepted`. Money is
   * taken from the quote (grandTotal), never the client.
   */
  async convertToOrder(user: AuthUser, id: string, dto: ConvertToOrderDto) {
    const q = await this.prisma.quote.findFirst({
      where: { id, ...this.scope.storeFilter(user) },
      include: { lines: true },
    });
    if (!q) throw new NotFoundException('Quote not found');
    this.scope.assertStoreAllowed(user, q.storeId);

    const item = q.lines[0]?.description ?? 'Custom piece';

    const order = await this.prisma.customOrder.create({
      data: {
        ref: `CO-${Date.now()}`,
        storeId: q.storeId,
        partyId: q.partyId,
        customerName: q.customerName,
        value: q.grandTotal,
        item,
        stage: OrderStatus.booked,
        ownerRole: 'salesperson',
        ownerName: user.name,
        bookedOn: new Date(),
        ringSize: dto.ringSize ?? null,
        bangleSize: dto.bangleSize ?? null,
        metalColor: dto.metalColor ?? null,
        advanceMode: dto.advanceMode ?? null,
        advanceReceived:
          dto.advanceReceived != null ? new Prisma.Decimal(dto.advanceReceived) : null,
        deliveryDate: dto.deliveryDate ? new Date(dto.deliveryDate) : null,
        events: {
          create: {
            stage: OrderStatus.booked,
            note: `Converted from quote ${q.ref}`,
            byRole: 'salesperson',
            byName: user.name,
          },
        },
      },
      select: { id: true, ref: true },
    });

    const quote = await this.prisma.quote.update({
      where: { id },
      data: { status: 'accepted' },
      include: { assignedRep: true, lines: true, redeemableStores: true, photos: true },
    });

    return { order, quote: toView(quote) };
  }
}
