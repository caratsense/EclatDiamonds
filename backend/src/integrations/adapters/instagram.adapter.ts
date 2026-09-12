import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

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
 * Instagram Direct, outbound (Block 13).
 *
 * ## Status: FIXTURE-TESTED, NOT LIVE
 *
 * The request below is the one Meta's Messenger Platform documents for an
 * Instagram professional account: `POST /{ig-user-id}/messages` with
 * `{ recipient: { id }, message: { text } }` and the Page token as a bearer.
 * It is constructed in full and driven end to end in the tests against an
 * injected transport.
 *
 * NO INSTAGRAM ACCOUNT HAS EVER ANSWERED IT. Sending requires a reviewed Meta
 * app with `instagram_manage_messages`, an Instagram professional account linked
 * to a Facebook Page, and the customer having messaged first — none of which is
 * provisioned. So `deliverability` reports `unavailable` with that as the reason
 * until a tenant connects one, and `verified` stays false even then until a real
 * send succeeds.
 *
 * ## Why the 24-hour rule is not enforced here
 *
 * Instagram has its own messaging window, and it is a POLICY question the
 * omnichannel gate already owns for WhatsApp. Re-deciding it inside a provider
 * adapter would put the same rule in two places and let a provider swap change
 * who is allowed to be messaged. This adapter answers "can this leave" and
 * nothing about "should it".
 */

export const INSTAGRAM_PROVIDER_CODE = 'instagram';

/** The asset kind a tenant registers for an Instagram professional account. */
const IG_ACCOUNT_KIND = 'instagram_account';

@Injectable()
export class InstagramAdapter implements OutboundChannelAdapter {
  readonly channel = 'instagram' as const;
  private readonly log = new Logger(InstagramAdapter.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: IntegrationsRegistryService,
    private readonly http: OutboundHttp,
    private readonly config: ConfigService,
  ) {}

  async deliverability(organisationId: string): Promise<ChannelDeliverability> {
    const integration = await this.prisma.integration.findFirst({
      where: { organisationId, providerCode: INSTAGRAM_PROVIDER_CODE },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        status: true,
        assets: {
          where: { kind: IG_ACCOUNT_KIND, isActive: true },
          select: { externalId: true, providerOwnershipVerified: true },
          take: 1,
        },
      },
    });

    if (!integration) {
      return unavailable(
        this.channel,
        'no_integration',
        'Instagram Direct is not connected. It needs a reviewed Meta app with ' +
          'instagram_manage_messages and a professional account linked to a Facebook Page, ' +
          'which is an app-review process rather than a setting.',
      );
    }
    if (integration.status === 'disabled') {
      return unavailable(
        this.channel,
        'not_connected',
        `The "${integration.name}" Instagram connection is switched off.`,
      );
    }
    const account = integration.assets[0];
    if (!account) {
      return unavailable(
        this.channel,
        'capability_missing',
        'An Instagram connection exists but no professional account has been registered against it.',
      );
    }
    const token = await this.registry
      .credentialFor(organisationId, integration.id, 'access_token')
      .catch(() => null);
    if (!token) {
      return unavailable(
        this.channel,
        'no_credential',
        'The Instagram connection has no access token saved, so nothing can be sent.',
      );
    }
    if (!this.graphVersion()) {
      return unavailable(
        this.channel,
        'not_configured',
        'META_GRAPH_API_VERSION is not set to an explicit version, so no Graph call can be made. ' +
          'A version is never guessed: the request shape changes between them.',
      );
    }

    return {
      channel: this.channel,
      state: 'live',
      code: 'ready',
      reason: `Ready to send from the registered Instagram account on "${integration.name}".`,
      // STILL FALSE. A saved token and a registered account are what a tenant
      // typed; only a successful provider response is evidence, and this adapter
      // has never had one.
      verified: account.providerOwnershipVerified,
      capabilities: { text: true, media: false },
    };
  }

  async send(organisationId: string, input: OutboundSendInput): Promise<OutboundSendResult> {
    const state = await this.deliverability(organisationId);
    if (state.state !== 'live') {
      // Not an error. "This channel is not connected" is an ordinary outcome the
      // outbox records against the message, and throwing would make it look like
      // the process was broken.
      return { delivered: false, dryRun: true, reason: state.reason, channel: this.channel };
    }
    if (!input.body?.trim()) {
      return {
        delivered: false,
        dryRun: false,
        reason: 'An Instagram message needs text.',
        channel: this.channel,
      };
    }

    const integration = await this.prisma.integration.findFirst({
      where: { organisationId, providerCode: INSTAGRAM_PROVIDER_CODE },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        assets: {
          where: { kind: IG_ACCOUNT_KIND, isActive: true },
          select: { externalId: true },
          take: 1,
        },
      },
    });
    const accountId = integration?.assets[0]?.externalId;
    const token = integration
      ? await this.registry.credentialFor(organisationId, integration.id, 'access_token')
      : null;
    if (!integration || !accountId || !token) {
      // The state above said live, so reaching here means the rows changed
      // underneath us. Report it rather than sending a half-formed request.
      return {
        delivered: false,
        dryRun: true,
        reason: 'The Instagram connection changed while this message was being sent.',
        channel: this.channel,
      };
    }

    const url = `https://graph.facebook.com/${this.graphVersion()}/${accountId}/messages`;
    try {
      const response = await this.http.postJson(
        url,
        { authorization: `Bearer ${token}` },
        {
          recipient: { id: input.to },
          message: { text: input.body.trim() },
          // Instagram requires the tag on anything outside the window; the
          // omnichannel gate decides whether we are inside it, so this adapter
          // sends a plain RESPONSE and lets the provider refuse if the gate was
          // wrong. Better a refusal than a message tagged to slip past a rule.
          messaging_type: 'RESPONSE',
        },
      );
      if (!response.ok) {
        return {
          delivered: false,
          dryRun: false,
          error: OutboundHttp.redact(OutboundHttp.providerMessage(response.body), response.status),
          reason: 'Instagram refused the message.',
          channel: this.channel,
        };
      }
      const externalId = messageId(response.body);
      if (!externalId) {
        // A 200 with no message id is not a delivery. Recording it as one would
        // leave a message nobody can trace or reconcile a receipt against.
        return {
          delivered: false,
          dryRun: false,
          reason: 'Instagram accepted the request but returned no message id.',
          channel: this.channel,
        };
      }
      return { delivered: true, dryRun: false, externalId, channel: this.channel };
    } catch (error) {
      const message =
        error instanceof OutboundHttpError ? error.message : 'The Instagram request failed.';
      this.log.warn(`Instagram send failed for organisation ${organisationId}: ${message}`);
      return { delivered: false, dryRun: false, error: message, channel: this.channel };
    }
  }

  /** Never defaulted: the Graph request shape changes between versions. */
  private graphVersion(): string | null {
    const version = this.config.get<string>('META_GRAPH_API_VERSION')?.trim() ?? '';
    return /^v\d{1,3}\.\d{1,2}$/.test(version) ? version : null;
  }
}

function messageId(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const row = body as Record<string, unknown>;
  const id = row.message_id ?? row.id;
  return typeof id === 'string' && id ? id : undefined;
}
