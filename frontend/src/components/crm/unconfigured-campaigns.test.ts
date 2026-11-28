import { describe, expect, it } from "vitest";

import { campaignLabel, enquiriesSoFar } from "@/components/crm/unconfigured-campaigns";

/**
 * The panel that ends the silence must not be silent itself.
 *
 * Campaign "blue diamond 24/11" sent eight enquiries and carried no rule, and
 * the only record of it was a warning in a container log. The one way this
 * panel could reproduce that is by rendering a row with nothing in it: a
 * deleted ad, an expired token or a Graph outage all leave a campaign unnamed,
 * and those are exactly the moments somebody needs to see that clicks are still
 * arriving.
 */
describe("naming a campaign nobody configured", () => {
  it("uses the campaign's name from Meta", () => {
    expect(
      campaignLabel({ campaignName: "blue diamond 24/11", adIds: ["120256795604450226"] }),
    ).toBe("blue diamond 24/11");
  });

  it("falls back to the advert id when the campaign could not be named", () => {
    expect(campaignLabel({ campaignName: null, adIds: ["120256795604450226"] })).toBe(
      "Advert 120256795604450226",
    );
  });

  it("never renders a blank row", () => {
    // A name of spaces is not a name. Trimmed to nothing it would read as an
    // empty row, which is the original invisibility with extra steps.
    expect(campaignLabel({ campaignName: "   ", adIds: [] })).toBe(
      "An advert we could not identify",
    );
  });
});

describe("how many enquiries it has brought in", () => {
  it("does not say 1 enquiries", () => {
    expect(enquiriesSoFar(1)).toBe("1 enquiry");
  });

  it("counts the rest", () => {
    expect(enquiriesSoFar(8)).toBe("8 enquiries");
  });
});
