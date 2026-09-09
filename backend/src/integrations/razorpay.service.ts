import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { fetchJson, safeEqual } from './integrations.util';

export interface PaymentLinkInput {
  /** Amount in rupees (converted to paise for Razorpay). */
  amount: number;
  customerName: string;
  phone?: string;
  email?: string;
  description?: string;
  /** Required: which store the eventual Payment row is attributed to. */
  storeId: string;
  partyId?: string;
  saleId?: string;
  schemeMemberId?: string;
  /** Where Razorpay redirects the payer after success. */
  callbackUrl?: string;
}

export interface PaymentLinkResult {
  dryRun: boolean;
  id: string;
  shortUrl: string;
  amount: number;
  status: string;
}

/**
 * Razorpay client — payment-link collection (Module 12) and gold-savings scheme
 * installments (Module 17). Code-complete behind RAZORPAY_KEY_ID/SECRET: until
 * they're set, `createPaymentLink` returns a stub link (`dryRun`) so the flow can
 * be exercised end-to-end. Webhooks are signature-verified and idempotently
 * recorded as Payment rows.
 */
@Injectable()
export class RazorpayService {
  private readonly logger = new Logger(RazorpayService.name);
  private readonly base = 'https://api.razorpay.com/v1';

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  private get keyId(): string {
    return this.config.get<string>('RAZORPAY_KEY_ID') ?? '';
  }
  private get keySecret(): string {
    return this.config.get<string>('RAZORPAY_KEY_SECRET') ?? '';
  }
  private get webhookSecret(): string {
    return this.config.get<string>('RAZORPAY_WEBHOOK_SECRET') ?? '';
  }

  /** True when API keys are configured (otherwise payment links are stubbed). */
  get enabled(): boolean {
    return Boolean(this.keyId && this.keySecret);
  }

  private authHeader(): string {
    return 'Basic ' + Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64');
  }

  /** Create a hosted payment link. Returns a stub link when not yet configured. */
  async createPaymentLink(input: PaymentLinkInput): Promise<PaymentLinkResult> {
    const amountPaise = Math.round(input.amount * 100);
    // Attribution carried through Razorpay back to us via the webhook `notes`.
    const notes: Record<string, string> = { storeId: input.storeId };
    if (input.partyId) notes.partyId = input.partyId;
    if (input.saleId) notes.saleId = input.saleId;
    if (input.schemeMemberId) notes.schemeMemberId = input.schemeMemberId;

    if (!this.enabled) {
      this.logger.log(`[dry-run] Razorpay payment link ₹${input.amount} for ${input.customerName}`);
      return {
        dryRun: true,
        id: `plink_dryrun_${amountPaise}`,
        shortUrl: 'https://rzp.io/i/dry-run-link',
        amount: input.amount,
        status: 'created',
      };
    }

    const res = await fetchJson(`${this.base}/payment_links`, {
      method: 'POST',
      headers: { authorization: this.authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({
        amount: amountPaise,
        currency: 'INR',
        accept_partial: false,
        description: input.description ?? 'CaratSense payment',
        customer: {
          name: input.customerName,
          ...(input.email ? { email: input.email } : {}),
          ...(input.phone ? { contact: input.phone } : {}),
        },
        notify: { sms: Boolean(input.phone), email: Boolean(input.email) },
        reminder_enable: true,
        notes,
        ...(input.callbackUrl
          ? { callback_url: input.callbackUrl, callback_method: 'get' }
          : {}),
      }),
    });
    return {
      dryRun: false,
      id: res.id,
      shortUrl: res.short_url,
      amount: amountPaise / 100,
      status: res.status,
    };
  }

  /** Verify X-Razorpay-Signature: HMAC-SHA256 of the raw body with the webhook secret. */
  verifyWebhookSignature(rawBody: Buffer | undefined, signature?: string): boolean {
    if (!this.webhookSecret) {
      this.logger.warn('RAZORPAY_WEBHOOK_SECRET not set — rejecting webhook.');
      return false;
    }
    if (!rawBody || !signature) return false;
    const expected = createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
    return safeEqual(expected, signature);
  }

  /**
   * Handle a signature-verified webhook event. On a captured payment / paid link
   * we record a Payment row, attributed via the `notes` set at link creation.
   * Idempotent on the Razorpay payment id (stored as Payment.reference).
   */
  async handleWebhook(event: any): Promise<{ handled: boolean; reason?: string }> {
    const type = event?.event as string | undefined;
    if (type !== 'payment.captured' && type !== 'payment_link.paid' && type !== 'order.paid') {
      return { handled: false, reason: `ignored event ${type ?? 'unknown'}` };
    }

    const payment = event?.payload?.payment?.entity;
    if (!payment?.id) return { handled: false, reason: 'no payment entity' };

    const notes = {
      ...(event?.payload?.payment_link?.entity?.notes ?? {}),
      ...(payment.notes ?? {}),
    } as Record<string, string>;
    const storeId = notes.storeId;
    if (!storeId) {
      this.logger.warn(`Razorpay payment ${payment.id} has no storeId note — cannot attribute.`);
      return { handled: false, reason: 'missing storeId note' };
    }

    const reference = payment.id as string;

    // Org comes from the store the payment is attributed to — never from the
    // webhook notes.
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { organisationId: true },
    });
    if (!store) {
      this.logger.warn(`Razorpay payment ${payment.id} references unknown store ${storeId}.`);
      return { handled: false, reason: 'unknown store' };
    }
    const organisationId = store.organisationId;

