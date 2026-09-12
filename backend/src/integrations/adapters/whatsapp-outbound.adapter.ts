import { Injectable } from '@nestjs/common';

import { WhatsAppService } from '../whatsapp.service';
import { WhatsAppCredentialsService } from '../whatsapp-credentials.service';
import {
  ChannelDeliverability,
  OutboundChannelAdapter,
  OutboundSendInput,
  OutboundSendResult,
} from './outbound.contract';

/**
 * WhatsApp, through the registry (Block 13).
 *
 * Deliberately thin. WhatsApp already has a complete sender and a resolver that
 * decides which of a tenant's numbers carries a message; re-implementing any of
 * that here would give the product two places that can answer "who is this being
 * sent as", and they would disagree within a release.
 *
 * What this adds is that WhatsApp appears in the SAME registry as the others, so
 * the omnichannel gate can ask one question of every channel instead of
 * hardcoding `channel !== 'whatsapp'`. That hardcode was honest while WhatsApp
 * was the only adapter and became a lie the moment a second one existed: it
 * could not say why a channel was unavailable, and it gave the same answer to a
 * tenant who had connected Instagram and one who had not.
 */
@Injectable()
export class WhatsAppOutboundAdapter implements OutboundChannelAdapter {
  readonly channel = 'whatsapp' as const;

  constructor(
    private readonly whatsapp: WhatsAppService,
    private readonly credentials: WhatsAppCredentialsService,
  ) {}

  async deliverability(organisationId: string): Promise<ChannelDeliverability> {
    const sender = await this.credentials.senderFor(organisationId);
    if (sender.usable) {
      return {
        channel: this.channel,
        state: 'live',
        code: 'ready',
        reason: sender.shared
          ? 'Sending on the platform number, which is not this organisation’s own.'
          : `Sending on the organisation’s own number (chosen: ${sender.resolvedBy}).`,
        // A stored token is not proof the provider accepts it. MetaHealthService
        // is what proves that, and it is a separate deliberate check.
        verified: false,
        capabilities: { text: true, template: true, media: false },
      };
    }
    /*
     * DRY RUN, NOT UNAVAILABLE — and the distinction is load-bearing.
     *
     * `unavailable` in this contract means there is no code path. WhatsApp's
     * path is complete and has been for a long time: with no credential the
     * sender logs what it would have sent and returns `dryRun`, and the outbox
     * records that reason against the message. The whole product runs that way
     * on a machine with no Meta account, which is how anybody develops against
     * it.
     *
     * Classifying it as unavailable would refuse the message at the policy gate
     * instead, so an assistant reply would never be queued and the outbox would
     * have nothing in it to look at. That is a worse answer than a queued
     * message that plainly says it was not delivered and why.
     *
     * The resolver's own sentence is carried through, because it knows whether
     * the problem is no connection, an expired token, or eight numbers and no
     * branch route — and each of those has a different fix.
     */
    return {
      channel: this.channel,
      state: 'dry_run',
      code: sender.scope === 'none' ? 'no_integration' : 'no_credential',
      reason: sender.reason ?? 'No WhatsApp sender is configured.',
      verified: false,
      capabilities: { text: true, template: true, media: false },
    };
  }

  async send(organisationId: string, input: OutboundSendInput): Promise<OutboundSendResult> {
    if (!input.body?.trim()) {
      return {
        delivered: false,
        dryRun: false,
        reason: 'A WhatsApp message needs text.',
        channel: this.channel,
      };
    }
    const result = await this.whatsapp.sendText(organisationId, input.to, input.body.trim(), {
      assetId: input.assetId ?? null,
      storeId: input.storeId ?? null,
    });
    return {
      delivered: result.delivered,
      dryRun: result.dryRun,
      externalId: result.messageId,
      reason: result.reason,
      error: result.error,
      channel: this.channel,
    };
  }
}
