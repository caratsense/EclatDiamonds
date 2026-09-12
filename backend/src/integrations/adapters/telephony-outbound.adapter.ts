import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { IntegrationsRegistryService } from '../../integration/framework/integrations-registry.service';
import {
  ChannelDeliverability,
  OutboundChannelAdapter,
  OutboundSendInput,
  OutboundSendResult,
  unavailable,
} from './outbound.contract';
import { OutboundHttp, OutboundHttpError } from './outbound-http';

/**
 * Placing a call (Block 13).
 *
 * ## Status: FIXTURE-TESTED, NOT LIVE, AND VENDOR-NEUTRAL BY NECESSITY
 *
 * The inbound half of telephony is real and tested: a missed call becomes a
 * customer, an enquiry and a follow-up task. Outbound was never built, and the
 * five-minute SLA has a switch (`autoCallOnBreach`) that has always reported
 * itself blocked because nothing could dial.
 *
 * There is no such thing as "the" telephony API. Exotel, Knowlarity, Twilio,
 * Ozonetel and every on-premise PRI gateway differ in their URL, their auth and
 * their field names, and none of them is provisioned here. So this adapter does
 * NOT pretend to know one. It requires the tenant to declare three things on
 * their own integration row:
 *
 *   config.outboundCallUrl   where to POST, https only
 *   config.outboundCallMap   which field names carry from/to (optional)
 *   capabilities.outboundCall === true
 *
 * That is an honest arrangement rather than a fake one: the tenant's own
 * provider is mapped onto a normalised request, exactly as the inbound webhook
 * already asks them to map onto a normalised payload. Until they do, this
 * reports `unavailable` with the missing piece named — and the SLA's auto-call
 * switch keeps saying so instead of silently doing nothing.
 *
 * ## Why it is not a `send`
 *
 * A call is not a message: nothing is delivered, a person is connected. The
 * result reports `delivered: true` when the provider ACCEPTED the request to
 * dial, which is all any telephony API can tell you synchronously, and the
 * reason field says so. Whether anybody answered arrives later on the inbound
 * webhook as a disposition — the half that is real.
 */

export const TELEPHONY_PROVIDER_CODE = 'telephony';

@Injectable()
export class TelephonyOutboundAdapter implements OutboundChannelAdapter {
  readonly channel = 'voice' as const;
  private readonly log = new Logger(TelephonyOutboundAdapter.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: IntegrationsRegistryService,
    private readonly http: OutboundHttp,
  ) {}

  async deliverability(organisationId: string): Promise<ChannelDeliverability> {
    const integration = await this.prisma.integration.findFirst({
      where: { organisationId, providerCode: TELEPHONY_PROVIDER_CODE },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, status: true, config: true, capabilities: true },
    });
    if (!integration) {
      return unavailable(
        this.channel,
        'no_integration',
        'No telephony provider is connected, so no call can be placed.',
      );
    }
    if (integration.status === 'disabled') {
      return unavailable(
        this.channel,
        'not_connected',
        `The "${integration.name}" telephony connection is switched off.`,
      );
    }

    const caps = asRecord(integration.capabilities);
    if (caps.outboundCall !== true) {
      return {
        channel: this.channel,
        state: 'unavailable',
        code: 'capability_missing',
        reason:
          `"${integration.name}" receives call notifications but has not been marked as able ` +
          'to place them. Outbound dialling is a separate product with most Indian providers, ' +
          'and claiming it without it being enabled would make the SLA report calls it never made.',
        verified: false,
        capabilities: { inboundNotification: true, outboundCall: false },
      };
    }

    const config = asRecord(integration.config);
    const url = typeof config.outboundCallUrl === 'string' ? config.outboundCallUrl.trim() : '';
    if (!url) {
      return unavailable(
        this.channel,
        'not_configured',
        'This telephony connection can place calls but no dialling endpoint has been set. ' +
          'There is no single telephony API to guess at, so the URL has to come from your provider.',
      );
    }
    if (!/^https:\/\//i.test(url)) {
      return unavailable(
        this.channel,
        'not_configured',
        'The dialling endpoint must be https. A call request carries the API credential and ' +
          'both customer numbers, and it will not be sent over plain http.',
      );
    }
    const key = await this.registry
      .credentialFor(organisationId, integration.id, 'api_key')
      .catch(() => null);
    if (!key) {
      return unavailable(
        this.channel,
        'no_credential',
        'This telephony connection has no API key saved, so a dial request cannot be authenticated.',
      );
    }

