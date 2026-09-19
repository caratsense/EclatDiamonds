import { describe, expect, it } from "vitest";

import { encodeUnder, fitWithin, parseRetryAfter } from "@/lib/queries/jewelry-similarity";

describe("query photo preparation", () => {
  it("caps the long side at 1600 and never upscales", () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3024, 4032)).toEqual({ width: 1200, height: 1600 });
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it("steps quality down from 0.9 and stops at the first encoding under 1 MB", async () => {
    const tried: string[] = [];
    // Size falls with quality: 0.9 → 1.8 MB … 0.7 → 1.08 MB, 0.6 → 0.72 MB.
    const blob = await encodeUnder(async (scale, q) => {
      tried.push(`${scale}@${q}`);
      return new Blob([new Uint8Array(Math.round(scale * (q - 0.4) * 3_600_000))]);
    });
    expect(tried[0]).toBe("1@0.9");
    expect(tried.at(-1)).toBe("1@0.6");
    expect(blob.size).toBeLessThanOrEqual(1_000_000);
  });

  it("falls back to smaller scales, then to the smallest attempt", async () => {
    const huge = await encodeUnder(async (scale) => new Blob([new Uint8Array(Math.round(scale * 4_000_000))]));
    expect(huge.size).toBe(2_000_000);
  });
});

describe("Retry-After", () => {
  it("reads seconds, HTTP dates, and defaults when unreadable", () => {
    expect(parseRetryAfter("7")).toBe(7);
    expect(parseRetryAfter(new Date(10_000 + 12_000).toUTCString(), 10_000)).toBe(12);
    expect(parseRetryAfter(undefined)).toBe(5);
    expect(parseRetryAfter("9999")).toBe(300);
  });
});
