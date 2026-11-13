import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';

import { HumansOnly } from '../auth/machine.decorator';
import { Roles } from '../auth/roles.decorator';
import { AuthUser, CurrentUser } from '../common/auth-user';
import {
  QueueOmnichannelMessageDto,
  RecordConsentDto,
  StartWhatsAppThreadDto,
  SubmitMessageTemplateDto,
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
   * Write a new template to Meta and put it in for review.
   *
   * Head office only and audited, for the same reason the sync below is: this
   * creates something that will carry the business's name into a customer's
   * WhatsApp, and Meta judges the whole account on what it says.
   *
   * Approval is not a side effect of this call. The template comes back PENDING
   * and stays unsendable until TemplateSyncService reads APPROVED from Meta.
   */
  @Roles('head_office')
  @Post('integrations/:integrationId/templates/submit')
  submitTemplate(
    @CurrentUser() user: AuthUser,
    @Param('integrationId') integrationId: string,
    @Body() dto: SubmitMessageTemplateDto,
  ) {
    return this.templateSync.submit(user, integrationId, dto);
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

  // Management information: store manager and above, never a salesperson.
  @Roles('store_manager')
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

  // Management information: store manager and above, never a salesperson.
  @Roles('store_manager')
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

  /**
   * Message a number that has never written in.
   *
   * The gap this closes: every send door needed a conversation to already
   * exist, which meant the customer had to message first. A salesperson
   * holding a lead's phone number — the ordinary case — could record that they
   * had messaged on WhatsApp but could not actually do it from here.
   *
   * No new permission or delivery path. `queueToContact` is the same call the
   * quote PDF has always made, so consent, STOP, the 24-hour window, template
   * approval, the outbox and the audit trail all apply exactly as they do
   * there. It finds the contact point or creates it, which is what turns a
   * bare number into a thread.
   *
   * The conversation id comes back on the message so the caller can open the
   * thread it just started rather than hunting for it in the list.
   */
  @Post('messages')
  async startThread(@CurrentUser() user: AuthUser, @Body() dto: StartWhatsAppThreadDto) {
    const queued = await this.omnichannel.queueToContact(user, {
      to: dto.to,
      purpose: dto.purpose as MessagePurpose,
      body: dto.body,
      templateName: dto.templateName,
      languageCode: dto.languageCode,
      templateComponents: dto.templateComponents,
      idempotencyKey: dto.idempotencyKey,
    });
    return {
      conversationId: queued.message.conversationId,
      messageId: queued.message.id,
      status: queued.message.status,
      deduplicated: queued.deduplicated,
      policy: queued.policy,
    };
  }
}

