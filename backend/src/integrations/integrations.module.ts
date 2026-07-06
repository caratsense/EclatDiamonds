import { Global, Module } from '@nestjs/common';
import { IntegrationsController } from './integrations.controller';
import { WhatsAppService } from './whatsapp.service';
import { RazorpayService } from './razorpay.service';
import { GoldRateService } from './gold-rate.service';
import { EmailService } from './email.service';

/**
 * External integrations (Phase 4): WhatsApp Business, Razorpay, gold-rate feed,
 * SMTP email. @Global so feature modules (quotes, payments, loyalty, reporting)
 * can inject these services directly without re-importing the module.
 */
@Global()
@Module({
  controllers: [IntegrationsController],
  providers: [WhatsAppService, RazorpayService, GoldRateService, EmailService],
  exports: [WhatsAppService, RazorpayService, GoldRateService, EmailService],
})
export class IntegrationsModule {}
