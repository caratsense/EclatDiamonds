import { Module } from '@nestjs/common';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { WhatsAppBotController } from './whatsapp-bot.controller';
import { WhatsAppBotScheduler } from './whatsapp-bot.scheduler';
import { WhatsAppBotService } from './whatsapp-bot.service';
import { WhatsAppIdentityService } from './whatsapp-identity.service';

/**
 * The internal WhatsApp reporting bot (store <-> head office).
 *
 * Phase 1: identity — link/verify/revoke a number <-> user binding, and route an
 * inbound coded message to complete a link. Injects the global WhatsAppService
 * (transport), PrismaService, StoreScopeService and AuditService, so no module
 * imports are needed here. Exported so IntegrationsModule (webhook) and
 * UsersModule (revoke-on-deactivate) can use these services.
 */
@Module({
  imports: [SchedulerModule],
  controllers: [WhatsAppBotController],
  providers: [WhatsAppBotService, WhatsAppIdentityService, WhatsAppBotScheduler],
  exports: [WhatsAppBotService, WhatsAppIdentityService],
})
export class WhatsAppBotModule {}
