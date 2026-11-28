import type {
  AdEnquiryAdvert,
  AdEnquiryCampaign,
} from "@/lib/queries/ad-enquiries";

/**
 * What to call an advert, and which rows the chart can hold.
 *
 * Pure and separate from the page because both answers have a rule behind them
 * that is worth reading on its own: NOTHING IS EVER RENDERED BLANK, and the
 * chart never shows a cut-down ranking without saying it is cut down. The
 * screen exists so the client can see which advert is working, so a nameless
 * row and a quietly truncated list are the two ways it could mislead.
 */

/** How many bars one card can hold before the names stop being readable. */
export const CHART_ROWS = 10;

/**
 * The name to show for an advert.
 *
 * NEVER a blank. A deleted ad, an expired token, a Graph outage or an advert
 * past the server's lookup cap all leave it unnamed, and those are exactly the
 * moments the client most needs to see that clicks are still arriving — so the
 * advert id stands in for the name it could not be given. The same choice the
 * unconfigured-campaigns panel makes, for the same reason.
 */
export function advertLabel(advert: Pick<AdEnquiryAdvert, "adSetName" | "adId">): string {
  const adSet = advert.adSetName?.trim();
  if (adSet) return adSet;
  return `Advert ${advert.adId}`;
}

/** The name to show for a campaign, falling back to the advert beneath it. */
export function campaignLabel(
  campaign: Pick<AdEnquiryCampaign, "campaignName" | "adverts">,
): string {
  const name = campaign.campaignName?.trim();
  if (name) return name;
  const [first] = campaign.adverts;
  return first ? advertLabel(first) : "An advert we could not identify";
}

export interface ChartRow {
  label: string;
  enquiries: number;
  replied: number;
}

/**
 * The bars, best first, and whether anything was left off.
 *
 * Trimmed to `CHART_ROWS` because eleven branch names already crowd a
 * horizontal bar chart and a quarter's worth of campaigns would turn the card
 * into a wall. `hidden` is returned rather than swallowed so the card can say
 * how many campaigns are not drawn — the table below holds all of them, and a
 * chart that silently shows nine of thirty is a chart that answers a different
 * question from the one on its title.
 */
export function chartRows(campaigns: AdEnquiryCampaign[]): {
  rows: ChartRow[];
  hidden: number;
} {
  const rows = campaigns.slice(0, CHART_ROWS).map((c) => ({
    label: campaignLabel(c),
    enquiries: c.enquiries,
    replied: c.replied,
  }));
  return { rows, hidden: Math.max(campaigns.length - rows.length, 0) };
}
