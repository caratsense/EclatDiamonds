"use client";

import { useState } from "react";
import { Download, Plus, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatINR } from "@/lib/format";
import {
  fetchStyle,
  saleRateFor,
  useStyleSearch,
  type MaterialMaster,
  type MaterialOption,
} from "@/lib/queries/materials";
import { apiErrorMessage, cn } from "@/lib/utils";

/** The karats the business quotes in (owner, 22 Sep 2026). */
export const QUOTE_KARATS = [9, 12, 14, 18, 22, 24];

/** Item types when the item master has not been loaded yet (the ERP's list). */
const ITEM_TYPES_FALLBACK = [
  ["ALR", "LADIES RING"], ["AGR", "GENTS RINGS"], ["APD", "PENDANT"], ["ABG", "BANGLE"],
  ["ABR", "BRACELET"], ["ANK", "NECKLACE"], ["AER", "EARRING"], ["ANP", "NOSEPIN"],
  ["ACH", "CHAIN"], ["AANK", "ANKLET"],
].map(([code, name]) => ({ code, name }));

/** Gold items in the ERP's G<karat><tone> form, for karats the master has none of. */
const metalsFor = (karats: number[]): MaterialOption[] => karats.flatMap((karat) =>
  ["YG", "WG", "PG"].map((tone) => ({
    code: `G${String(karat).padStart(2, "0")}${tone}`,
    name: `GOLD${karat}${tone}`,
    kind: "metal",
    groupCode: "G",
    groupName: "GOLD",
    karat,
    tone,
    shape: null,
    quality: null,
    saleRates: null,
  })),
);

export interface StoneRow {
  id: number;
  type: "D" | "C";
  code: string;
  /**
   * The stone's size, when the design's materials brought one. Not typed on the
   * screen (the shop does not quote by it) but kept, because the rate chart and
   * the weight per stone are looked up by it.
   */
  size: string;
  pieces: string;
  carats: string;
  rate: string;
  /** % off this stone. */
  discount: string;
  /** The rate is still the chart's, so it follows the code and size. */
  rateAuto: boolean;
}

export interface ItemRow {
  id: number;
  itemType: string;
  styleNumber: string;
  size: string;
  sizeUnit: "" | "cm" | "inch";
  metalCode: string;
  weight: string;
  /** Gold rate typed over today's; empty means today's rate. */
  manualRate: string;
  makingRate: string;
  /** % off the gold (on its net weight) and % off the making. */
  metalDiscount: string;
  makingDiscount: string;
  /** Anything the lists cannot say about this item. */
  remark: string;
  stones: StoneRow[];
}

let lastId = 0;
const newId = () => (lastId += 1);

export function emptyItem(): ItemRow {
  return {
    id: newId(), itemType: "", styleNumber: "", size: "", sizeUnit: "", metalCode: "",
    weight: "", manualRate: "", makingRate: "", metalDiscount: "", makingDiscount: "", remark: "", stones: [],
  };
}

export function emptyStone(type: "D" | "C"): StoneRow {
  return { id: newId(), type, code: "", size: "", pieces: "", carats: "", rate: "", discount: "", rateAuto: true };
}

