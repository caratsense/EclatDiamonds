import { Global, Module } from '@nestjs/common';
import { IntegrationsController } from './integrations.controller';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppCredentialsService } from './whatsapp-credentials.service';
import { WebhookIntakeService } from './webhook-intake.service';
import { RazorpayService } from './razorpay.service';
import { GoldRateService } from './gold-rate.service';
import { EmailService } from './email.service';
import { WhatsAppBotModule } from '../whatsapp-bot/whatsapp-bot.module';
import { IntegrationModule } from '../integration/integration.module';
import { MetaAssetOwnershipService } from './meta-asset-ownership.service';
import { MetaGraphClient } from './meta-graph.client';
import { MetaLeadAdsService } from './meta-lead-ads.service';
import { MetaWebhookService } from './meta-webhook.service';
import { MetaDeliveryReceiptAdapter } from './meta-delivery-receipt.adapter';
import { MetaLeadAdapter } from './meta-lead.adapter';
import { MetaHealthService } from './meta-health.service';
import { TelephonyService } from './telephony.service';

/**
 * External integrations (Phase 4): WhatsApp Business, Razorpay, gold-rate feed,
 * SMTP email. @Global so feature modules (quotes, payments, loyalty, reporting)
 * can inject these services directly without re-importing the module.
 *
 * Imports WhatsAppBotModule so the inbound webhook can route messages to the bot.
 * (WhatsAppBotModule injects WhatsAppService via the global export above — the
 * import edge is one-directional, so there is no module cycle.)
 */
@Global()
@Module({
  imports: [WhatsAppBotModule, IntegrationModule],
  controllers: [IntegrationsController],
  providers: [
    WhatsAppService,
    WhatsAppCredentialsService,
    WebhookIntakeService,
    RazorpayService,
    GoldRateService,
    EmailService,
    MetaAssetOwnershipService,
    MetaGraphClient,
    MetaLeadAdsService,
    MetaWebhookService,
    // Registers itself with MetaWebhookService on init and forwards verified
    // WhatsApp status events to the omnichannel outbox. Provided, never injected
    // by anyone: its whole job is the onModuleInit side effect.
    MetaDeliveryReceiptAdapter,
    // Registers itself with MetaLeadAdsService on init and turns a verified Meta
    // lead submission into CRM records. Provided, never injected: its whole job
    // is the onModuleInit side effect.
    MetaLeadAdapter,
    MetaHealthService,
    // Injects IdentityService and LeadIntakeService, which CrmModule exports
    // as @Global — the same edge MetaLeadAdapter already relies on, and it
    // runs one way only (integrations reach into CRM; CRM never reaches back).
    TelephonyService,
  ],
  exports: [
    WhatsAppService,
    WhatsAppCredentialsService,
    WebhookIntakeService,
    RazorpayService,
    GoldRateService,
    EmailService,
    MetaAssetOwnershipService,
    MetaGraphClient,
    MetaLeadAdsService,
    MetaWebhookService,
    TelephonyService,
  ],
})
export class IntegrationsModule {}
