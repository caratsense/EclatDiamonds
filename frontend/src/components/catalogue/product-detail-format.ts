/**
 * Plain-language shaping for the design detail dialog: the data stays exactly
 * as the source sent it, these helpers only decide how it reads to a person at
 * the counter (group repeats, order, name things in shop-floor words).
 */
import type {
  CatalogueConflictView,
  ProductFull,
  ProductPriceView,
  ProductVariantView,
} from "@/lib/queries/products";

// ------------------------------------------------------------- conflicts

/** What each kind of data problem means, in words a store manager uses. */
export const CONFLICT_KIND_LABELS: Record<string, string> = {
  spec_mismatch: "Description and materials list don't agree",
  unit_mismatch: "Wrong unit in the materials list",
  gati_match_none: "Website-only design (no matching Gati design)",
  gati_match_ambiguous: "Could be more than one Gati design",
  normalization_error: "Part of the website data couldn't be read",
};

export interface ConflictGroup {
  kind: string;
  label: string;
  summary: string;
  /** How many open conflicts said exactly this (a mismatch arrives once per option). */
  count: number;
}

/** Open conflicts, one row per distinct message, in the order they first appear. */
export function groupConflicts(conflicts: CatalogueConflictView[] | undefined): ConflictGroup[] {
  const groups = new Map<string, ConflictGroup>();
  for (const c of conflicts ?? []) {
    if (c.status && c.status !== "open") continue;
    const key = `${c.kind}\u0000${c.summary.trim()}`;
    const seen = groups.get(key);
    if (seen) seen.count += 1;
    else
      groups.set(key, {
        kind: c.kind,
        label: CONFLICT_KIND_LABELS[c.kind] ?? humanize(c.kind),
        summary: c.summary.trim(),
        count: 1,
      });
  }
  return [...groups.values()];
}

// ----------------------------------------------------------------- prices

export interface PriceOption {
  key: string;
  label: string;
  amount: number;
}

/** Name of one option (variant): "18K · Yellow Gold · Natural" when the server sends it. */
export function variantName(v: Pick<ProductVariantView, "label" | "metalType" | "karat" | "colour" | "diamondType" | "sku" | "sourceKey">): string {
  if (v.label) return v.label;
  const metal = [v.karat ? `${v.karat}K` : null, v.colour, v.metalType].filter(Boolean).join(" ");
  const stone = v.diamondType ? (/diamond/i.test(v.diamondType) ? v.diamondType : `${v.diamondType} diamond`) : "";
  const parts = [metal, stone].filter(Boolean);
  return parts.length ? parts.join(" · ") : (v.sku ?? v.sourceKey ?? "Option");
}

// --------------------------------------------------------- bill of material

/** Source keys that are the source's own row ids or blobs, never worth a column. */
const BOM_SKIP = /^_?id$|^__v$|raw_?material_?id|^extra$/i;
/** How the website names a BOM column, in words; anything else is humanised. */
const BOM_WORDS: Record<string, string> = {
  materialname: "Material",
  material: "Material",
  name: "Material",
  weight: "Weight",
  unit: "Unit",
  quantity: "Qty",
  qty: "Qty",
  rate: "Rate",
  linetotal: "Amount",
  amount: "Amount",
  isdiamond: "Diamond?",
};
const BOM_ORDER = ["Material", "Weight", "Unit", "Qty", "Rate", "Amount", "Diamond?"];

export interface BomColumn {
  key: string;
  label: string;
}

/**
 * The columns a BOM table shows: the keys the response carries (cost keys are
 * absent below store manager), minus ids and nested objects, in reading order.
 */
export function bomColumns(lines: Record<string, unknown>[]): BomColumn[] {
  const cols: BomColumn[] = [];
  for (const l of lines)
    for (const [k, v] of Object.entries(l)) {
      if (BOM_SKIP.test(k) || (v !== null && typeof v === "object")) continue;
      if (cols.some((c) => c.key === k)) continue;
      cols.push({ key: k, label: BOM_WORDS[k.toLowerCase().replace(/[_\s]/g, "")] ?? humanize(k) });
    }
  const rank = (c: BomColumn) => {
    const i = BOM_ORDER.indexOf(c.label);
    return i < 0 ? BOM_ORDER.length : i;
  };
  return cols.sort((a, b) => rank(a) - rank(b));
}

/** Price kinds that only repeat another row, so they never get a line of their own. */
const REPEAT_KINDS = new Set(["min_variant"]);

const PRICE_KIND_WORDS: Record<string, string> = {
  indicative: "Indicative price",
  natural_diamond: "With a natural diamond",
  gati_tag: "Tag price (Gati)",
  gati_tag_min: "Lowest tag price (Gati)",
  gati_tag_max: "Highest tag price (Gati)",
};

/**
 * Every price as "what you get → what it costs": one line per option, plus the
 * product-level prices that are not just the cheapest option again. A margin
 * price (managers only) is listed only when it differs from the option's price.
 */
