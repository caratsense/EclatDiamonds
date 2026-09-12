/**
 * What an outbound channel adapter has to be able to say about itself.
 *
 * ## Why this exists
 *
 * Before it, "can this tenant send on Instagram?" was answered in one place by
 * `input.channel !== 'whatsapp'`. That was honest while WhatsApp was the only
 * adapter, and it has two failure modes the moment a second one exists: it
 * cannot say WHY a channel is unavailable, and it cannot tell one tenant apart
 * from another — a tenant who has connected Instagram and one who has not get
 * the same answer.
 *
 * ## The three states, and why there are three and not two
 *
 *   live         A real provider will be called and can accept this.
 *   dry_run      The code path is complete and will run, but nothing leaves the
 *                building — no credential, or the environment is fenced. The
 *                caller is told, and the message is NOT recorded as sent.
 *   unavailable  There is no working path at all. Refused before any work.
 *
 * Collapsing `dry_run` into either of the others is the specific dishonesty this
 * whole file exists to prevent. Calling it `live` reports deliveries that never
 * happened; calling it `unavailable` hides a code path that is genuinely
 * finished and testable, and makes the remaining work look larger than it is.
 *
 * ## A note on what "provider-ready" means here
 *
 * Every adapter below constructs the real request its provider documents and is
 * driven end to end in the tests against an injected transport. NONE of them has
 * had a response from a live provider. That distinction is carried in the
 * `verified` flag and must not be quietly dropped: an adapter that has never
 * spoken to its provider is ready to be tried, not proven.
 */

export const OUTBOUND_CHANNELS = ['whatsapp', 'instagram', 'email', 'voice'] as const;
export type OutboundChannel = (typeof OUTBOUND_CHANNELS)[number];

export type DeliveryState = 'live' | 'dry_run' | 'unavailable';

export interface ChannelDeliverability {
  channel: OutboundChannel;
  state: DeliveryState;
  /**
   * Machine-readable, so a screen can group failures and a test can assert on
   * one without matching prose.
   */
  code:
    | 'ready'
    | 'no_integration'
    | 'not_connected'
    | 'no_credential'
    | 'capability_missing'
    | 'not_configured'
    | 'provider_unavailable';
  /** Always a sentence a settings screen can show verbatim. */
  reason: string;
  /**
   * FALSE until a real provider has answered this adapter successfully. Never
   * set true by a fixture, a saved credential, or an operator ticking a box.
   */
  verified: boolean;
  /** What this channel can do for this tenant, as the tenant's own row states. */
  capabilities?: Record<string, boolean>;
}

export interface OutboundSendInput {
  /** Channel-specific recipient: a phone number, an IG user id, an address. */
  to: string;
  body?: string;
  /** The branch this is on behalf of, for senders that are routed per branch. */
  storeId?: string | null;
  /** The conversation's own sender, where one is pinned. */
  assetId?: string | null;
  subject?: string;
  /** Free-form provider payload for a channel that needs more than text. */
  extra?: Record<string, unknown>;
}

export interface OutboundSendResult {
  delivered: boolean;
  /** True when the path ran but nothing left the building. Never 'delivered'. */
  dryRun: boolean;
  /** The provider's own id, when one came back. Absent on a dry run. */
  externalId?: string;
  /** Why nothing was sent. Present whenever `delivered` is false. */
  reason?: string;
  /** A bounded, redacted provider error. Never a token or a raw response body. */
  error?: string;
  /** Which channel answered, so a caller logging this need not remember. */
  channel: OutboundChannel;
}

export interface OutboundChannelAdapter {
  readonly channel: OutboundChannel;
  /** Can this tenant send here, and if not, why. Reads the tenant's own rows. */
  deliverability(organisationId: string): Promise<ChannelDeliverability>;
  /**
   * Send one message.
   *
   * MUST NOT THROW for an unavailable channel or a provider failure — both are
   * ordinary outcomes a caller has to record. Reserve throwing for a programming
   * error, so the outbox can distinguish "this will never work" from "the
   * process is broken".
   */
  send(organisationId: string, input: OutboundSendInput): Promise<OutboundSendResult>;
}

/** The unavailable answer, in one place so every adapter shapes it the same. */
export function unavailable(
  channel: OutboundChannel,
  code: ChannelDeliverability['code'],
  reason: string,
): ChannelDeliverability {
  return { channel, state: 'unavailable', code, reason, verified: false };
}