/** A typed number, or undefined when blank or not a number. */
export function num(v: string): number | undefined {
  const n = Number(v);
  return v.trim() !== "" && Number.isFinite(n) ? n : undefined;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** A typed discount as a % between 0 and 100. */
export const pct = (v: string) => Math.min(Math.max(num(v) ?? 0, 0), 100);

/** Digits and one decimal point only: no minus sign can be typed. */
const unsigned = (v: string) => v.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1");

/** The size as sent: "12", "16 inch", "5.5 cm". */
export const sizeText = (item: ItemRow) => {
  const s = item.size.trim();
  return s && item.sizeUnit ? `${s} ${item.sizeUnit}` : s;
};

/**
 * What an item comes to, worked out the way the server does: each line's
 * amount, and what its own discount takes off it.
 */
export function priceItem(item: ItemRow, goldRate: number) {
  const weight = num(item.weight) ?? 0;
  const metal = weight * goldRate;
  const making = round2((num(item.makingRate) ?? 0) * weight);
  const stones = item.stones.map((s) => round2((num(s.carats) ?? 0) * (num(s.rate) ?? 0)));
  const stoneTotal = round2(stones.reduce((a, b) => a + b, 0));
  const metalOff = (metal * pct(item.metalDiscount)) / 100;
  const makingOff = (making * pct(item.makingDiscount)) / 100;
  const stoneOffs = item.stones.map((s, i) => (stones[i] * pct(s.discount)) / 100);
  const stoneOff = stoneOffs.reduce((a, b) => a + b, 0);
  return {
    weight, metal, making, stones, stoneTotal, metalOff, makingOff, stoneOffs, stoneOff,
    subtotal: metal + making + stoneTotal - metalOff - makingOff - stoneOff,
  };
}

/** The master with fallbacks, so the builder works before the master is loaded. */
export function masterLists(master: MaterialMaster | undefined) {
  const metals = master?.metals.filter((m) => m.karat != null && QUOTE_KARATS.includes(m.karat)) ?? [];
  // The ERP has no 12K items; any karat it lacks still gets its YG/WG/PG codes.
  const missing = QUOTE_KARATS.filter((k) => !metals.some((m) => m.karat === k));
  return {
    itemTypes: master?.itemTypes.length ? master.itemTypes : ITEM_TYPES_FALLBACK,
    metals: [...metals, ...metalsFor(missing)].sort(
      (a, b) => (a.karat ?? 0) - (b.karat ?? 0) || a.code.localeCompare(b.code),
    ),
    diamonds: master?.diamonds ?? [],
    stones: master?.stones ?? [],
    sizes: master?.sizes ?? [],
  };
}

export type Lists = ReturnType<typeof masterLists>;

/** Metal and stone codes for the type-to-search boxes; rendered once per builder. */
export function MaterialDatalists({ lists }: { lists: Lists }) {
  return (
    <>
      <datalist id="qb-metals">
        {lists.metals.map((m) => (
          <option key={m.code} value={m.code}>{`${m.karat}K ${m.tone ?? ""} · ${m.name}`}</option>
        ))}
      </datalist>
      <datalist id="qb-codes-D">
        {lists.diamonds.map((m) => (
          <option key={m.code} value={m.code}>{m.name}</option>
        ))}
      </datalist>
      <datalist id="qb-codes-C">
        {lists.stones.map((m) => (
          <option key={m.code} value={m.code}>{m.name}</option>
        ))}
      </datalist>
    </>
  );
}

/**
 * A stone row after a change. Carats follow pieces x the size's weight per
 * stone; the rate follows the chart until someone types their own.
 */
function nextStone(stone: StoneRow, patch: Partial<StoneRow>, lists: Lists): StoneRow {
  const next = { ...stone, ...patch };
  const size = lists.sizes.find((s) => s.code === next.size);
  const pieces = num(next.pieces);
  if (("size" in patch || "pieces" in patch) && size?.caratPerPiece && pieces) {
    next.carats = round2(pieces * size.caratPerPiece).toFixed(2);
  }
  if (next.rateAuto && ("code" in patch || "size" in patch || "pieces" in patch || "carats" in patch || "type" in patch)) {
    const material = (next.type === "D" ? lists.diamonds : lists.stones).find((m) => m.code === next.code);
    const carats = num(next.carats);
    const perStone = size?.caratPerPiece ?? (carats && pieces ? carats / pieces : undefined);
    const rate = saleRateFor(material, size, perStone);
    next.rate = rate != null ? String(rate) : "";
  }
  return next;
}

/** Today's rate for a karat, and how much to trust it. */
export interface AutoRate {
  rate: number;
  stale: boolean;
  fallback: boolean;
  note: string;
}

interface ItemEditorProps {
  index: number;
  item: ItemRow;
  lists: Lists;
  master: MaterialMaster | undefined;
  autoRate: (karat: number) => AutoRate;
  onChange: (next: ItemRow) => void;
  onRemove?: () => void;
  onFocus: () => void;
}

/** One line of the materials table: what it is, how much, at what rate, less what. */
const ROW =
  "grid grid-cols-[3.6rem_1fr_2rem] gap-1.5 rounded-md bg-muted/30 p-1.5 md:grid-cols-[3.6rem_1.7fr_3.4rem_5rem_5.6rem_4.2rem_6rem_2rem] md:items-center md:bg-transparent md:p-0";
const KIND = "flex h-9 items-center justify-center rounded-md border text-xs font-semibold";
/** A cell's label on a phone, where the header row is not shown. */
const cap = (text: string) => <span className="text-[10px] text-muted-foreground md:hidden">{text}</span>;

/**
 * One item of a sale quote: what it is (type, design, size), then its
 * materials as one table laid out like the shop's bill — the gold, each
 * diamond (D) and colour stone (C), and the making — each line with its
 * weight, its rate and its own discount. Entering a style number loads the
 * design's default materials, which are then changed for the customer.
 */
export function QuoteItemEditor({
  index,
  item,
  lists,
  master,
  autoRate,
  onChange,
  onRemove,
  onFocus,
}: ItemEditorProps) {
  const [loading, setLoading] = useState(false);
  const [styleOpen, setStyleOpen] = useState(false);
  const styles = useStyleSearch(item.styleNumber);
  const matches = styles.data ?? [];
  const metal = lists.metals.find((m) => m.code === item.metalCode);
  const auto = metal?.karat ? autoRate(metal.karat) : null;
  const goldRate = num(item.manualRate) ?? auto?.rate ?? 0;
  const price = priceItem(item, goldRate);
  const set = (patch: Partial<ItemRow>) => onChange({ ...item, ...patch });
  const setStone = (id: number, patch: Partial<StoneRow>) =>
    set({ stones: item.stones.map((s) => (s.id === id ? nextStone(s, patch, lists) : s)) });
  const known = (s: StoneRow) =>
    !s.code.trim() || !(s.type === "D" ? lists.diamonds : lists.stones).length ||
    (s.type === "D" ? lists.diamonds : lists.stones).some((m) => m.code === s.code.trim());

  async function loadStyle(code = item.styleNumber.trim()) {
    if (!code || loading) return;
    setStyleOpen(false);
    setLoading(true);
    try {
      const bom = await fetchStyle(code);
      const metalLine = bom.lines.find((l) => lists.metals.some((m) => m.code === l.code));
      const stones: StoneRow[] = [];
      let skipped = 0;
      for (const l of bom.lines) {
        if (l === metalLine) continue;
        const d = lists.diamonds.find((m) => m.code === l.code);
        const c = d ? undefined : lists.stones.find((m) => m.code === l.code);
        if (!d && !c) {
          skipped += 1;
          continue;
        }
        const base = emptyStone(d ? "D" : "C");
        stones.push(
          nextStone(
            base,
            {
              code: l.code,
              size: l.size ?? "",
              carats: l.weight ? round2(l.weight).toFixed(2) : "",
              ...(l.pieces ? { pieces: String(l.pieces) } : {}),
            },
            lists,
          ),
        );
      }
      const heavyMetal = bom.lines.find((l) => master?.metals.some((m) => m.code === l.code)) && !metalLine;
      onChange({
        ...item,
        styleNumber: bom.styleCode,
        itemType: lists.itemTypes.some((t) => t.code === bom.itemType) ? bom.itemType! : item.itemType,
        size: bom.itemSize ?? item.size,
        sizeUnit: bom.itemSize ? "" : item.sizeUnit,
        metalCode: metalLine?.code ?? item.metalCode,
        weight: metalLine ? String(metalLine.weight) : item.weight,
        stones,
      });
      toast.success(`Loaded ${bom.styleCode}`, {
        description: [
          `${stones.length} stone line${stones.length === 1 ? "" : "s"}`,
          heavyMetal ? "its gold is not 9/12/14/18/22/24K — pick the metal" : "",
          skipped ? `${skipped} other line${skipped === 1 ? "" : "s"} (charges) left out` : "",
        ]
          .filter(Boolean)
          .join(" · "),
      });
    } catch (e) {
      toast.error(apiErrorMessage(e, `No style ${code} in the item master.`));
    } finally {
      setLoading(false);
    }
  }

  /** The % box every line of the table carries. */
  const discountBox = (label: string, value: string, onValue: (v: string) => void) => (
    <Input
      aria-label={label}
      inputMode="decimal"
      value={value}
      onChange={(e) => onValue(unsigned(e.target.value))}
      placeholder="0"
      aria-invalid={(num(value) ?? 0) > 100}
      className={cn("px-2", (num(value) ?? 0) > 100 && "border-destructive")}
    />
  );
  const amount = (value: number) => (
    <span className="num flex items-center justify-end text-sm">{formatINR(value)}</span>
  );

  return (
    <div className="rounded-lg border p-3" onFocusCapture={onFocus}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <Sparkles className="h-4 w-4 text-gold-strong" />
          Item {index + 1}
        </p>
        <div className="flex items-center gap-2">
          <span className="num text-sm font-medium">{formatINR(price.subtotal)}</span>
          {onRemove ? (
            <Button type="button" variant="ghost" size="icon" onClick={onRemove}>
              <Trash2 className="h-4 w-4" />
              <span className="sr-only">Remove item {index + 1}</span>
            </Button>
          ) : null}
        </div>
      </div>

      {/* What it is */}
      <div className="grid gap-3 sm:grid-cols-[1.2fr_1.2fr_1fr]">
        <div className="grid gap-1.5">
          <Label>Item type</Label>
          <Select value={item.itemType} onValueChange={(v) => set({ itemType: v })}>
            <SelectTrigger aria-label={`Item ${index + 1} type`}>
              <SelectValue placeholder="Ring, pendant…" />
            </SelectTrigger>
            <SelectContent>
              {lists.itemTypes.map((t) => (
                <SelectItem key={t.code} value={t.code}>
                  <span className="font-mono text-xs text-muted-foreground">{t.code}</span> {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`qb-style-${item.id}`}>Style no.</Label>
          <div className="flex gap-1.5">
            <div className="relative flex-1">
              <Input
                id={`qb-style-${item.id}`}
                value={item.styleNumber}
                onChange={(e) => {
                  set({ styleNumber: e.target.value });
                  setStyleOpen(true);
                }}
                onFocus={() => setStyleOpen(true)}
                // A click inside the list is a mousedown first; closing on blur
                // immediately would eat it, so let the click land.
                onBlur={() => window.setTimeout(() => setStyleOpen(false), 150)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void loadStyle(matches.length === 1 ? matches[0].styleCode : undefined);
                  } else if (e.key === "Escape") {
                    setStyleOpen(false);
                  }
                }}
                placeholder="Search e.g. 10778 or RG"
                autoComplete="off"
              />
              {styleOpen && item.styleNumber.trim() ? (
                <div className="absolute z-50 mt-1 max-h-60 w-full overflow-y-auto rounded-md border bg-popover p-1 shadow-md">
                  {matches.length === 0 ? (
                    <p className="px-2 py-1.5 text-xs text-muted-foreground">
                      {styles.isFetching ? "Searching…" : "No style matches that."}
                    </p>
                  ) : (
                    matches.map((s) => (
                      <button
                        key={s.styleCode}
                        type="button"
                        onClick={() => void loadStyle(s.styleCode)}
                        className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                      >
                        <span className="font-medium">{s.styleCode}</span>
                        <span className="text-xs text-muted-foreground">
                          {[s.itemType, s.itemSize].filter(Boolean).join(" · ")}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              ) : null}
            </div>
            <Button
              type="button"
              variant="outline"
              size="icon"
              title="Load the design's materials (Enter)"
              disabled={!item.styleNumber.trim() || loading}
              onClick={() => void loadStyle()}
            >
              <Download className="h-4 w-4" />
              <span className="sr-only">Load style</span>
            </Button>
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`qb-size-${item.id}`}>Size</Label>
          <div className="flex gap-1.5">
            <Input
              id={`qb-size-${item.id}`}
              value={item.size}
              maxLength={24}
              // A hyphen inside a size is a range ("3.5-4"); a leading one is a
              // minus sign, and no ring is minus twelve.
              onChange={(e) =>
                set({ size: e.target.value.replace(/[^A-Za-z0-9 ./-]/g, "").replace(/^-+/, "") })
              }
              placeholder="12, 2.6, IND 13"
            />
            <select
              aria-label="Size unit"
              value={item.sizeUnit}
              onChange={(e) => set({ sizeUnit: e.target.value as ItemRow["sizeUnit"] })}
              className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
            >
              <option value="">—</option>
              <option value="cm">cm</option>
              <option value="inch">inch</option>
            </select>
          </div>
        </div>
      </div>

      {/* Materials: the gold, the stones and the making, as the bill lists them */}
      <div className="mt-3 space-y-1.5">
        <div className="hidden grid-cols-[3.6rem_1.7fr_3.4rem_5rem_5.6rem_4.2rem_6rem_2rem] gap-1.5 px-1 text-[11px] font-medium text-muted-foreground md:grid">
          <span />
          <span>Code</span>
          <span>Pcs</span>
          <span>Weight</span>
          <span>Rate</span>
          <span>Dis %</span>
          <span className="text-right">Amount</span>
          <span />
        </div>

        {/* Gold */}
        <div className={ROW}>
          <span className={cn(KIND, "border-amber-300 text-amber-700 dark:text-amber-300")}>Gold</span>
          <Input
            aria-label={`Item ${index + 1} metal`}
            list="qb-metals"
            value={item.metalCode}
            // Type to search: "14", "WG", "G18"… and pick. A new metal is a new
            // rate, so a rate typed for the old one is dropped.
            onChange={(e) => set({ metalCode: e.target.value.toUpperCase().trim(), manualRate: "" })}
            placeholder="Metal — type 14, WG, G18YG…"
            autoComplete="off"
            aria-invalid={!!item.metalCode && !metal}
            className={cn(!!item.metalCode && !metal && "border-destructive")}
          />
          <span />
          <div className="col-span-3 grid grid-cols-4 gap-x-1.5 gap-y-0.5 md:contents">
            {cap("Weight (g)")}
            {cap("Rate ₹/g")}
            {cap("Dis %")}
            {cap("Amount")}
            <Input
              aria-label="Gold weight in grams"
              className="px-2"
              inputMode="decimal"
              value={item.weight}
              onChange={(e) => set({ weight: unsigned(e.target.value) })}
              placeholder="0.000 g"
            />
            <Input
              aria-label="Gold rate per gram"
              className="px-2"
              inputMode="decimal"
              value={item.manualRate}
              onChange={(e) => set({ manualRate: unsigned(e.target.value) })}
              placeholder={auto ? String(auto.rate) : "₹/g"}
              title="Today's rate unless you type another"
            />
            {discountBox("Gold discount %", item.metalDiscount, (v) => set({ metalDiscount: v }))}
            {amount(price.metal - price.metalOff)}
          </div>
        </div>
        {auto && !item.manualRate ? (
          <div className="px-1">
            <Badge variant={auto.fallback || auto.stale ? "destructive" : "outline"} className="text-[10px]">
              {auto.note}
            </Badge>
          </div>
        ) : null}

        {/* Diamonds and colour stones */}
        {item.stones.map((s, i) => (
          <div key={s.id} className={ROW}>
            <button
              type="button"
              title={s.type === "D" ? "Diamond — switch to colour stone" : "Colour stone — switch to diamond"}
              onClick={() => setStone(s.id, { type: s.type === "D" ? "C" : "D", code: "" })}
              className={cn(
                KIND,
                s.type === "D" ? "border-sky-300 text-sky-700 dark:text-sky-300" : "border-rose-300 text-rose-700 dark:text-rose-300",
              )}
            >
              {s.type}
            </button>
            <Input
              aria-label={`${s.type === "D" ? "Diamond" : "Colour stone"} code`}
              list={`qb-codes-${s.type}`}
              value={s.code}
              onChange={(e) => setStone(s.id, { code: e.target.value.toUpperCase() })}
              placeholder={s.type === "D" ? "LG-RND-VVS-E-F" : "LG-RB-OVL"}
              autoComplete="off"
              aria-invalid={!known(s)}
              className={cn(!known(s) && "border-destructive")}
            />
            <Button type="button" variant="ghost" size="icon" className="md:order-last" onClick={() => set({ stones: item.stones.filter((x) => x.id !== s.id) })}>
              <Trash2 className="h-4 w-4" />
              <span className="sr-only">Remove stone {i + 1}</span>
            </Button>
            <div className="col-span-3 grid grid-cols-[2.6rem_1fr_1.25fr_2.9rem_auto] gap-x-1.5 gap-y-0.5 md:contents">
              {cap("Pcs")}
              {cap("Carats")}
              {cap("Rate/ct")}
              {cap("Dis %")}
              {cap("Amount")}
              <Input
                aria-label="Pieces"
              className="px-2"
                inputMode="numeric"
                value={s.pieces}
                onChange={(e) => setStone(s.id, { pieces: e.target.value.replace(/\D/g, "") })}
                placeholder="Pcs"
              />
              <Input
                aria-label="Carats"
              className="px-2"
                inputMode="decimal"
                value={s.carats}
                onChange={(e) => setStone(s.id, { carats: unsigned(e.target.value) })}
                onBlur={() => {
                  const c = num(s.carats);
                  if (c != null) setStone(s.id, { carats: round2(c).toFixed(2) });
                }}
                placeholder="0.00 ct"
              />
              <Input
                aria-label="Rate per carat"
              className="px-2"
                inputMode="decimal"
                value={s.rate}
                onChange={(e) => setStone(s.id, { rate: unsigned(e.target.value), rateAuto: false })}
                placeholder="₹/ct"
              />
              {discountBox(`${s.type === "D" ? "Diamond" : "Colour stone"} discount %`, s.discount, (v) =>
                setStone(s.id, { discount: v }),
              )}
              {amount((price.stones[i] ?? 0) - (price.stoneOffs[i] ?? 0))}
            </div>
          </div>
        ))}

        {/* Making: its rate per gram on the gold's weight */}
        <div className={ROW}>
          <span className={cn(KIND, "text-muted-foreground")}>Making</span>
          <span className="flex h-9 items-center px-1 text-xs text-muted-foreground">
            {price.weight > 0 ? `on ${price.weight} g` : "per gram of the gold"}
          </span>
          <span />
          <div className="col-span-3 grid grid-cols-3 gap-x-1.5 gap-y-0.5 md:contents">
            <span className="hidden md:block" />
            {cap("Making ₹/g")}
            {cap("Dis %")}
            {cap("Amount")}
            <Input
              aria-label="Making per gram"
              className="px-2"
              inputMode="decimal"
              value={item.makingRate}
              onChange={(e) => set({ makingRate: unsigned(e.target.value) })}
              placeholder="₹/g"
            />
            {discountBox("Making discount %", item.makingDiscount, (v) => set({ makingDiscount: v }))}
            {amount(price.making - price.makingOff)}
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5 pt-1">
          <Button type="button" variant="outline" size="sm" title="Alt+D" onClick={() => set({ stones: [...item.stones, emptyStone("D")] })}>
            <Plus className="h-4 w-4" /> Diamond
          </Button>
          <Button type="button" variant="outline" size="sm" title="Alt+C" onClick={() => set({ stones: [...item.stones, emptyStone("C")] })}>
            <Plus className="h-4 w-4" /> Colour stone
          </Button>
        </div>
      </div>

      <div className="mt-3 grid gap-1.5">
        <Label htmlFor={`qb-remark-${item.id}`}>Remark</Label>
        <Input
          id={`qb-remark-${item.id}`}
          value={item.remark}
          maxLength={500}
          onChange={(e) => set({ remark: e.target.value })}
          placeholder="Anything the lists cannot say: a stone not in the master, engraving, what the customer asked for"
        />
      </div>
    </div>
  );
}
