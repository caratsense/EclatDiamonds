import { describe, expect, it } from "vitest";

import { rankedForCard } from "./dashboard-charts";
import type { StoreCompare } from "@/lib/mock/dashboards";

/**
 * The Store Comparison card's roll-up (client CEO, 23 Nov: eleven branch names
 * printed on top of one another).
 *
 * The card now plots a row per branch and rolls the tail up so it stays a card.
 * Both halves of that fail quietly if they are wrong — a mis-ranked chart
 * tells the reader the wrong branch is carrying the month, and a roll-up that
 * sums a target nobody set re-introduces the "Target ₹0" the null was added to
 * prevent. Nibhana's real branch names are used so the test is about the
 * strings in production, not invented ones.
 */
const branch = (store: string, revenue: number, target: number | null = null): StoreCompare => ({
  store,
  revenue,
  target,
});

/** The eleven trading branches, as the dashboard feed sends them. */
const NIBHANA: StoreCompare[] = [
  branch("BANJARA HILLS HYD", 796090),
  branch("DELHI PASCHIM VIHAR", 409742),
  branch("DELHI ROHINI", 1613778),
  branch("MUMBAI BANDRA", 470484),
  branch("MUMBAI BANDRA BROADWAY", 132156),
  branch("MUMBAI BORIVALI", 0, 100000),
  branch("MUMBAI KALAGHODA", 1054436),
  branch("NASHIK SHARANPUR", 485142),
  branch("PUNE AMANORA MALL", 281466),
  branch("UDAIPUR ASHOK NAGAR", 423346),
  branch("INDORE RATNAMANI COMPLEX", 909937),
];

describe("the Store Comparison card's rows", () => {
  it("ranks the branches best first", () => {
    expect(rankedForCard(NIBHANA).map((r) => r.store).slice(0, 3)).toEqual([
      "DELHI ROHINI",
      "MUMBAI KALAGHODA",
      "INDORE RATNAMANI COMPLEX",
    ]);
  });

  it("plots six branches and rolls the rest into one named row", () => {
    const rows = rankedForCard(NIBHANA);
    expect(rows).toHaveLength(7);
    expect(rows[6].store).toBe("Other branches (5)");
    // The roll-up carries the tail's revenue, so the month still adds up.
    const total = NIBHANA.reduce((sum, b) => sum + b.revenue, 0);
    expect(rows.reduce((sum, r) => sum + r.revenue, 0)).toBe(total);
  });

  it("leaves a rolled-up target null when nobody in the tail set one", () => {
    const rows = rankedForCard(NIBHANA);
    // MUMBAI BORIVALI is the only branch with a target and it ranks last on
    // revenue, so the tail does hold one — it must be summed, not dropped.
    expect(rows[6].target).toBe(100000);

    const noTargets = rankedForCard(NIBHANA.map((b) => ({ ...b, target: null })));
    expect(noTargets[6].target).toBeNull();
  });

  it("does not roll a single branch up into a row that hides its name", () => {
    const seven = rankedForCard(NIBHANA.slice(0, 7));
    expect(seven).toHaveLength(7);
    expect(seven.some((r) => r.store.startsWith("Other branches"))).toBe(false);
  });

  it("leaves a small chain alone", () => {
    const three = rankedForCard(NIBHANA.slice(0, 3));
    expect(three.map((r) => r.store)).toEqual([
      "DELHI ROHINI",
      "BANJARA HILLS HYD",
      "DELHI PASCHIM VIHAR",
    ]);
  });
});
