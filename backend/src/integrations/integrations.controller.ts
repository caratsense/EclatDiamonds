import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
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
import { RazorpayService } from './razorpay.service';
import { GoldRateService } from './gold-rate.service';
import { EmailService } from './email.service';
import { CreatePaymentLinkDto, SendWhatsAppDto } from './dto/integrations.dto';
import { SetGoldRateDto } from './dto/gold-rate.dto';
import { WhatsAppBotService } from '../whatsapp-bot/whatsapp-bot.service';

/**
 * External integration endpoints (Phase 4). Provider webhooks are @Public (no JWT)
 * but authenticated by their own signature/verify-token; everything else requires
 * a logged-in user. All actions degrade to safe no-ops until credentials are set.
 */
@Controller('integrations')
export class IntegrationsController {
  constructor(
    private readonly whatsapp: WhatsAppService,
    private readonly razorpay: RazorpayService,
    private readonly goldRate: GoldRateService,
    private readonly email: EmailService,
    private readonly scope: StoreScopeService,
    private readonly bot: WhatsAppBotService,
  ) {}

  /** Which integrations are live (credentials present) on this deploy. */
  @Get('status')
  status() {
    return {
      whatsapp: this.whatsapp.enabled,
      razorpay: this.razorpay.enabled,
      goldRate: this.goldRate.enabled,
      email: this.email.enabled,
    };
  }

  // ── WhatsApp ────────────────────────────────────────────────────────────────

  /** Send a quote/reminder/DSR message (text inside the 24h window, else template). */
  @Roles('store_manager', 'head_office')
  @Post('whatsapp/send')
  sendWhatsApp(@Body() dto: SendWhatsAppDto) {
    if (dto.template) {
      return this.whatsapp.sendTemplate(dto.to, dto.template, dto.languageCode, dto.components);
    }
    return this.whatsapp.sendText(dto.to, dto.body ?? '');
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
    // Store the messages and acknowledge; the bot handles them straight after,
    // off the request. Meta retries anything it does not get a prompt 200 for,
    // and a redelivered daily report must not become a second row.
    return this.bot.ingest(parseRawJson(req.rawBody));
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
  ) {
    if (!this.razorpay.verifyWebhookSignature(req.rawBody, signature)) {
      throw new ForbiddenException('invalid signature');
    }
    return this.razorpay.handleWebhook(parseRawJson(req.rawBody));
  }

  // ── Gold rate ───────────────────────────────────────────────────────────────

  /** Current metal rates (INR/g) for the active store — used to prefill quotes. */
  @Get('gold-rate')
  goldRates(@StoreHeader() store?: string) {
    return this.goldRate.currentRates(store);
  }

  /** Pull a fresh rate from the configured feed (managers and above). */
  @Roles('store_manager', 'head_office')
  @Post('gold-rate/refresh')
  refreshGoldRates() {
    return this.goldRate.refresh();
  }

  /**
   * Set today's gold rate by hand (managers and above). The reliable daily-update
   * path when no live feed is configured — the manager enters the morning rate
   * and every quote built today prefills off it. See GoldRateService.setManual.
   */
  @Roles('store_manager', 'head_office')
  @Post('gold-rate')
  setGoldRate(@Body() dto: SetGoldRateDto) {
    return this.goldRate.setManual(dto);
  }
}
