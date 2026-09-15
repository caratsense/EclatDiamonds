import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../auth/public.decorator';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { StoreHeader } from '../common/store-header.decorator';
import { StoreScopeService } from '../common/store-scope.service';
import { parseRawJson } from './integrations.util';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppCredentialsService } from './whatsapp-credentials.service';
import { WebhookIntakeService } from './webhook-intake.service';
import { RazorpayService } from './razorpay.service';
import { GoldRateService } from './gold-rate.service';
import { EmailService } from './email.service';
import {
  CreatePaymentLinkDto,
  RegisterMetaAssetDto,
  SendWhatsAppDto,
} from './dto/integrations.dto';
import { SetGoldRateDto } from './dto/gold-rate.dto';
import { RateLimit } from '../common/rate-limit';
import { MetaWebhookService } from './meta-webhook.service';
import { MetaHealthService } from './meta-health.service';
import { MetaAssetOwnershipService } from './meta-asset-ownership.service';
import { TelephonyService } from './telephony.service';
import { TelephonyWebhookDto } from './dto/telephony.dto';
import { OmnichannelService } from '../omnichannel/omnichannel.service';

/**
 * External integration endpoints (Phase 4). Provider webhooks are @Public (no JWT)
 * but authenticated by their own signature/verify-token; everything else requires
 * a logged-in user. All actions degrade to safe no-ops until credentials are set.
 */
// Provider webhooks and machine traffic — sized for machines, not people.
// The tenant bucket would be wrong here: a busy Saturday of delivery receipts
// is normal, and must not consume the staff's own allowance.
@RateLimit('integration')
@Controller('integrations')
export class IntegrationsController {
  constructor(
    private readonly whatsapp: WhatsAppService,
    private readonly razorpay: RazorpayService,
    private readonly goldRate: GoldRateService,
    private readonly email: EmailService,
    private readonly scope: StoreScopeService,
    private readonly whatsappCredentials: WhatsAppCredentialsService,
    private readonly intake: WebhookIntakeService,
    private readonly metaWebhook: MetaWebhookService,
    private readonly metaAssets: MetaAssetOwnershipService,
    private readonly metaHealth: MetaHealthService,
    private readonly omnichannel: OmnichannelService,
    private readonly telephony: TelephonyService,
  ) {}

  /**
   * Which integrations are live for THIS organisation.
   *
   * WhatsApp is now per-tenant, so it is resolved for the caller's organisation
   * rather than reported as a property of the deployment. The others remain
   * platform-level today and are labelled as such by the registry.
   */
  @Get('status')
  async status(@CurrentUser() user: AuthUser) {
    return {
      whatsapp: await this.whatsapp.enabledFor(user.organisationId),
      razorpay: this.razorpay.enabled,
      goldRate: this.goldRate.enabled,
      email: this.email.enabled,
    };
  }

  /** WhatsApp sender detail for the settings screen. Never returns a secret. */
  // Management information: store manager and above, never a salesperson.
  @Roles('store_manager')
  @Get('whatsapp/sender')
  whatsappSender(@CurrentUser() user: AuthUser) {
    return this.whatsappCredentials.describeFor(user.organisationId);
  }

  // ── WhatsApp ────────────────────────────────────────────────────────────────

  /**
   * Send a quote/reminder/DSR message (text inside the 24h window, else template).
   *
   * CONTRACT CHANGE (deliberate). This used to call the provider directly and
   * return its acceptance inline. It bypassed consent, opt-out, the 24-hour
   * customer-care window, provider template approval, the outbox and the audit
   * trail — so a store manager could message a customer who had answered STOP,
   * and nothing recorded that it happened.
   *
   * It now queues through the same policy as every other outbound message. The
   * response therefore reports what is TRUE at that moment — the message is
   * accepted and queued — instead of claiming a delivery that has not happened
   * yet. `delivered` is kept in the body for old callers, and is honest: false
   * until the provider says otherwise. Poll the outbox, or read the receipt.
   *
   * Backward compatibility stops where it would reinstate the bypass, which is
   * the one thing this endpoint may not do.
   */
  @Roles('store_manager', 'head_office')
  @Post('whatsapp/send')
  async sendWhatsApp(@CurrentUser() user: AuthUser, @Body() dto: SendWhatsAppDto) {
    const queued = await this.omnichannel.queueToContact(user, {
      to: dto.to,
      purpose: dto.purpose ?? 'service',
      body: dto.body,
      templateName: dto.template,
      languageCode: dto.languageCode,
      templateComponents: dto.components,
      idempotencyKey: dto.idempotencyKey,
    });
    return {
      delivered: false,
      queued: true,
      status: queued.message.status,
      messageId: queued.message.id,
      conversationId: queued.message.conversationId,
      jobId: queued.job?.id ?? null,
      deduplicated: queued.deduplicated,
      mode: queued.policy.mode,
    };
  }

