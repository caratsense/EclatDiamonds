import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OrderStatus, Prisma, QuoteKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { QuoteApprovalService } from './quote-approval.service';
import { StoreScopeService } from '../common/store-scope.service';
import { isAllStoreRole } from '../common/role.util';
import { SequenceService } from '../common/sequence.service';
import { StorageService } from '../storage/storage.service';
import { WhatsAppService } from '../integrations/whatsapp.service';
import { ActivityService } from '../crm/activity.service';
import { IdentityService } from '../crm/identity.service';
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
    isKaccha: q.isKaccha ?? false,
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
      perCaratRate: l.perCaratRate != null ? Number(l.perCaratRate) : null,
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
      const computedStone = (l.perCaratRate != null && l.caratWeight != null) 
        ? l.perCaratRate * l.caratWeight 
        : (l.stoneCharges ?? 0);
      stoneCharges += computedStone;
    }
  }
  const taxable = metalValue + makingCharges + stoneCharges;
  const gst = taxable * GST_RATE;
  return { metalValue, makingCharges, stoneCharges, taxable, gst, grandTotal: taxable + gst };
}

@Injectable()
export class QuotesService {
  private readonly logger = new Logger(QuotesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly storage: StorageService,
    private readonly sequence: SequenceService,
    private readonly whatsapp: WhatsAppService,
    private readonly identity: IdentityService,
    private readonly activity: ActivityService,
    private readonly approval: QuoteApprovalService,
  ) {}

  /**
   * POST /quotes/:id/share — send this quote to ITS OWN customer on WhatsApp.
   *
   * Deliberately not routed through `POST /integrations/whatsapp/send`, which is
   * manager-and-above precisely because it will send arbitrary text to an
   * arbitrary number. Here the recipient is read off the quote record, so the
   * caller chooses nothing: a salesperson can send a customer their own price
   * without that also being a way to send anything to anyone.
   *
   * Returns the true outcome rather than a bare 200 — `delivered: false` with
   * `dryRun: true` means WhatsApp is not connected on this deployment and the
   * customer received nothing.
   */
  async share(user: AuthUser, id: string) {
    const quote = await this.get(user, id); // scope + kaccha checks live here
    if (!quote.phone) {
      throw new BadRequestException('This quote has no phone number to send to');
    }

    /*
     * The approval gate, checked BEFORE anything is composed or sent.
     *
     * This is the only door out to a customer, so it is the only place the check
     * has to exist — and the only place it must not be possible to skip. A
     * tenant with no threshold configured passes straight through, which is why
     * this is safe to ship ahead of anybody choosing their number.
     */
    const gate = await this.approval.gate(user.organisationId, id);
    if (!gate.cleared) {
      throw new ForbiddenException(gate.reason ?? 'This quote cannot be sent yet.');
    }

    const store = await this.prisma.store.findUnique({
      where: { id: quote.originStoreId },
      select: { name: true },
    });

    const body = [
      store?.name ?? 'CaratSense',
      `Quote ${quote.ref}`,
      quote.customer,
      '',
      `Total: ${new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: 'INR',
        maximumFractionDigits: 0,
      }).format(quote.totals.grandTotal)}${quote.isKaccha ? ' (estimate, excl. GST)' : ''}`,
      quote.validUntil ? `Valid until ${quote.validUntil}` : '',
      '',
      'Thank you for visiting us.',
    ]
      .filter(Boolean)
      .join('\n');

    const result = await this.whatsapp.sendText(user.organisationId, quote.phone, body);
    return {
      delivered: result.delivered,
      dryRun: result.dryRun,
      ref: quote.ref,
      to: result.to,
      ...(result.error ? { error: result.error } : {}),
    };
  }

