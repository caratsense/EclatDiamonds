export const OMNICHANNEL_CHANNELS = [
  'whatsapp',
  'instagram',
  'email',
  'sms',
  'web',
] as const;

export type OmnichannelChannel = (typeof OMNICHANNEL_CHANNELS)[number];
export type MessagePurpose = 'service' | 'marketing';
export type ConsentState = 'granted' | 'revoked' | 'unknown';

export interface DeliveryPolicyInput {
  channel: string;
  purpose: MessagePurpose;
  consent: ConsentState;
  hasApprovedTemplate: boolean;
  lastInboundAt?: Date | null;
  now?: Date;
}

export type DeliveryPolicyDecision =
  | { allowed: true; mode: 'free_text' | 'template' }
  | {
      allowed: false;
      code:
        | 'channel_not_connected'
        | 'consent_required'
        | 'recipient_opted_out'
        | 'template_required';
      reason: string;
    };

const WHATSAPP_CUSTOMER_CARE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Keywords that mean "stop messaging me" ON THEIR OWN, as the whole message.
 *
 * WhatsApp, and every SMS regulator, treat a bare STOP as a withdrawal of
 * consent, so these are matched only when they are the entire message (after
 * trimming punctuation and case). "stop" inside a sentence is not a match, which
 * is the point: "where is the nearest bus stop", "stop by tomorrow?" and "please
 * don't stop making these" are ordinary customer messages and opting those
 * senders out would silently cost the tenant a conversation they never chose to
 * end.
 */
const OPT_OUT_KEYWORDS: ReadonlySet<string> = new Set([
  'stop',
  'stopall',
  'unsubscribe',
  'end',
  'quit',
  'cancel',
  'optout',
  'opt out',
  'remove me',
  'stop messaging me',
  'stop messages',
  'do not contact me',
  "don't contact me",
  'no more messages',
]);

/**
 * Phrases unambiguous enough to honour even inside a longer sentence.
 *
 * Kept deliberately short and explicit. Anything that could plausibly appear in
 * a message that is NOT a withdrawal of consent belongs in the exact-match set
 * above instead — a false positive here silences a customer who never asked to
 * be silenced, and only they can undo it.
 */
const OPT_OUT_PHRASES: readonly string[] = [
  'unsubscribe me',
  'stop messaging me',
  'stop sending me messages',
  'do not contact me',
  "don't contact me",
  'do not message me',
  "don't message me",
  'remove me from your list',
  'remove my number',
  'take me off your list',
];

/**
 * Does this inbound message unambiguously withdraw consent?
 *
 * Detection is deliberately conservative and language-limited. It is NOT a
 * sentiment model and must never become one: "not interested" ends a sale, not a
 * relationship, and a customer who is merely annoyed has not asked to be
 * removed. Anything this returns false for still reaches a human in the inbox,
 * which is the correct destination for an ambiguous case; anything it returns
 * true for stops the assistant and blocks later marketing, and the customer
 * cannot easily reverse that themselves.
 */
export function isUnambiguousOptOut(body: string | null | undefined): boolean {
  if (!body) return false;
  // Collapse whitespace, drop surrounding punctuation and emoji-style trailers,
  // so "STOP." and "  stop  " read the same as "stop".
  const normalised = body
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .trim();
  if (!normalised) return false;
  if (OPT_OUT_KEYWORDS.has(normalised)) return true;
  return OPT_OUT_PHRASES.some((phrase) => normalised.includes(phrase));
}

/**
 * Provider-neutral policy at the last responsible moment before delivery.
 *
 * A screen may hide a send button, but the worker is the authority: queued
 * messages can come from an AI draft, an API retry, or an older application
 * version. Every path therefore reaches this function immediately before a
 * provider is called.
 */
