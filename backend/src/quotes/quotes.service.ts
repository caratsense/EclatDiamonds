import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OrderStatus, Prisma, ProductCategory, QuoteKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { isSalesScoped } from '../common/sales-scope';
import { AuditService } from '../common/audit.service';
import { OmnichannelService } from '../omnichannel/omnichannel.service';
import { ApprovalGate, approvalResetFor, QuoteApprovalService } from './quote-approval.service';
import { renderQuotePdf } from './quote-pdf';
import { StoreScopeService } from '../common/store-scope.service';
import { isAllStoreRole } from '../common/role.util';
import { SequenceService } from '../common/sequence.service';
import { StorageService } from '../storage/storage.service';
import { WhatsAppService } from '../integrations/whatsapp.service';
import { ActivityService } from '../crm/activity.service';
import { IdentityService } from '../crm/identity.service';
import {
  ConvertToOrderDto,
  CreateQuoteDto,
  QuoteLineDto,
  QuoteStoneDto,
  SendQuotePdfDto,
  UpdateQuoteDto,
} from './dto/quote.dto';

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
    revision: q.revision ?? 1,
    discountPercent: Number(q.discountPercent ?? 0),
    makingDiscountPercent: Number(q.makingDiscountPercent ?? 0),
    stoneDiscountPercent: Number(q.stoneDiscountPercent ?? 0),
    additionalDiscount: Number(q.additionalDiscount ?? 0),
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
      styleNumber: l.styleNumber ?? null,
      size: l.size ?? null,
      metalCode: l.metalCode ?? null,
      makingRatePerGram: l.makingRatePerGram != null ? Number(l.makingRatePerGram) : null,
      stones: (l.stones as StoredStone[] | null) ?? [],
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
      discount: Number(q.discountAmount ?? 0),
      ...discountSplit(q),
      taxable: Number(q.taxableAmount),
      gst: Number(q.gstAmount),
      grandTotal: Number(q.grandTotal),
    },
  };
}

