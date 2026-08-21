import { Global, Module } from '@nestjs/common';
import { IntegrationsController } from './integrations.controller';
import { WhatsAppService } from './whatsapp.service';
import { RazorpayService } from './razorpay.service';
import { GoldRateService } from './gold-rate.service';
import { EmailService } from './email.service';
import { WhatsAppBotModule } from '../whatsapp-bot/whatsapp-bot.module';

/**
 * External integrations (Phase 4): WhatsApp Business, Razorpay, gold-rate feed,
 * SMTP email. @Global so feature modules (quotes, payments, loyalty, reporting)
 * can inject these services directly without re-importing the module.
 *
 * Imports WhatsAppBotModule so the inbound webhook can route messages to the bot.
 * (WhatsAppBotModule injects WhatsAppService via the global export above — no cycle.)
 */
@Global()
@Module({
  imports: [WhatsAppBotModule],
  controllers: [IntegrationsController],
  providers: [WhatsAppService, RazorpayService, GoldRateService, EmailService],
  exports: [WhatsAppService, RazorpayService, GoldRateService, EmailService],
})
export class IntegrationsModule {}
