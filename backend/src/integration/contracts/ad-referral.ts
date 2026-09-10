/**
 * A normalized ad click — provider-neutral.
 *
 * Lives with the other contracts (not in a Meta file) because the CRM core must
 * never import a provider adapter: `conversations.service` speaks this shape,
 * and each adapter is responsible for producing it. Adding a channel means
 * writing an adapter, not editing the inbox.
 *
 * Every id here is an OPAQUE provider string. Nothing in the platform parses one
 * for meaning, infers a campaign from an ad, or derives an ad-set name from
 * marketing copy. A null means "the provider did not tell us", which is a
 * different and weaker claim than "there was no ad" — and must never be
 * rendered as "organic".
 */
export interface AdReferral {
  /** Ad id. For Meta CTWA this is `referral.source_id`. */
  adId: string | null;
  /**
   * Ad-set id. Null for Click-to-WhatsApp: Meta does not send it, and resolving
   * an ad to its ad set needs a Marketing API call with `ads_read`.
   */
  adSetId: string | null;
  /** Campaign id. Null for CTWA, for the same reason as `adSetId`. */
  campaignId: string | null;
  /** Click id — the join key back to the provider's own reporting. */
  clickId: string | null;
  /** What was clicked, as the provider labelled it (e.g. 'ad', 'post'). */
  sourceType: string | null;
  /** Creative headline. Evidence and display only — never matched against rules. */
  headline: string | null;
  /** Creative body text. Evidence and display only. */
  body: string | null;
  /** Deep link back to the creative. */
  sourceUrl: string | null;
  /**
   * The provider's complete referral object, unmodified, so a field the provider
   * adds later is retained rather than silently dropped by the adapter.
   */
  raw: Record<string, unknown>;
}
