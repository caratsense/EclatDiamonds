import { Injectable, Logger } from '@nestjs/common';

import { AiProviderConfig } from '../../crm/ai/ai-provider-config';
import {
  ChannelDeliverability,
  OUTBOUND_CHANNELS,
  OutboundChannel,
  OutboundChannelAdapter,
  OutboundSendInput,
  OutboundSendResult,
} from './outbound.contract';
import { EmailOutboundAdapter } from './email-outbound.adapter';
import { InstagramAdapter } from './instagram.adapter';
import { TelephonyOutboundAdapter } from './telephony-outbound.adapter';
import { WhatsAppOutboundAdapter } from './whatsapp-outbound.adapter';

/**
 * The one place that knows which channels can carry a message (Block 13).
 *
 * ## Why a registry rather than a switch at each caller
 *
 * `evaluateDeliveryPolicy` decided this with `input.channel !== 'whatsapp'`. That
 * could not say WHY a channel was unavailable and could not tell one tenant from
 * another — a business that had connected Instagram and one that had not got the
 * same answer. Every caller that wanted a better answer would have grown its own
 * copy of the reasoning, and they would have disagreed.
 *
 * ## What it deliberately does NOT do
 *
 * It does not decide whether a message SHOULD be sent. Consent, the 24-hour
 * customer-care window and template approval stay in the omnichannel policy,
 * which is where the tenant's rules live. This answers only "is there a working
 * path", so a provider swap can never quietly change who is allowed to be
 * messaged.
 *
 * ## Honesty
 *
 * Three of the four adapters have never had a response from a live provider.
 * That is carried per channel in `verified` and repeated in the report this
 * exposes, rather than being inferred from a saved credential.
 */
@Injectable()
export class ChannelAdaptersService {
  private readonly log = new Logger(ChannelAdaptersService.name);
  private readonly adapters: Map<OutboundChannel, OutboundChannelAdapter>;

  constructor(
    whatsapp: WhatsAppOutboundAdapter,
    instagram: InstagramAdapter,
    email: EmailOutboundAdapter,
    voice: TelephonyOutboundAdapter,
    private readonly ai: AiProviderConfig,
  ) {
    this.adapters = new Map(
      [whatsapp, instagram, email, voice].map((a) => [a.channel, a] as const),
    );
  }

  /** Null for a channel with no adapter at all, which is not the same as "off". */
  adapterFor(channel: string): OutboundChannelAdapter | null {
    return this.adapters.get(channel as OutboundChannel) ?? null;
  }

  /**
   * Can this tenant send on this channel right now?
   *
   * A channel with no adapter answers `unavailable`/`no_integration` rather than
   * throwing: a queued message can name a channel an older release supported,
   * and the outbox has to be able to record that rather than crash on it.
   */
  async deliverability(
    organisationId: string,
    channel: string,
  ): Promise<ChannelDeliverability> {
    const adapter = this.adapterFor(channel);
    if (!adapter) {
      return {
        channel: (channel || 'unknown') as OutboundChannel,
        state: 'unavailable',
        code: 'no_integration',
        reason: `There is no outbound adapter for "${channel || 'unknown'}" in this release.`,
        verified: false,
      };
    }
    try {
      return await adapter.deliverability(organisationId);
    } catch (error) {
      // A broken read must not read as "connected". Fail closed and say so.
      this.log.error(
        `Could not determine ${channel} deliverability for ${organisationId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        channel: adapter.channel,
        state: 'unavailable',
        code: 'provider_unavailable',
        reason: 'This channel’s state could not be read just now, so nothing will be sent on it.',
        verified: false,
      };
    }
  }

  async send(
    organisationId: string,
    channel: string,
    input: OutboundSendInput,
  ): Promise<OutboundSendResult> {
    const adapter = this.adapterFor(channel);
    if (!adapter) {
      return {
        delivered: false,
        dryRun: true,
        reason: `There is no outbound adapter for "${channel || 'unknown'}" in this release.`,
        channel: (channel || 'unknown') as OutboundChannel,
      };
    }
    return adapter.send(organisationId, input);
  }

  /**
   * Every channel's honest state, plus the AI's.
   *
   * One payload because the question an operator has is "what works", not "does
   * Instagram work" — and because the answer for one channel changes what they
   * should do about another (an unverified email domain is why the marketing
   * campaign they are about to build will not send).
   */
  async report(organisationId: string) {
    const channels = await Promise.all(
      OUTBOUND_CHANNELS.map((channel) => this.deliverability(organisationId, channel)),
    );
    return {
      channels,
      /** Channels that will actually reach somebody today. */
      liveChannels: channels.filter((c) => c.state === 'live').map((c) => c.channel),
      /**
       * Stated separately from `liveChannels` because the difference matters: a
       * dry run means the code is finished and nothing leaves, which is a
       * configuration task, while unavailable can mean provisioning that takes
       * weeks (an app review, a DLT registration).
       */
      dryRunChannels: channels.filter((c) => c.state === 'dry_run').map((c) => c.channel),
      ai: this.ai.describe(),
      /**
       * NOT A DISCLAIMER — a fact the rest of the report depends on. Every
       * adapter here constructs the request its provider documents and is driven
       * end to end in the tests, and none of them has had a response from a live
       * provider. `verified` is false everywhere until one does.
       */
      verification: {
        anyVerified: channels.some((c) => c.verified),
        note:
          'These adapters are fixture-tested: the request each provider documents is built ' +
          'and exercised in full against a test transport. None has yet had a successful ' +
          'response from a live provider, so none is reported as verified.',
      },
    };
  }
}
