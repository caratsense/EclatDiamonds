import type { AdReferral } from '../integration/contracts/ad-referral';

/**
 * Meta Click-to-WhatsApp (CTWA) referral extraction — the provider ADAPTER.
 *
 * Produces the neutral `AdReferral` contract; the CRM core never imports this file.
 *
 *
 * ## What this is
 *
 * When someone taps a Click-to-WhatsApp ad, Meta attaches a `referral` object to
 * the FIRST inbound message of that conversation. The WhatsApp webhook already
 * stores the whole provider message verbatim in `WhatsAppEvent.payload`, so this
 * data has been arriving all along — nothing read it. This module reads it.
 *
 * ## What Meta actually sends, and what it does NOT
 *
 * The referral carries `source_id`, which is the **AD id** — not an ad set and
 * not a campaign. Meta does not put the ad-set id or campaign id in a CTWA
 * referral at all. Resolving an ad to its ad set requires a Marketing API call
 * with `ads_read`, which is a separate, credentialled integration.
 *
 * That distinction is load-bearing and is why `adSetId` and `campaignId` below
 * are always null for CTWA. Populating them by guessing — parsing the headline,
 * assuming a naming convention — would manufacture attribution that looks
 * measured and is not. A null here is the honest answer, and the routing engine
 * is built to leave unmatched traffic visible rather than route it somewhere.
 *
 * ## Why `ad_id` matching matters
 *
 * Because the ad id IS available with no extra permissions, a tenant can paste
 * ad ids from Ads Manager into a routing rule and get correct store routing
 * today, without app review. That is the credential-free path to the acceptance
 * criteria; ad-set matching stays available for when a Marketing API adapter
 * exists to supply it.
 */

function str(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  }
  // Meta sends numeric ids as numbers in some payload versions.
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Pull the referral off one raw WhatsApp message.
 *
 * Returns null when the message did not come from an ad — the overwhelmingly
 * common case, since only the first message of a CTWA thread carries one.
 * A null result must never be treated as "organic": it means "not known to be
 * from an ad", which is a different claim.
 */
export function extractMetaReferral(message: unknown): AdReferral | null {
  if (!message || typeof message !== 'object') return null;
  const referral = (message as Record<string, unknown>).referral;
  if (!referral || typeof referral !== 'object') return null;

  const r = referral as Record<string, unknown>;
  const adId = str(r.source_id);
  const clickId = str(r.ctwa_clid);

  // A referral object with neither an ad id nor a click id tells us nothing
  // attributable. Recording it would create a measured touch with no measurement.
  if (!adId && !clickId) return null;

  return {
    adId,
    adSetId: null,
    campaignId: null,
    clickId,
    sourceType: str(r.source_type),
    headline: str(r.headline),
    body: str(r.body),
    sourceUrl: str(r.source_url),
    raw: r,
  };
}

/**
 * The routing context a referral supports.
 *
 * Deliberately narrow: only ids the provider actually supplied. `adSetName` is
 * NOT derived from the ad headline — a headline is marketing copy, not an ad-set
 * name, and matching one against the other would fire the wrong tenant's rule.
 */
export function routingContextFrom(referral: AdReferral | null): {
  adId?: string;
  adSetId?: string;
} | undefined {
  if (!referral) return undefined;
  const context: { adId?: string; adSetId?: string } = {};
  if (referral.adId) context.adId = referral.adId;
  if (referral.adSetId) context.adSetId = referral.adSetId;
  return Object.keys(context).length ? context : undefined;
}
