/**
 * Money / weight formatting helpers for jewelry retail.
 * Used across all 17 sections so values render with consistent
 * precision and units (₹ / grams / carats).
 */

/** Indian Rupee currency. Defaults to 0 fraction digits for whole amounts. */
export function formatINR(
  amount: number,
  opts: { fractionDigits?: number } = {},
): string {
  const fractionDigits = opts.fractionDigits ?? 0;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(amount);
}

/** Compact INR for dashboards, e.g. ₹1.2L, ₹3.4Cr (Indian grouping). */
export function formatINRCompact(amount: number): string {
  if (Math.abs(amount) >= 1_00_00_000) {
    return `₹${(amount / 1_00_00_000).toFixed(2)}Cr`;
  }
  if (Math.abs(amount) >= 1_00_000) {
    return `₹${(amount / 1_00_000).toFixed(2)}L`;
  }
  if (Math.abs(amount) >= 1_000) {
    return `₹${(amount / 1_000).toFixed(1)}K`;
  }
  return formatINR(amount);
}

/** Weight in grams — gold/silver gross/net weights. */
export function formatGrams(
  grams: number | null | undefined,
  fractionDigits = 3,
): string {
  // Optional/absent weights (e.g. a product or stock piece saved without a
  // gross weight) come back null from the API — render "—" instead of crashing.
  if (grams == null || Number.isNaN(grams)) return "—";
  return `${grams.toFixed(fractionDigits)} g`;
}

/** Weight in carats — diamonds / gemstones. */
export function formatCarats(
  carats: number | null | undefined,
  fractionDigits = 2,
): string {
  if (carats == null || Number.isNaN(carats)) return "—";
  return `${carats.toFixed(fractionDigits)} ct`;
}

/** Gold purity label, e.g. 22K, 18K. */
export function formatPurity(karat: number): string {
  return `${karat}K`;
}

/** Generic number with Indian grouping. */
export function formatNumber(value: number, fractionDigits = 0): string {
  return new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

export function formatPercent(
  value: number | null | undefined,
  fractionDigits = 1,
): string {
  if (value == null || Number.isNaN(value)) return "—";
  return `${value.toFixed(fractionDigits)}%`;
}