export function priceOptions(data: Pick<ProductFull, "prices" | "variants">): PriceOption[] {
  const variants = new Map((data.variants ?? []).map((v) => [v.id, v]));
  const plain = new Map<string, number>();
  for (const pr of data.prices ?? []) if (pr.kind === "variant" && pr.variantId) plain.set(pr.variantId, pr.amount);

  // Options first (the choices a customer makes), then the design-level prices.
  const options: PriceOption[] = [];
  const others: PriceOption[] = [];
  const seen = new Set<string>();
  const push = (into: PriceOption[], key: string, label: string, amount: number) => {
    const sig = `${label}\u0000${amount}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    into.push({ key, label, amount });
  };

  (data.prices ?? []).forEach((pr: ProductPriceView, i) => {
    if (pr.amount == null || REPEAT_KINDS.has(pr.kind)) return;
    const v = pr.variantId ? variants.get(pr.variantId) : undefined;
    const option = pr.variantLabel || (v ? variantName(v) : null);
    const key = pr.id ?? `${pr.kind}-${pr.variantId ?? ""}-${i}`;
    if (pr.kind === "variant") return push(options, key, option ?? "Option", pr.amount);
    if (pr.kind === "variant_with_margin") {
      if (pr.variantId && plain.get(pr.variantId) === pr.amount) return;
      return push(options, key, `${option ?? "Option"} · with margin`, pr.amount);
    }
    const word = PRICE_KIND_WORDS[pr.kind] ?? pr.label ?? humanize(pr.kind);
    push(others, key, option ? `${word} · ${option}` : word, pr.amount);
  });

  if (!options.length) {
    for (const v of data.variants ?? []) if (v.price != null) push(options, v.id, variantName(v), v.price);
  }
  return [...options, ...others];
}

// ------------------------------------------------------------------ sizes

/** Ring sizes in the order a customer reads them: IND 6, IND 7 … IND 18. */
export function sortSizes(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }));
}

// ---------------------------------------------------------- specifications

export type SpecLine = { kind: "text"; text: string } | { kind: "item"; key: string | null; value: string };

/**
 * The website's specification text, split into lines for display. A line that
 * starts with "*", "-" or "•" is a list item, and "Key: value" is split so the
 * key can be shown as a label. Words are not changed, except a stray "*" in
 * the middle of a key ("Centre * Diamond Weight"), which is source typing.
 */
export function specLines(text: string): SpecLine[] {
  const out: SpecLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const bullet = /^[*\-•·]\s*/.test(line);
    const body = line.replace(/^[*\-•·]\s*/, "");
    if (!bullet) {
      out.push({ kind: "text", text: body });
      continue;
    }
    const m = body.match(/^([^:]{1,60}?)\s*:\s*(.+)$/);
    out.push(
      m
        ? { kind: "item", key: m[1].replace(/\s+\*\s+/g, " ").trim(), value: m[2].trim() }
        : { kind: "item", key: null, value: body },
    );
  }
  return out;
}

// --------------------------------------------------------------- codes / ids

export interface CodeRow {
  value: string;
  /** Every name this value goes by, e.g. ["Style no", "SKU", "Website code"]. */
  labels: string[];
}

/** One row per distinct code, listing every name it is known by. */
export function groupCodes(ids: Record<string, unknown>, labelFor: (key: string) => string): CodeRow[] {
  const rows = new Map<string, CodeRow>();
  for (const [k, v] of Object.entries(ids)) {
    if (v == null || v === "") continue;
    const value = String(v);
    const label = labelFor(k);
    const row = rows.get(value);
    if (row) {
      if (!row.labels.includes(label)) row.labels.push(label);
    } else rows.set(value, { value, labels: [label] });
  }
  return [...rows.values()];
}

// ---------------------------------------------------------------- history

const HISTORY_LABELS: Record<string, string> = {
  websiteSourceCreatedAt: "Created on the website",
  websiteSourceUpdatedAt: "Last edited on the website",
  websiteSyncedAt: "Last copied from the website",
  websiteLastSeenAt: "Last seen on the website",
  gatiUpdatedAt: "Last edited in Gati",
  gatiSyncedAt: "Last copied from Gati",
  createdAt: "Added to this catalogue",
  updatedAt: "Last changed in this catalogue",
};

export interface HistoryRow {
  key: string;
  label: string;
  at: string;
}

/** The design's timestamps as a story, oldest first; ids that ride along are dropped. */
export function historyRows(provenance: Record<string, string | null | undefined> | null | undefined): HistoryRow[] {
  return Object.entries(provenance ?? {})
    .filter((e): e is [string, string] => e[0].endsWith("At") && typeof e[1] === "string" && !!e[1])
    .map(([key, at]) => ({ key, label: HISTORY_LABELS[key] ?? humanize(key), at }))
    .sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
}

// ---------------------------------------------------------------- countries

/** "IN" → "India"; anything the browser cannot name is shown as sent. */
export function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

// ------------------------------------------------------------------ misc

/** camelCase / snake_case → "Sentence case". */
export function humanize(key: string): string {
  const s = key.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