    return {
      channel: this.channel,
      state: 'live',
      code: 'ready',
      reason: `Ready to request a call through "${integration.name}".`,
      // No live provider has ever accepted a dial request from this adapter.
      verified: false,
      capabilities: { inboundNotification: true, outboundCall: true },
    };
  }

  /**
   * Ask the provider to connect two numbers.
   *
   * `input.to` is the customer. `input.extra.from` is the agent or the branch
   * line; without it the provider is expected to use its own default caller id,
   * which is a provider setting rather than something to invent here.
   */
  async send(organisationId: string, input: OutboundSendInput): Promise<OutboundSendResult> {
    const state = await this.deliverability(organisationId);
    if (state.state !== 'live') {
      return { delivered: false, dryRun: true, reason: state.reason, channel: this.channel };
    }

    const integration = await this.prisma.integration.findFirst({
      where: { organisationId, providerCode: TELEPHONY_PROVIDER_CODE },
      orderBy: { createdAt: 'asc' },
      select: { id: true, config: true },
    });
    const config = asRecord(integration?.config);
    const url = String(config.outboundCallUrl ?? '');
    const key = integration
      ? await this.registry.credentialFor(organisationId, integration.id, 'api_key')
      : null;
    if (!integration || !url || !key) {
      return {
        delivered: false,
        dryRun: true,
        reason: 'The telephony connection changed while this call was being placed.',
        channel: this.channel,
      };
    }

    // The tenant's own field names, because theirs are the ones their provider
    // reads. Defaults match the most common shape; a mapping that is wrong
    // produces a provider refusal with a readable reason rather than silence.
    const map = asRecord(config.outboundCallMap);
    const toField = typeof map.to === 'string' && map.to ? map.to : 'To';
    const fromField = typeof map.from === 'string' && map.from ? map.from : 'From';
    const from = typeof input.extra?.from === 'string' ? input.extra.from : null;

    try {
      const response = await this.http.postJson(
        url,
        { authorization: `Bearer ${key}` },
        {
          [toField]: input.to,
          ...(from ? { [fromField]: from } : {}),
          // Passed through so a tenant whose provider needs a caller-id or a
          // flow id can supply it without a code change. Never merged over the
          // mapped fields above.
          ...extraFields(input.extra),
        },
      );
      if (!response.ok) {
        return {
          delivered: false,
          dryRun: false,
          error: OutboundHttp.redact(OutboundHttp.providerMessage(response.body), response.status),
          reason: 'The telephony provider refused the call request.',
          channel: this.channel,
        };
      }
      return {
        delivered: true,
        dryRun: false,
        externalId: callId(response.body),
        // Said plainly: accepting a dial request is not a conversation. Whether
        // anybody picked up arrives later on the inbound webhook.
        reason: 'The provider accepted the request to dial. Whether the call connects is reported later.',
        channel: this.channel,
      };
    } catch (error) {
      const message =
        error instanceof OutboundHttpError ? error.message : 'The call request failed.';
      this.log.warn(`Outbound call failed for organisation ${organisationId}: ${message}`);
      return { delivered: false, dryRun: false, error: message, channel: this.channel };
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Scalar passthrough only. An object here would be a provider payload nobody validated. */
function extraFields(extra: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!extra) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extra)) {
    if (key === 'from') continue;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key)) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
}

function callId(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const row = body as Record<string, unknown>;
  for (const key of ['Sid', 'sid', 'CallSid', 'call_id', 'callId', 'id']) {
    const value = row[key];
    if (typeof value === 'string' && value) return value;
  }
  // Providers commonly nest it one level under a Call/data envelope.
  for (const key of ['Call', 'call', 'data']) {
    const nested = row[key];
    if (nested && typeof nested === 'object') {
      const found = callId(nested);
      if (found) return found;
    }
  }
  return undefined;
}
