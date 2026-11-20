import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ImageSourceTag, imageOrigin } from "./image-source-tag";

// Midday UTC: the same calendar day in every timezone the tests run in.
const NOV_12 = "2026-11-12T12:00:00.000Z";

describe("where a catalogue picture came from", () => {
  it("a website photo names the site and the file, and when it was first synced", () => {
    expect(imageOrigin("website", "https://nibhana.com/cdn/shop/files/ring%20front.jpg?v=3", NOV_12)).toEqual([
      "Photo from the website, synced automatically.",
      "From nibhana.com: ring front.jpg",
      "In CaratSpace since 12 Nov 2026",
    ]);
  });

  it("a CAD drawing names only its file: the link is our own storage", () => {
    expect(imageOrigin("gati_cad", "https://res.cloudinary.com/x/image/upload/v1/gati/AB-1234.jpg")).toEqual([
      "CAD drawing from Gati, synced automatically.",
      "File: AB-1234.jpg",
    ]);
  });

  it("a photo added by hand says when", () => {
    expect(imageOrigin("manual", null, NOV_12)).toEqual(["Added by hand in CaratSpace.", "Added on 12 Nov 2026"]);
  });

  it("an unknown source, a relative link or a bad date adds nothing made up", () => {
    expect(imageOrigin(undefined, "/uploads/a.jpg", "not a date")).toEqual([
      "Where this photo came from was not recorded.",
    ]);
  });

  it("renders the tip right after the tag, which is what makes hovering the tag open it", () => {
    const html = renderToStaticMarkup(createElement(ImageSourceTag, { source: "gati_cad" }));
    expect(html).toMatch(/data-testid="image-source-tag"[^>]*>.*CAD<\/span><span role="tooltip"/);
    expect(html).toContain("CAD drawing from Gati");
    // Inside a card that is a button, the tag must not be a second control.
    expect(html).not.toContain("tabindex");
  });
});
