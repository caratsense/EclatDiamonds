import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';

import { HumansOnly } from '../auth/machine.decorator';
import { Roles } from '../auth/roles.decorator';
import { AuthUser, CurrentUser } from '../common/auth-user';
import {
  QueueOmnichannelMessageDto,
  RecordConsentDto,
  UpsertMessageTemplateDto,
} from './dto/omnichannel.dto';
import { MessagePurpose, OmnichannelChannel, OMNICHANNEL_CHANNELS } from './omnichannel-policy';
import { OmnichannelService } from './omnichannel.service';
import { TemplateSyncService } from './template-sync.service';

/** Human control-plane for consent, templates and the delivery outbox. */
@HumansOnly()
@Controller('omnichannel')
export class OmnichannelController {
  constructor(
    private readonly omnichannel: OmnichannelService,
    private readonly templateSync: TemplateSyncService,
  ) {}

  @Post('consents')
  recordConsent(@CurrentUser() user: AuthUser, @Body() dto: RecordConsentDto) {
    return this.omnichannel.recordConsent(user, dto);
  }

  @Get('consents/:partyId')
  consent(
    @CurrentUser() user: AuthUser,
    @Param('partyId') partyId: string,
    @Query('channel') channel = 'whatsapp',
    @Query('purpose') purpose = 'marketing',
  ) {
    if (!(OMNICHANNEL_CHANNELS as readonly string[]).includes(channel)) {
      channel = 'whatsapp';
    }
    if (purpose !== 'service' && purpose !== 'marketing') purpose = 'marketing';
    return this.omnichannel.consentFor(
      user,
      partyId,
      channel as OmnichannelChannel,
      purpose as MessagePurpose,
    );
  }

  @Get('templates')
  templates(@CurrentUser() user: AuthUser, @Query('integrationId') integrationId?: string) {
    return this.omnichannel.listTemplates(user, integrationId);
  }

  @Roles('head_office')
  @Post('integrations/:integrationId/templates')
  upsertTemplate(
    @CurrentUser() user: AuthUser,
    @Param('integrationId') integrationId: string,
    @Body() dto: UpsertMessageTemplateDto,
  ) {
    return this.omnichannel.upsertTemplate(user, integrationId, dto);
  }

  /**
   * Refresh template approval from the provider now. Head office only, and
   * audited: it is the act that decides what may leave the building.
   */
  @Roles('head_office')
  @Post('integrations/:integrationId/templates/sync')
  syncTemplates(
    @CurrentUser() user: AuthUser,
    @Param('integrationId') integrationId: string,
  ) {
    return this.templateSync.syncNow(user, integrationId);
  }

  /** Queue the same sync as a durable background job. */
  @Roles('head_office')
  @Post('integrations/:integrationId/templates/sync/queue')
  queueTemplateSync(
    @CurrentUser() user: AuthUser,
    @Param('integrationId') integrationId: string,
  ) {
    return this.templateSync.schedule(user, integrationId);
  }

  @Get('outbox')
  outbox(
    @CurrentUser() user: AuthUser,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    return this.omnichannel.listOutbox(user, {
      status,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Roles('store_manager', 'head_office')
  @Post('outbox/sweep')
  sweep(@CurrentUser() user: AuthUser) {
    return this.omnichannel.sweepQueued(user.organisationId);
  }

  @Post('outbox/:messageId/retry')
  retry(@CurrentUser() user: AuthUser, @Param('messageId') messageId: string) {
    return this.omnichannel.retryMessage(user, messageId);
  }

  @Post('conversations/:conversationId/messages')
  queue(
    @CurrentUser() user: AuthUser,
    @Param('conversationId') conversationId: string,
    @Body() dto: QueueOmnichannelMessageDto,
  ) {
    return this.omnichannel.queue(user, conversationId, dto);
  }
}