  async list(user: AuthUser, headerStore?: string, includeKaccha = false) {
    // "@" kaccha provision: rough no-GST estimates are hidden from the normal
    // list. Only head_office may opt back in (includeKaccha); any non-HO request
    // keeps them hidden regardless of the flag.
    const showKaccha = includeKaccha && isAllStoreRole(user.role);
    const where: Prisma.QuoteWhereInput = {
      ...this.scope.storeFilter(user, headerStore),
      ...(showKaccha ? {} : { isKaccha: false }),
    };
    const quotes = await this.prisma.quote.findMany({
      where,
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
    // "@" kaccha quotes are HO-only: don't reveal them by ref to anyone else.
    if (q.isKaccha && !isAllStoreRole(user.role)) throw new NotFoundException('Quote not found');
    return toView(q);
  }

  async create(user: AuthUser, dto: CreateQuoteDto) {
    this.scope.assertStoreAllowed(user, dto.storeId);
    const kind = dto.kind ?? QuoteKind.sale;
    const isKaccha = dto.isKaccha ?? false;
    const t = computeTotals(dto.lines, kind);
    // "@" kaccha provision: a rough estimate carries NO GST. Taxable (making +
    // metal + stones, per the sale/repair rule above) stays as computed; we just
    // force the tax to zero and make the grand total equal the taxable amount.
    if (isKaccha) {
      t.gst = 0;
      t.grandTotal = t.taxable;
    }
    // Sequence-backed, same reason as the order refs this service also mints.
    const seq = await this.sequence.next('QT:global');
    const redeemable = [...new Set([dto.storeId, ...(dto.redeemableStoreIds ?? [])])];

    const quote = await this.prisma.quote.create({
      data: {
        organisationId: user.organisationId,
        ref: `QT-${2000 + seq}`,
        storeId: dto.storeId,
        leadId: dto.leadId,
        assignedRepId: user.id,
        customerName: dto.customerName,
        phone: dto.phone,
        status: dto.status ?? 'draft',
        kind,
        isKaccha,
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
          create: dto.lines.map((l) => {
            const stoneCharges = (l.perCaratRate != null && l.caratWeight != null)
              ? l.perCaratRate * l.caratWeight
              : (l.stoneCharges ?? 0);
            return {
              productId: l.productId,
              description: l.description,
              karat: l.karat,
              weightGrams: new Prisma.Decimal(l.weightGrams),
              goldRatePerGram: new Prisma.Decimal(l.goldRatePerGram),
              makingCharges: new Prisma.Decimal(l.makingCharges ?? 0),
              stoneCharges: new Prisma.Decimal(stoneCharges),
              caratWeight: new Prisma.Decimal(l.caratWeight ?? 0),
              perCaratRate: l.perCaratRate != null ? new Prisma.Decimal(l.perCaratRate) : null,
            };
          }),
        },
        redeemableStores: { create: redeemable.map((storeId) => ({ storeId })) },
      },
      include: { assignedRep: true, lines: true, redeemableStores: true, photos: true },
    });

    // Phase A4/A6 — join the quote to a customer and put it on their timeline.
    //
    // A quote raised against a LEAD inherits that lead's customer rather than
    // re-resolving from the phone: the lead already did that work, and re-running
    // it would let a mistyped digit on the quote form silently attach the quote to
    // a different person than the lead it came from.
    let partyId: string | null = null;
    let unresolvedReason: string | null = null;
    if (dto.leadId) {
      const lead = await this.prisma.lead.findFirst({
        where: { id: dto.leadId, organisationId: user.organisationId },
        select: { partyId: true },
      });
      partyId = lead?.partyId ?? null;
    }
    if (!partyId) {
      const identity = await this.identity.resolveForRecord(user, {
        phone: dto.phone,
        name: dto.customerName,
        storeId: dto.storeId,
        source: 'quote',
      });
      partyId = identity.partyId;
      unresolvedReason = identity.unresolvedReason;
    }
    if (partyId) {
      await this.prisma.quote.update({ where: { id: quote.id }, data: { partyId } });
    }

    await this.activity.recordFor(user, {
      type: 'quote.created',
      summary: `Quote ${quote.ref} for ${dto.customerName} — ₹${Number(t.grandTotal)}`,
      partyId,
      leadId: dto.leadId ?? null,
      storeId: dto.storeId,
      entityType: 'Quote',
      entityId: quote.id,
      channel: 'store',
      metadata: {
        grandTotal: Number(t.grandTotal),
        kind,
        lineCount: dto.lines.length,
        // The unresolved state is carried on the event, so "why is this quote not
        // on a customer?" has an answer months later.
        ...(unresolvedReason ? { customerUnresolved: unresolvedReason } : {}),
      },
    });

    // Every quoted catalogue item becomes a product interaction, so "what did we
    // quote this customer?" is answerable from Customer 360 without reading
    // quote lines. Lines with no catalogue product carry their description as the
    // free-text identifier rather than being dropped.
    await this.recordQuotedInterest(user, quote.id, partyId, dto);

    return toView(quote);
  }

  /**
   * Record 'quoted' product interest for a quote's lines. Best-effort: a failure
   * here must never undo a quote that was already priced and saved.
   */
  private async recordQuotedInterest(
    user: AuthUser,
    quoteId: string,
    partyId: string | null,
    dto: CreateQuoteDto,
  ): Promise<void> {
    try {
      const rows = dto.lines.map((l) => ({
        organisationId: user.organisationId,
        storeId: dto.storeId,
        partyId,
        leadId: dto.leadId ?? null,
        productId: l.productId ?? null,
        sku: l.productId ? null : (l.description ?? null),
        kind: 'quoted',
        userId: user.id,
        channel: 'store',
        notes: null,
        metadata: { quoteId },
      }));
      if (rows.length) await this.prisma.productInteraction.createMany({ data: rows });
    } catch (e) {
      this.logger.warn(
        `Quote ${quoteId}: product interest not recorded — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
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
    const url = await this.storage.save(user.organisationId, 'quotes', `${id}-${Date.now()}.${ext}`, file.buffer);
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

    // An advance cannot exceed the order value — a data-entry slip that would
    // otherwise persist a negative balance (mirrors the direct-booking guard).
    if (
      dto.advanceReceived != null &&
      new Prisma.Decimal(dto.advanceReceived).greaterThan(q.grandTotal)
    ) {
      throw new BadRequestException('Advance cannot exceed the order value');
    }

    // Same store-scoped, sequence-backed ref format the timelines module mints,
    // so an order looks identical whether it was booked directly or converted
    // from a quote. (`CO-${Date.now()}` collided under concurrency and told the
    // customer nothing.)
    const store = await this.prisma.store.findUnique({
      where: { id: q.storeId },
      select: { code: true },
    });
    const now = new Date();
    const period = `${String(now.getUTCFullYear()).slice(2)}${String(
      now.getUTCMonth() + 1,
    ).padStart(2, '0')}`;
    const branch = (store?.code ?? q.storeId.slice(-4)).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const ref = await this.sequence.nextRef('CO', `${branch}-${period}`);

    const order = await this.prisma.customOrder.create({
      data: {
        organisationId: user.organisationId,
        ref,
        storeId: q.storeId,
        partyId: q.partyId,
        customerName: q.customerName,
        value: q.grandTotal,
        item,
        stage: OrderStatus.booked,
        stageEnteredAt: now,
        ownerRole: 'salesperson',
        ownerName: user.name,
        bookedOn: now,
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