    // Scoped to the resolved organisation (Phase B2). This was a GLOBAL lookup on
    // `reference` — a column that, for hand-entered collections, holds the payer's
    // NAME. One tenant's walk-in could therefore suppress another tenant's
    // webhook, and the dedupe depended on a business row existing at all.
    const existing = await this.prisma.payment.findFirst({
      where: { organisationId, reference },
      select: { id: true },
    });
    if (existing) return { handled: true, reason: 'already recorded' };

    // OWNERSHIP CHECK ON EVERY NOTE (Phase B2).
    //
    // `notes` are echoed back by Razorpay from whatever was set at link creation.
    // They were previously written into the Payment row unverified, so a note
    // naming another tenant's sale would have attached this money to that
    // tenant's invoice — a cross-tenant write arriving through a signed,
    // apparently-trustworthy webhook.
    //
    // A note that does not resolve inside this organisation is DROPPED, not
    // rejected: the money genuinely arrived and must be recorded. Losing the
    // link is recoverable by hand; losing the payment is not.
    const [party, sale, schemeMember] = await Promise.all([
      this.ownedOrNull('party', notes.partyId, organisationId),
      this.ownedOrNull('sale', notes.saleId, organisationId),
      this.ownedOrNull('schemeMember', notes.schemeMemberId, organisationId),
    ]);
    for (const [field, given, resolved] of [
      ['partyId', notes.partyId, party],
      ['saleId', notes.saleId, sale],
      ['schemeMemberId', notes.schemeMemberId, schemeMember],
    ] as const) {
      if (given && !resolved) {
        this.logger.warn(
          `Razorpay payment ${payment.id}: note ${field}=${given} is not in organisation ${organisationId} — recorded without it.`,
        );
      }
    }

    await this.prisma.payment.create({
      data: {
        organisationId,
        storeId,
        partyId: party,
        saleId: sale,
        schemeMemberId: schemeMember,
        reference,
        mode: 'online',
        amount: payment.amount / 100,
        paidAt: payment.created_at ? new Date(payment.created_at * 1000) : new Date(),
        reconciled: false,
      },
    });
    this.logger.log(
      `Recorded Razorpay payment ${reference} (₹${payment.amount / 100}) for store ${storeId}`,
    );
    return { handled: true };
  }

  /**
   * Return the id only if that record exists INSIDE the given organisation.
   *
   * Deliberately returns null rather than throwing: this runs on a webhook, and
   * an unrecognised reference is a reason to record the payment unlinked, not a
   * reason to reject money that has already changed hands.
   */
  private async ownedOrNull(
    model: 'party' | 'sale' | 'schemeMember',
    id: string | undefined,
    organisationId: string,
  ): Promise<string | null> {
    if (!id) return null;
    const client = this.prisma as unknown as Record<
      string,
      { findFirst(args: unknown): Promise<{ id: string } | null> }
    >;
    const found = await client[model]
      .findFirst({ where: { id, organisationId }, select: { id: true } })
      .catch(() => null);
    return found?.id ?? null;
  }

}