  /** Meta webhook verification handshake. Returns the echoed challenge as text. */
  @Public()
  @Get('whatsapp/webhook')
  verifyWhatsApp(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ) {
    const result = this.whatsapp.verifyWebhook(mode, token, challenge);
    if (result == null) throw new ForbiddenException('verification failed');
    return result;
  }

  /** Inbound messages + delivery statuses (signature-verified). */
  @Public()
  @Post('whatsapp/webhook')
  @HttpCode(200)
  receiveWhatsApp(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature?: string,
  ) {
    if (!this.whatsapp.verifySignature(req.rawBody, signature)) {
      throw new ForbiddenException('invalid signature');
    }
    if (!req.rawBody) throw new ForbiddenException('raw webhook body unavailable');
    // WebhookEvent is written before WhatsAppEvent/CRM processing. The bot still
    // performs its own per-message wamid dedupe because one envelope may contain
    // many messages and Meta may redeliver them in a different envelope.
    return this.metaWebhook.receiveWhatsApp(req.rawBody);
  }

  // -- Meta Lead Ads -------------------------------------------------------

  /** Separate verify token so two Meta apps can never authenticate each other. */
  @Public()
  @Get('meta/webhook')
  verifyMeta(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ) {
    const result = this.metaWebhook.verifyLeadAdsChallenge(mode, token, challenge);
    if (result == null) throw new ForbiddenException('verification failed');
    return result;
  }

  /** Persist a signed leadgen notification, then enqueue the Graph fetch. */
  @Public()
  @Post('meta/webhook')
  @HttpCode(200)
  receiveMeta(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature?: string,
  ) {
    if (!this.metaWebhook.verifyLeadAdsSignature(req.rawBody, signature)) {
      throw new ForbiddenException('invalid signature');
    }
    if (!req.rawBody) throw new ForbiddenException('raw webhook body unavailable');
    return this.metaWebhook.receiveLeadAds(req.rawBody);
  }

  /** Save only a non-secret provider id; the access token uses encrypted storage. */
  @Roles('head_office')
  @Post('meta/assets')
  registerMetaAsset(@CurrentUser() user: AuthUser, @Body() dto: RegisterMetaAssetDto) {
    return this.metaAssets.register(user, dto);
  }

  // ── Telephony / IVR ─────────────────────────────────────────────────────────

  /**
   * Issue this tenant's telephony webhook token. Shown once; head office only.
   *
   * Paste it into the provider's webhook settings as the
   * `x-caratos-telephony-token` header. Rotating invalidates the previous one
   * immediately, which is what rotating is for.
   */
  @Roles('head_office')
  @Post('telephony/webhook-token')
  rotateTelephonyToken(@CurrentUser() user: AuthUser) {
    return this.telephony.rotateWebhookToken(user);
  }

  /**
   * An inbound call, from a telephony / IVR provider.
   *
   * @Public because a provider carries no session. The TOKEN is both the
   * authentication and the tenant resolution — there is no other way to know
   * whose call this is, and an unauthenticated body that opens leads would be
   * an open write endpoint on somebody else's CRM.
   *
   * Persist-then-process, keyed per TENANT as well as per call: two tenants
   * whose providers happen to mint the same call id must not silence each
   * other's second delivery.
   */
  @Public()
  @Post('telephony/webhook')
  @HttpCode(200)
  async receiveTelephony(
    @Body() dto: TelephonyWebhookDto,
    @Headers('x-caratos-telephony-token') token?: string,
  ) {
    const auth = await this.telephony.authenticate(token);
    return this.intake.intake(
      {
        providerCode: 'telephony',
        externalId: `${auth.organisationId}:${dto.callId}`,
        /*
         * The flag intake actually reads is "was this delivery authenticated?"
         * — a false one is recorded and DISCARDED unprocessed, which is right
         * for an unsigned Meta payload and wrong here. This provider has no
         * HMAC scheme; the shared token above is its authentication, and it was
         * checked before this call. The field's name is narrower than its job.
         */
        signatureVerified: true,
        payload: dto as unknown,
        // No headers. The only one that matters here authenticates as the
        // tenant, and a stored copy of it would be a stored credential.
        headers: {},
      },
      () => this.telephony.receive(auth, dto),
    );
  }

