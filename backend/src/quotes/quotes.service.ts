import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { CreateQuoteDto, QuoteLineDto } from './dto/quote.dto';

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

/** Server-side pricing rollup — the source of truth (never trust client totals). */
function computeTotals(lines: QuoteLineDto[]) {
  let metalValue = 0;
  let makingCharges = 0;
  let stoneCharges = 0;
  for (const l of lines) {
    metalValue += l.weightGrams * l.goldRatePerGram;
    makingCharges += l.makingCharges ?? 0;
    stoneCharges += l.stoneCharges ?? 0;
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
      include: { assignedRep: true, lines: true, redeemableStores: true },
    });
    if (!q) throw new NotFoundException('Quote not found');
    return toView(q);
  }

  async create(user: AuthUser, dto: CreateQuoteDto) {
    this.scope.assertStoreAllowed(user, dto.storeId);
    const t = computeTotals(dto.lines);
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
      include: { assignedRep: true, lines: true, redeemableStores: true },
    });
    return toView(quote);
  }
}