export function evaluateDeliveryPolicy(input: DeliveryPolicyInput): DeliveryPolicyDecision {
  // WhatsApp is the only outbound adapter currently implemented. The schema is
  // channel-neutral, but calling another channel "sent" without a transport
  // would be materially worse than refusing it.
  if (input.channel !== 'whatsapp') {
    return {
      allowed: false,
      code: 'channel_not_connected',
      reason: `Outbound ${input.channel || 'unknown-channel'} delivery is not connected.`,
    };
  }

  if (input.consent === 'revoked') {
    return {
      allowed: false,
      code: 'recipient_opted_out',
      reason: 'The recipient has opted out of this channel and purpose.',
    };
  }

  // Marketing is opt-in, never inferred from a phone number, a purchase, or an
  // inbound enquiry. Service replies are permitted without a marketing grant,
  // but an explicit service/all-purpose revocation above still wins.
  if (input.purpose === 'marketing' && input.consent !== 'granted') {
    return {
      allowed: false,
      code: 'consent_required',
      reason: 'Recorded marketing consent is required before this message can be sent.',
    };
  }

  if (input.hasApprovedTemplate) return { allowed: true, mode: 'template' };

  const now = input.now ?? new Date();
  const lastInboundAt = input.lastInboundAt?.getTime();
  const insideCustomerCareWindow =
    lastInboundAt !== undefined &&
    lastInboundAt <= now.getTime() &&
    now.getTime() - lastInboundAt <= WHATSAPP_CUSTOMER_CARE_WINDOW_MS;

  if (!insideCustomerCareWindow) {
    return {
      allowed: false,
      code: 'template_required',
      reason: 'An approved WhatsApp template is required outside the 24-hour customer-care window.',
    };
  }

  return { allowed: true, mode: 'free_text' };
}


/* -------------------------------------------------------------------------
 * Template sendability (INT-08)
 * ---------------------------------------------------------------------- */

/**
 * The statuses Meta reports for a message template, plus two of ours.
 *
 * `REMOVED` is what a sync concludes when a template we hold is no longer in the
 * provider's list at all. `UNKNOWN` is the starting state and the state every
 * historical row falls back to: a template nobody has ever verified against the
 * provider is not approved, whatever an operator typed into a form.
 */
export const PROVIDER_TEMPLATE_STATUSES = [
  'APPROVED',
  'PENDING',
  'IN_APPEAL',
  'REJECTED',
  'PAUSED',
  'DISABLED',
  'PENDING_DELETION',
  'DELETED',
  'REMOVED',
  'UNKNOWN',
] as const;

export type ProviderTemplateStatus = (typeof PROVIDER_TEMPLATE_STATUSES)[number];

export function providerTemplateStatus(value: unknown): ProviderTemplateStatus {
  const raw = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return (PROVIDER_TEMPLATE_STATUSES as readonly string[]).includes(raw)
    ? (raw as ProviderTemplateStatus)
    : 'UNKNOWN';
}

/**
 * How long a provider verdict may be relied on before it has to be refreshed.
 *
 * Meta can pause a template for quality at any time and tells nobody. A verdict
 * we last confirmed a week ago is a guess, and this is a send that leaves the
 * building — so an old verdict fails closed rather than being trusted until the
 * next sweep happens to run.
 */
export const TEMPLATE_VERDICT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface TemplateSendability {
  sendable: boolean;
  /** Machine-readable, for the outbox and for a screen to group failures by. */
  code: 'sendable' | 'not_approved_by_provider' | 'never_verified' | 'verdict_stale' | 'inactive';
  reason: string;
}

/**
 * Whether a stored template may actually carry a message.
 *
 * The rule this replaces read one locally typed string: whoever filled in the
 * form chose `approved`, and that word authorised sending outside the 24-hour
 * customer-care window. Nothing reconciled it with Meta, and nothing expired it,
 * so a template Meta later paused stayed "approved" here for ever.
 *
 * Every branch below fails closed. A template is sendable only when the
 * provider itself said APPROVED, recently, and the row is still active.
 */
export function templateSendability(
  input: {
    isActive: boolean;
    providerStatus: ProviderTemplateStatus;
    providerSyncedAt: Date | null;
  },
  now: Date = new Date(),
  maxAgeMs: number = TEMPLATE_VERDICT_MAX_AGE_MS,
): TemplateSendability {
  if (!input.isActive) {
    return {
      sendable: false,
      code: 'inactive',
      reason: 'This template has been switched off for this connection.',
    };
  }
  if (!input.providerSyncedAt) {
    return {
      sendable: false,
      code: 'never_verified',
      reason:
        'This template has never been confirmed with the provider. Synchronise templates before sending.',
    };
  }
  if (input.providerStatus !== 'APPROVED') {
    return {
      sendable: false,
      code: 'not_approved_by_provider',
      reason: `The provider reports this template as ${input.providerStatus.toLowerCase().replace(/_/g, ' ')}.`,
    };
  }
  const age = now.getTime() - input.providerSyncedAt.getTime();
  if (age > maxAgeMs || age < 0) {
    return {
      sendable: false,
      code: 'verdict_stale',
      reason:
        'The provider approval for this template is out of date. Synchronise templates before sending.',
    };
  }
  return { sendable: true, code: 'sendable', reason: 'The provider approved this template.' };
}
