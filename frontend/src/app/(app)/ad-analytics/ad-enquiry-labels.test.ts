import { describe, expect, it } from "vitest";

import type { AdEnquiryCampaign } from "@/lib/queries/ad-enquiries";

import { advertLabel, campaignLabel, chartRows, CHART_ROWS } from "./ad-enquiry-labels";

/**
 * Nothing on this screen may render blank, and no ranking may be quietly
 * shortened.
 *
 * The client asked for this screen (28 Nov) because she is running three or
 * four adverts and cannot tell which is working. A row with no name is a row
 * she cannot act on, and a chart showing nine of thirty campaigns without
 * saying so answers a different question from the one in its title.
 */
const campaign = (over: Partial<AdEnquiryCampaign>): AdEnquiryCampaign => ({
  key: "c1",
  campaignId: "c1",
  campaignName: "blue diamond 24/11",
  enquiries: 0,
  replied: 0,
  repliedPct: null,
  unrouted: 0,
  branches: [],
  adverts: [],
  ...over,
});

describe("what to call an advert", () => {
  it("uses the ad set name, which is how the branch is named", () => {
    // "Lead Campaign Kala Ghoda" — the marketing team names ad sets after the
    // showroom, so it is the most useful thing on the row.
    expect(advertLabel({ adSetName: "Lead Campaign Kala Ghoda", adId: "1202567956" })).toBe(
      "Lead Campaign Kala Ghoda",
    );
  });

  it("falls back to the advert id rather than rendering nothing", () => {
    // A deleted ad, an expired token or a Graph outage all leave it unnamed,
    // and those are the moments the client most needs to see the clicks
    // arriving. The id is also what she pastes into a routing rule to fix it.
    expect(advertLabel({ adSetName: null, adId: "120256795604450226" })).toBe(
      "Advert 120256795604450226",
    );
    expect(advertLabel({ adSetName: "   ", adId: "120256795604450226" })).toBe(
      "Advert 120256795604450226",
    );
  });

  it("names a campaign by its busiest advert when Meta named neither", () => {
    expect(
      campaignLabel(
        campaign({
          campaignName: null,
          adverts: [
            {
              adId: "120256795604450226",
              adSetName: null,
              enquiries: 9,
              replied: 2,
              repliedPct: 22,
              unrouted: 9,
              branches: [],
              named: false,
            },
          ],
        }),
      ),
    ).toBe("Advert 120256795604450226");
  });

  it("says so plainly when there is nothing at all to name it with", () => {
    expect(campaignLabel(campaign({ campaignName: null, adverts: [] }))).toBe(
      "An advert we could not identify",
    );
  });
});

describe("the bars", () => {
  it("draws the campaigns in the order the server ranked them", () => {
    // The server owns the ranking; re-sorting here is how two screens start
    // disagreeing about which advert is winning.
    const { rows, hidden } = chartRows([
      campaign({ key: "a", campaignName: "blue diamond 24/11", enquiries: 40, replied: 15 }),
      campaign({ key: "b", campaignName: "diwali teaser", enquiries: 4, replied: 1 }),
    ]);
    expect(rows.map((r) => r.label)).toEqual(["blue diamond 24/11", "diwali teaser"]);
    expect(rows[0]).toEqual({ label: "blue diamond 24/11", enquiries: 40, replied: 15 });
    expect(hidden).toBe(0);
  });

  it("reports how many campaigns it left off", () => {
    // The table below holds all of them; the chart has to admit it does not.
    const many = Array.from({ length: CHART_ROWS + 3 }, (_, i) =>
      campaign({ key: `c${i}`, campaignName: `campaign ${i}`, enquiries: 100 - i }),
    );
    const { rows, hidden } = chartRows(many);
    expect(rows).toHaveLength(CHART_ROWS);
    expect(hidden).toBe(3);
  });

  it("draws nothing for an empty window", () => {
    expect(chartRows([])).toEqual({ rows: [], hidden: 0 });
  });
});