/** The stored discount in its three parts, the same way computeTotals made it. */
function discountSplit(q: any) {
  const total = Number(q.discountAmount ?? 0);
  const additional = Number(q.additionalDiscount ?? 0);
  const making = Math.min(
    round2((Number(q.makingCharges) * Number(q.makingDiscountPercent ?? 0)) / 100),
    total - additional,
  );
  return { makingDiscount: making, stoneDiscount: round2(total - additional - making), additionalDiscount: additional };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** A diamond / colour-stone entry as stored on a line. */
export interface StoredStone {
  type: 'D' | 'C';
  code: string;
  name?: string;
  size?: string;
  pieces?: number;
  carats: number;
  ratePerCt: number;
  multiplier: number;
  amount: number;
}

/** The amount is always the server's: carats x rate per carat x multiplier. */
function stoneData(s: QuoteStoneDto): StoredStone {
  const multiplier = s.multiplier ?? 1;
  return {
    type: s.type,
    code: s.code.trim(),
    ...(s.name?.trim() ? { name: s.name.trim() } : {}),
    ...(s.size?.trim() ? { size: s.size.trim() } : {}),
    ...(s.pieces != null ? { pieces: s.pieces } : {}),
    carats: s.carats,
    ratePerCt: s.ratePerCt,
    multiplier,
    amount: round2(s.carats * s.ratePerCt * multiplier),
  };
}

/**
 * What one item comes to. Making is its per-gram rate x the weight when a rate
 * is given, else the amount entered. Stones are the sum of their entries when
 * there are any; an older line prices its stones as rate x carats or a price.
 */
function linePrice(l: QuoteLineDto) {
  const stones = l.stones?.map(stoneData);
  const making =
    l.makingRatePerGram != null ? round2(l.makingRatePerGram * l.weightGrams) : (l.makingCharges ?? 0);
  const stoneCharges = stones
    ? round2(stones.reduce((sum, x) => sum + x.amount, 0))
    : l.perCaratRate != null && l.caratWeight != null
      ? l.perCaratRate * l.caratWeight
      : (l.stoneCharges ?? 0);
  const caratWeight = stones
    ? Math.round(stones.reduce((sum, x) => sum + x.carats, 0) * 1000) / 1000
    : (l.caratWeight ?? 0);
  return { stones, making, stoneCharges, caratWeight };
}

/** The discount as the salesperson gives it. */
export interface QuoteDiscounts {
  making: number;
  stone: number;
  additional: number;
}

/**
 * The discount a request asks for. A caller that sends only the one old
 * `discountPercent` gets it on making and stones both, which is what it meant.
 * On an edit, whatever is not sent stays as it was.
 */
function discountsFrom(
  dto: {
    discountPercent?: number;
    makingDiscountPercent?: number;
    stoneDiscountPercent?: number;
    additionalDiscount?: number;
  },
  current?: QuoteDiscounts,
): QuoteDiscounts {
  return {
    making: dto.makingDiscountPercent ?? dto.discountPercent ?? current?.making ?? 0,
    stone: dto.stoneDiscountPercent ?? dto.discountPercent ?? current?.stone ?? 0,
    additional: dto.additionalDiscount ?? current?.additional ?? 0,
  };
}

/**
 * Server-side pricing rollup — the source of truth (never trust client totals).
 *
 * For a `sale` quote: taxable = metal + making + stone, GST 3% on the whole.
 * For a `repair` quote: making-ONLY — metal & stone are zeroed, taxable = sum of
 * line making charges, GST 3% on making, grandTotal = making + GST.
 *
 * Discount comes off BEFORE tax: a % of making, a % of the stones, then a flat
 * amount. Gold is never discounted, so the three together may not come to more
 * than making + stones. `discountPercent` is what they come to as one % of
 * making + stones — the figure the approval caps judge.
 */
function computeTotals(
  lines: QuoteLineDto[],
  kind: QuoteKind = QuoteKind.sale,
  discounts: QuoteDiscounts = { making: 0, stone: 0, additional: 0 },
) {
  const repair = kind === QuoteKind.repair;
  let metalValue = 0;
  let makingCharges = 0;
  let stoneCharges = 0;
  for (const l of lines) {
    const p = linePrice(l);
    makingCharges += p.making;
    if (!repair) {
      metalValue += l.weightGrams * l.goldRatePerGram;
      stoneCharges += p.stoneCharges;
    }
  }
  const base = makingCharges + stoneCharges;
  // Summed before rounding, so equal making and stone percentages come to
  // exactly what the single percentage always did.
  const byPercent = (makingCharges * discounts.making + stoneCharges * discounts.stone) / 100;
  if (discounts.additional > round2(base - byPercent) + 0.001) {
    throw new BadRequestException(
      'The discount comes to more than the making and diamonds. Gold is never discounted.',
    );
  }
  const discountAmount = round2(byPercent + discounts.additional);
  const discountPercent =
    base > 0
      ? round2(((byPercent + discounts.additional) / base) * 100)
      : Math.max(discounts.making, discounts.stone);
  const taxable = metalValue + makingCharges + stoneCharges - discountAmount;
  const gst = taxable * GST_RATE;
  return {
    metalValue, makingCharges, stoneCharges, discountAmount, discountPercent, discounts, taxable, gst,
    grandTotal: taxable + gst,
  };
}

/** A line as stored, with the amounts the server worked out. */
function lineData(l: QuoteLineDto) {
  const p = linePrice(l);
  return {
    productId: l.productId,
    description: l.description,
    karat: l.karat,
    weightGrams: new Prisma.Decimal(l.weightGrams),
    goldRatePerGram: new Prisma.Decimal(l.goldRatePerGram),
    makingCharges: new Prisma.Decimal(p.making),
    stoneCharges: new Prisma.Decimal(p.stoneCharges),
    caratWeight: new Prisma.Decimal(p.caratWeight),
    perCaratRate: !p.stones && l.perCaratRate != null ? new Prisma.Decimal(l.perCaratRate) : null,
    styleNumber: l.styleNumber?.trim() || null,
    size: l.size?.trim() || null,
    metalCode: l.metalCode?.trim() || null,
    makingRatePerGram: l.makingRatePerGram != null ? new Prisma.Decimal(l.makingRatePerGram) : null,
    ...(p.stones ? { stones: p.stones as unknown as Prisma.InputJsonValue } : {}),
  };
}

/** A stored line back as input, so an edit that leaves the lines re-prices them the same. */
function lineInput(l: any): QuoteLineDto {
  const stones = l.stones as StoredStone[] | null;
  return {
    productId: l.productId ?? undefined,
    description: l.description,
    karat: l.karat,
    weightGrams: Number(l.weightGrams),
    goldRatePerGram: Number(l.goldRatePerGram),
    makingCharges: Number(l.makingCharges),
    stoneCharges: Number(l.stoneCharges),
    caratWeight: Number(l.caratWeight),
    perCaratRate: l.perCaratRate != null ? Number(l.perCaratRate) : undefined,
    styleNumber: l.styleNumber ?? undefined,
    size: l.size ?? undefined,
    metalCode: l.metalCode ?? undefined,
    makingRatePerGram: l.makingRatePerGram != null ? Number(l.makingRatePerGram) : undefined,
    stones: stones?.map(({ amount: _amount, ...rest }) => rest),
  };
}

/** The money columns a priced quote writes, from one rollup. */
function totalsData(t: ReturnType<typeof computeTotals>) {
  return {
    metalValue: new Prisma.Decimal(t.metalValue),
    makingCharges: new Prisma.Decimal(t.makingCharges),
    stoneCharges: new Prisma.Decimal(t.stoneCharges),
    discountAmount: new Prisma.Decimal(t.discountAmount),
    discountPercent: new Prisma.Decimal(t.discountPercent),
    makingDiscountPercent: new Prisma.Decimal(t.discounts.making),
    stoneDiscountPercent: new Prisma.Decimal(t.discounts.stone),
    additionalDiscount: new Prisma.Decimal(t.discounts.additional),
    taxableAmount: new Prisma.Decimal(t.taxable),
    gstAmount: new Prisma.Decimal(t.gst),
    grandTotal: new Prisma.Decimal(t.grandTotal),
  };
}

/** The custom-order category an item type names: LADIES RING is a ring. */
function orderCategory(description: string): ProductCategory {
  const d = description.toUpperCase();
  const words: [string, ProductCategory][] = [
    ['EARRING', ProductCategory.earrings],
    ['RING', ProductCategory.ring],
    ['PENDANT', ProductCategory.pendant],
    ['MANGALSUTRA', ProductCategory.pendant],
    ['BANGLE', ProductCategory.bangle],
    ['BRACELET', ProductCategory.bracelet],
    ['NECKLACE', ProductCategory.necklace],
    ['CHAIN', ProductCategory.chain],
  ];
  return words.find(([w]) => d.includes(w))?.[1] ?? ProductCategory.other;
}

/** What production needs to make the pieces: materials, weights, sizes. No prices. */
function orderDetails(lines: any[]): string {
  return lines
    .map((l) => {
      const stones = (l.stones as StoredStone[] | null) ?? [];
      return [
        l.description,
        l.styleNumber && `style ${l.styleNumber}`,
        l.size && `size ${l.size}`,
        l.metalCode ?? (l.karat ? `${l.karat}K` : null),
        Number(l.weightGrams) > 0 && `${Number(l.weightGrams).toFixed(3)} g`,
        ...stones.map(
          (x) => `${x.type} ${x.code}${x.size ? ` ${x.size}` : ''}${x.pieces ? ` ${x.pieces} pc` : ''} ${x.carats.toFixed(2)} ct`,
        ),
      ]
        .filter(Boolean)
        .join(' · ');
    })
    .join('\n');
}

function inr(amount: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(amount);
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
    private readonly omnichannel: OmnichannelService,
    private readonly audit: AuditService,
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
     * Every door out to a customer — this text, the PDF download and the PDF on
     * WhatsApp — calls the same `assertCleared`, so no door can be more lenient
     * than another. A tenant with no threshold and no discount caps passes
     * straight through, which is why this is safe to ship ahead of anybody
     * choosing their numbers.
     */
    await this.approval.assertCleared(user.organisationId, id);

    const store = await this.prisma.store.findUnique({
      where: { id: quote.originStoreId },
      select: { name: true },
    });

    const body = [
      store?.name ?? 'CaratSense',
      `Quote ${quote.ref}`,
      quote.customer,
      '',
      `Total: ${inr(quote.totals.grandTotal)}${quote.isKaccha ? ' (estimate, excl. GST)' : ''}`,
      quote.validUntil ? `Valid until ${quote.validUntil}` : '',
      '',
      'Thank you for visiting us.',
    ]
      .filter(Boolean)
      .join('\n');

    // From the branch that RAISED the quote, not one it can be redeemed at.
    // With several numbers connected an unrouted send is refused rather than
    // going out as another branch, so the branch has to be named here.
    const result = await this.whatsapp.sendText(user.organisationId, quote.phone, body, {
      storeId: quote.originStoreId,
    });
    return {
      delivered: result.delivered,
      dryRun: result.dryRun,
      ref: quote.ref,
      to: result.to,
      ...(result.error ? { error: result.error } : {}),
    };
  }

  /**
   * GET /quotes/:id/pdf — the detailed quote, for the customer.
   *
   * Resolved through `get()`, the same lookup as the quote screen, so whoever
   * cannot open the quote cannot download it — including any narrower
   * salesperson scope added there later. Refused until approval exists, like
   * every other door out.
   */
  async pdf(user: AuthUser, id: string) {
    await this.get(user, id);
    const gate = await this.approval.assertCleared(user.organisationId, id);
    return this.issuePdf(user, id, gate);
  }

  /**
   * POST /quotes/:id/send-pdf — the detailed quote as a WhatsApp document.
   *
   * Queued through the omnichannel outbox rather than sent from here, so it is
   * held to the same consent, STOP, 24-hour window and template rules as any
   * other outbound message, and its delivery state is the provider's answer.
   * With WhatsApp not connected the message is still queued and its job fails
   * with the reason; `dryRun` in the response says so up front.
   */
  async sendPdf(user: AuthUser, id: string, dto: SendQuotePdfDto) {
    const quote = await this.get(user, id);
    if (!quote.phone) {
      throw new BadRequestException('This quote has no phone number to send to');
    }
    const gate = await this.approval.assertCleared(user.organisationId, id);
    const doc = await this.issuePdf(user, id, gate);

    const store = await this.prisma.store.findFirst({
      where: { id: quote.originStoreId, organisationId: user.organisationId },
      select: { name: true },
    });
    const caption = [
      `Quote ${quote.ref}${store?.name ? ` from ${store.name}` : ''}`,
      `Total: ${inr(doc.grandTotal)}${quote.isKaccha ? ' (estimate, excl. GST)' : ''}`,
      quote.validUntil ? `Valid until ${quote.validUntil}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const queued = await this.omnichannel.queueToContact(
      user,
      {
        to: quote.phone,
        purpose: 'service',
        body: caption,
        templateName: dto.templateName,
        languageCode: dto.languageCode,
      },
      { storageKey: doc.storageKey, filename: doc.filename, mimeType: 'application/pdf' },
      // `get` above already held the caller to this quote.
      { recordAuthorised: true },
    );

    await this.audit.record(user, {
      action: 'quotes.pdf_queued',
      entityType: 'Quote',
      entityId: id,
      storeId: quote.originStoreId,
      summary: `Quote ${quote.ref} PDF queued for WhatsApp`,
      metadata: { revision: doc.revision, messageId: queued.message.id },
    });

    return {
      queued: true,
      ref: quote.ref,
      revision: doc.revision,
      messageId: queued.message.id,
      status: queued.message.status,
      deduplicated: queued.deduplicated,
      policy: queued.policy,
      // Not connected means the job will fail and say why — never "sent".
      dryRun: !(await this.whatsapp.enabledFor(user.organisationId)),
    };
  }

  /**
   * Render the PDF for the revision the gate just cleared, and keep a private
   * copy. The quote is re-read here; if it moved on since the gate looked, the
   * PDF is refused rather than printed for a revision nobody cleared.
   */
  private async issuePdf(user: AuthUser, id: string, gate: ApprovalGate) {
    const organisationId = user.organisationId;
    const q = await this.prisma.quote.findFirst({
      where: { id, organisationId },
      include: { lines: true },
    });
    if (!q) throw new NotFoundException('Quote not found');
    if (q.revision !== gate.revision) {
      throw new ConflictException('This quote changed a moment ago. Open it again.');
    }
    const [store, org] = await Promise.all([
      this.prisma.store.findFirst({
        where: { id: q.storeId, organisationId },
        select: {
          name: true, city: true, addressLine1: true, addressLine2: true, state: true,
          pincode: true, phone: true, gstin: true,
        },
      }),
      this.prisma.organisation.findUnique({
        where: { id: organisationId },
        select: { name: true, legalName: true, gstin: true },
      }),
    ]);
    const view = toView(q);
    const buffer = await renderQuotePdf({
      business: {
        name: org?.legalName || org?.name || 'Quotation',
        branch: store?.name ?? '',
        address: [
          store?.addressLine1,
          store?.addressLine2,
          [store?.city, store?.state, store?.pincode].filter(Boolean).join(', '),
        ].filter((line): line is string => !!line),
        phone: store?.phone ?? null,
        gstin: store?.gstin || org?.gstin || null,
      },
      ref: q.ref,
      revision: q.revision,
      createdAt: view.createdAt,
      validUntil: view.validUntil || null,
      customer: { name: q.customerName, phone: q.phone ?? '' },
      kind: q.kind,
      isKaccha: q.isKaccha,
      remarks: q.remarks ?? '',
      lines: view.lines,
      makingDiscountPercent: view.makingDiscountPercent,
      stoneDiscountPercent: view.stoneDiscountPercent,
      totals: view.totals,
      // Printed only when a decision was actually needed and given for this
      // revision; a quote that never needed one is not "approved".
      approval:
        gate.required && gate.cleared && q.approvedTotal != null
          ? {
              approvedTotal: Number(q.approvedTotal),
              decidedAt: q.decidedAt ? q.decidedAt.toISOString().slice(0, 10) : null,
            }
          : null,
      generatedAt: new Date(),
    });

    const storageKey = await this.storage.savePrivate(
      organisationId,
      'quote-pdfs',
      `${q.id}-r${q.revision}.pdf`,
      buffer,
    );
    return {
      buffer,
      storageKey,
      filename: `${q.ref}-r${q.revision}.pdf`,
      revision: q.revision,
      grandTotal: Number(q.grandTotal),
    };
  }

  /**
   * PATCH /quotes/:id — re-price a quote.
   *
   * Any accepted edit bumps the revision and, for a quote that was in the
   * approval flow, sends it back to draft. The gate would refuse the new
   * revision anyway; resetting the status keeps the screen from calling a
   * quote "Approved" that nobody approved in this form.
   */
  async update(user: AuthUser, id: string, dto: UpdateQuoteDto) {
    const view = await this.get(user, id); // same visibility as the quote screen
    this.scope.assertStoreAllowed(user, view.originStoreId);
    if (view.status === 'accepted') {
      throw new BadRequestException('This quote has become an order and can no longer be edited.');
    }

    const current = await this.prisma.quote.findFirstOrThrow({
      where: { id, organisationId: user.organisationId },
      include: { lines: true },
    });
    const lines: QuoteLineDto[] = dto.lines ?? current.lines.map(lineInput);
    const t = computeTotals(
      lines,
      current.kind,
      discountsFrom(dto, {
        making: Number(current.makingDiscountPercent),
        stone: Number(current.stoneDiscountPercent),
        additional: Number(current.additionalDiscount),
      }),
    );
    if (current.isKaccha) {
      t.gst = 0;
      t.grandTotal = t.taxable;
    }
    // Touching the price makes it this person's price, judged against their caps.
    const repriced =
      dto.lines !== undefined ||
      dto.discountPercent !== undefined ||
      dto.makingDiscountPercent !== undefined ||
      dto.stoneDiscountPercent !== undefined ||
      dto.additionalDiscount !== undefined;
    const reset = approvalResetFor(current.status);

    let updated;
    try {
      updated = await this.prisma.quote.update({
        // Conditional on the revision read above, so two edits cannot both
        // claim to be the next revision.
        where: { id, revision: current.revision },
        data: {
          ...reset,
          ...totalsData(t),
          revision: { increment: 1 },
          ...(repriced ? { pricedById: user.id, pricedByRole: user.role } : {}),
          ...(dto.validUntil !== undefined
            ? { validUntil: dto.validUntil ? new Date(dto.validUntil) : null }
            : {}),
          ...(dto.remarks !== undefined ? { remarks: dto.remarks } : {}),
          ...(dto.lines ? { lines: { deleteMany: {}, create: dto.lines.map(lineData) } } : {}),
        },
        include: { assignedRep: true, lines: true, redeemableStores: true, photos: true },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new ConflictException('Someone else edited this quote just now. Open it again.');
      }
      throw e;
    }

    const invalidated = Object.keys(reset).length > 0;
    await this.audit.record(user, {
      action: invalidated ? 'quotes.approval_invalidated' : 'quotes.edited',
      entityType: 'Quote',
      entityId: id,
      storeId: current.storeId,
      summary: invalidated
        ? `Quote ${current.ref} edited after ${current.status.replace('_', ' ')}; approval withdrawn`
        : `Quote ${current.ref} edited`,
      metadata: {
        fromRevision: current.revision,
        toRevision: updated.revision,
        previousStatus: current.status,
        previousTotal: current.grandTotal.toString(),
        total: updated.grandTotal.toString(),
        discountPercent: t.discountPercent,
        previousApproval: invalidated ? current.approvalSnapshot : null,
      },
    });

    return toView(updated);
  }

  /**
   * A salesperson's quotes are the ones assigned to them (the rep a quote is
   * created for). By id, a colleague's reads as absent, so re-pricing, sharing,
   * the PDF and converting to an order all follow.
   */
  private ownQuotes(user: AuthUser): Prisma.QuoteWhereInput {
    return isSalesScoped(user) ? { assignedRepId: user.id } : {};
  }

  async list(user: AuthUser, headerStore?: string, includeKaccha = false) {
    // "@" kaccha provision: rough no-GST estimates are hidden from the normal
    // list. Only head_office may opt back in (includeKaccha); any non-HO request
    // keeps them hidden regardless of the flag.
    const showKaccha = includeKaccha && isAllStoreRole(user.role);
    const where: Prisma.QuoteWhereInput = {
      ...this.scope.storeFilter(user, headerStore),
      ...this.ownQuotes(user),
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
      where: { id, ...this.scope.storeFilter(user), ...this.ownQuotes(user) },
      include: { assignedRep: true, lines: true, redeemableStores: true, photos: true },
    });
    if (!q) throw new NotFoundException('Quote not found');
    // "@" kaccha quotes are HO-only: don't reveal them by ref to anyone else.
    if (q.isKaccha && !isAllStoreRole(user.role)) throw new NotFoundException('Quote not found');
    return toView(q);
  }

  async create(user: AuthUser, dto: CreateQuoteDto) {
    this.scope.assertStoreAllowed(user, dto.storeId);
    await this.scope.assertTradingStore(dto.storeId);
    const kind = dto.kind ?? QuoteKind.sale;
    const isKaccha = dto.isKaccha ?? false;
    const t = computeTotals(dto.lines, kind, discountsFrom(dto));
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
        ...totalsData(t),
        // The discount is judged against THIS person's cap.
        pricedById: user.id,
        pricedByRole: user.role,
        lines: { create: dto.lines.map(lineData) },
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
      where: { id, ...this.scope.storeFilter(user), ...this.ownQuotes(user) },
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
      where: { id, ...this.scope.storeFilter(user), ...this.ownQuotes(user) },
      include: { lines: true },
    });
    if (!q) throw new NotFoundException('Quote not found');
    this.scope.assertStoreAllowed(user, q.storeId);

    const item = q.lines[0]?.description ?? 'Custom piece';
    // The item type and size are on the quote now; the booking only fills a gap.
    const category = orderCategory(item);
    const itemSize = q.lines[0]?.size ?? null;

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
        category,
        details: orderDetails(q.lines) || null,
        stage: OrderStatus.booked,
        stageEnteredAt: now,
        ownerRole: 'salesperson',
        ownerName: user.name,
        bookedOn: now,
        ringSize: dto.ringSize ?? (category === ProductCategory.ring ? itemSize : null),
        bangleSize: dto.bangleSize ?? (category === ProductCategory.bangle ? itemSize : null),
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
