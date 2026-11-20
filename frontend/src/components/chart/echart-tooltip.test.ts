import { describe, expect, it } from "vitest";

import { axisTooltipFormatter } from "./echart";

/**
 * The tooltip is the only place a reader gets the untruncated category name and
 * the exact figure, so these assert the three things it must always carry — the
 * name, the formatted value, the share when one is meaningful — and that a
 * category name typed into the ERP cannot inject markup into it.
 */
const row = (seriesName: string, value: number, axisValueLabel = "Jaipur") => ({
  marker: "<span>•</span>",
  seriesName,
  axisValueLabel,
  value,
});

describe("axis tooltip formatter", () => {
  it("carries the category, the series name and the formatted value", () => {
    const html = axisTooltipFormatter({ format: (v) => `₹${v}` })([row("Revenue", 1200)]);
    expect(html).toContain("Jaipur");
    expect(html).toContain("Revenue");
    expect(html).toContain("<strong");
    expect(html).toContain("₹1200");
  });

  it("adds a share only when a denominator is given", () => {
    const rows = [row("Revenue", 250)];
    expect(axisTooltipFormatter()(rows)).not.toContain("%");
    expect(axisTooltipFormatter({ shareTotal: 1000 })(rows)).toContain("25.0%");
  });

  it("measures a stacked column against the column, not a fixed total", () => {
    const format = axisTooltipFormatter({ shareOfRows: true });
    expect(format([row("On time", 3), row("Late", 1)])).toContain("75.0%");
    expect(format([row("On time", 1), row("Late", 1)])).toContain("50.0%");
  });

  it("escapes a category or series name rather than rendering it as markup", () => {
    const html = axisTooltipFormatter()([
      row("<img src=x onerror=alert(1)>", 1, "Ranchi <b>HO</b>"),
    ]);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;img");
  });

  it("renders nothing for an empty hover rather than an empty frame", () => {
    expect(axisTooltipFormatter()([])).toBe("");
  });
});
