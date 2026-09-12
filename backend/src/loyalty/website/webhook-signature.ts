import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signing what we send to a tenant's website, and verifying what it sends back.
 *
 * ## Why the timestamp is inside the signed material
 *
 * An HMAC over the body alone proves the body was written by somebody holding
 * the secret. It does not prove WHEN. So anybody who once observed a valid
 * request — a proxy log, a browser extension, a misconfigured CDN — can replay
 * it for ever, and a replayed `redeem` is a second debit against a real
 * customer. The timestamp is therefore part of the signed string and the
 * verifier bounds its age. A body with a stale timestamp fails even though its
 * signature is arithmetically perfect, which is the point.
 *
 * ## Why the scheme is versioned
 *
 * `t=<unix seconds>,v1=<hex>` is the shape Stripe, GitHub and Slack all
 * converged on, and a tenant's engineer has almost certainly implemented it
 * before. More usefully, the `v1` label means a future algorithm can be added
 * alongside rather than replacing it: a header may carry several versions, and a
 * verifier accepts any it recognises. Changing the algorithm without a version
 * marker would break every receiver at once with no migration window.
 *
 * ## Why the comparison is constant-time
 *
 * `===` on two hex strings returns as soon as two bytes differ, so the time it
 * takes reveals how much of the signature the caller guessed correctly. Over
 * enough attempts that is a byte-at-a-time forgery. Length is compared first and
 * returns false, which leaks only the length — a value the scheme already
 * publishes.
 */

/** How old a signed request may be before a verifier refuses it. */
export const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;

const SCHEME = 'v1';

/**
 * The exact bytes both sides sign: `<unix seconds>.<raw body>`.
 *
 * The RAW body, not a re-serialised object. Two JSON encoders disagree about key
 * order and whitespace, so signing a parsed-then-restringified payload produces
 * a signature the sender cannot reproduce. Callers must hand over the same
 * string they put on the wire.
 */
function signedPayload(timestampSeconds: number, rawBody: string): string {
  return `${timestampSeconds}.${rawBody}`;
}

export interface SignedHeaders {
  /** The full header value, e.g. `t=1789171200,v1=ab12…`. */
  signature: string;
  timestamp: number;
}

/** Sign an outbound body. `at` is passed in so a test can pin the instant. */
export function signWebhook(secret: string, rawBody: string, at: Date = new Date()): SignedHeaders {
  if (!secret) throw new Error('Refusing to sign a webhook with an empty secret.');
  const timestamp = Math.floor(at.getTime() / 1000);
  const digest = createHmac('sha256', secret)
    .update(signedPayload(timestamp, rawBody), 'utf8')
    .digest('hex');
  return { signature: `t=${timestamp},${SCHEME}=${digest}`, timestamp };
}

export type VerifyFailure =
  | 'missing_header'
  | 'malformed_header'
  | 'no_known_scheme'
  | 'timestamp_out_of_range'
  | 'signature_mismatch';

export type VerifyResult =
  | { valid: true; timestamp: number }
  | { valid: false; code: VerifyFailure; reason: string };

/**
 * Verify an inbound signature header.
 *
 * Every branch fails closed and says which one it was, because "signature
 * invalid" is the single least actionable error message in integration work: it
 * cannot distinguish the wrong secret from a clock 20 minutes out, and those
 * have opposite fixes.
 */
export function verifyWebhook(
  secret: string,
  rawBody: string,
  header: string | undefined,
  opts: { now?: Date; maxAgeMs?: number } = {},
): VerifyResult {
  if (!header || !header.trim()) {
    return { valid: false, code: 'missing_header', reason: 'The signature header is missing.' };
  }

  const parts = new Map<string, string[]>();
  for (const segment of header.split(',')) {
    const eq = segment.indexOf('=');
    if (eq <= 0) continue;
    const key = segment.slice(0, eq).trim();
    const value = segment.slice(eq + 1).trim();
    if (!key || !value) continue;
    const existing = parts.get(key);
    if (existing) existing.push(value);
    else parts.set(key, [value]);
  }

  const rawTimestamp = parts.get('t')?.[0];
  if (!rawTimestamp || !/^\d{1,15}$/.test(rawTimestamp)) {
    return {
      valid: false,
      code: 'malformed_header',
      reason: 'The signature header has no usable `t=` timestamp.',
    };
  }
  // Several `v1=` values are allowed: that is how a sender rotates a secret
  // without a flag day — it signs with both, and the receiver accepts either.
  const candidates = parts.get(SCHEME) ?? [];
  if (!candidates.length) {
    return {
      valid: false,
      code: 'no_known_scheme',
      reason: `The signature header carries no ${SCHEME} signature.`,
    };
  }

  const timestamp = Number(rawTimestamp);
  const now = (opts.now ?? new Date()).getTime();
  const maxAgeMs = opts.maxAgeMs ?? SIGNATURE_MAX_AGE_MS;
  const skewMs = now - timestamp * 1000;
  // Bounded in BOTH directions. A future timestamp is refused too: without that
  // a sender whose clock is a year ahead produces requests that stay replayable
  // for a year, and the age bound above achieves nothing.
  if (skewMs > maxAgeMs || skewMs < -maxAgeMs) {
    return {
      valid: false,
      code: 'timestamp_out_of_range',
      reason:
        `The request is timestamped ${Math.round(Math.abs(skewMs) / 1000)}s ` +
        `${skewMs > 0 ? 'in the past' : 'in the future'}, outside the ` +
        `${Math.round(maxAgeMs / 1000)}s window. Check the sending system's clock.`,
    };
  }

  const expected = createHmac('sha256', secret)
    .update(signedPayload(timestamp, rawBody), 'utf8')
    .digest('hex');
  for (const candidate of candidates) {
    if (safeEqual(candidate, expected)) return { valid: true, timestamp };
  }
  return {
    valid: false,
    code: 'signature_mismatch',
    reason: 'The signature does not match the body. The shared secret is probably wrong.',
  };
}

/** The header name both directions use. Exported so a settings screen can print it. */
export const SIGNATURE_HEADER = 'x-caratos-signature';

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