  // ── Razorpay ────────────────────────────────────────────────────────────────

  /** Create a hosted payment link for a collection / scheme installment. */
  @Post('razorpay/payment-link')
  createPaymentLink(@Body() dto: CreatePaymentLinkDto, @CurrentUser() user: AuthUser) {
    this.scope.assertStoreAllowed(user, dto.storeId);
    return this.razorpay.createPaymentLink(dto);
  }

  /** Razorpay event webhook (signature-verified; records captured payments). */
  @Public()
  @Post('razorpay/webhook')
  @HttpCode(200)
  receiveRazorpay(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-razorpay-signature') signature?: string,
    @Headers('x-razorpay-event-id') eventId?: string,
  ) {
    const verified = this.razorpay.verifyWebhookSignature(req.rawBody, signature);
    if (!verified) throw new ForbiddenException('invalid signature');

    const payload = parseRawJson(req.rawBody);
    // Persist-then-process (Phase B2). Razorpay sends `x-razorpay-event-id`, so
    // a redelivery is recognisable and becomes a no-op instead of a second
    // payment row. Previously the only defence was "is there already a Payment
    // with this reference", which left a failed event with no trace at all.
    return this.intake.intake(
      {
        providerCode: 'razorpay',
        externalId: eventId ?? null,
        signatureVerified: verified,
        payload,
        // Signature and authorization headers are deliberately NOT stored.
        headers: { 'x-razorpay-event-id': eventId ?? '' },
      },
      () => this.razorpay.handleWebhook(payload),
    );
  }

  // ── Gold rate ───────────────────────────────────────────────────────────────

  /**
   * Current metal rates (INR/g) for the active store — used to prefill quotes.
   *
   * `@Roles('salesperson')` is EXPLICIT rather than absent, and it admits every
   * authenticated member of the tenant (the role guard rolls up). That is
   * deliberate: the quote builder is the main consumer and salespeople are the
   * people who build quotes, so raising this to store_manager would break the
   * counter workflow it exists for. The decorator is here so that "any member of
   * this tenant" is a recorded decision instead of an omission — which is how it
   * read before, being the one route in this controller with no role line at all.
   *
   * The gap that actually mattered was tenancy, not role: this served live gold
   * rates to a pharmacy as readily as to a jeweller. That is now closed by
   * EntitlementGuard, which maps /integrations/gold-rate to the `settings/rates`
   * capability — a screen only the jewellery pack enables.
   */
  @Roles('salesperson')
  @Get('gold-rate')
  goldRates(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.goldRate.currentRates(user.organisationId, store);
  }

  /** Pull a fresh rate from the configured feed (managers and above). */
  @Roles('store_manager', 'head_office')
  @Post('gold-rate/refresh')
  refreshGoldRates(@CurrentUser() user: AuthUser) {
    return this.goldRate.refresh(user.organisationId);
  }

  /**
   * Set today's gold rate by hand (managers and above). The reliable daily-update
   * path when no live feed is configured — the manager enters the morning rate
   * and every quote built today prefills off it. See GoldRateService.setManual.
   */
  @Roles('store_manager', 'head_office')
  @Post('gold-rate')
  setGoldRate(@Body() dto: SetGoldRateDto, @CurrentUser() user: AuthUser) {
    return this.goldRate.setManual(dto, user.organisationId);
  }

  /**
   * What state is this integration actually in?
   *
   * Read-only and provider-free: it reports what the last check found, including
   * how long ago that was. It never returns a token, and it never upgrades a
   * stored credential into "connected" — only `checkMetaHealth` below can do
   * that, and only on evidence.
   */
  @Roles('head_office')
  @Get('meta/:id/health')
  metaHealthState(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.metaHealth.describe(user, id);
  }

  /** Run a live ownership check against the provider and record the result. */
  @Roles('head_office')
  @Post('meta/:id/health/check')
  checkMetaHealth(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.metaHealth.check(user, id);
  }
}
