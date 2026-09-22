"use client";

import { useState } from "react";
import { Download, Gem, Plus, Sparkles, Trash2 } from "lucide-react";
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
  size: string;
  pieces: string;
  carats: string;
  rate: string;
  multiplier: string;
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
  stones: StoneRow[];
}

let lastId = 0;
const newId = () => (lastId += 1);

export function emptyItem(): ItemRow {
  return {
    id: newId(), itemType: "", styleNumber: "", size: "", sizeUnit: "", metalCode: "",
    weight: "", manualRate: "", makingRate: "", stones: [],
  };
}

export function emptyStone(type: "D" | "C"): StoneRow {
  return { id: newId(), type, code: "", size: "", pieces: "", carats: "", rate: "", multiplier: "1", rateAuto: true };
}

/** A typed number, or undefined when blank or not a number. */
export function num(v: string): number | undefined {
  const n = Number(v);
  return v.trim() !== "" && Number.isFinite(n) ? n : undefined;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Digits and one decimal point only: no minus sign can be typed. */
const unsigned = (v: string) => v.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1");

/** The size as sent: "12", "16 inch", "5.5 cm". */
export const sizeText = (item: ItemRow) => {
  const s = item.size.trim();
  return s && item.sizeUnit ? `${s} ${item.sizeUnit}` : s;
};

/** What an item comes to, worked out the way the server does. */
export function priceItem(item: ItemRow, goldRate: number) {
  const weight = num(item.weight) ?? 0;
  const metal = weight * goldRate;
  const making = round2((num(item.makingRate) ?? 0) * weight);
  const stones = item.stones.map((s) =>
    round2((num(s.carats) ?? 0) * (num(s.rate) ?? 0) * (num(s.multiplier) ?? 1)),
  );
  const stoneTotal = round2(stones.reduce((a, b) => a + b, 0));
  return { weight, metal, making, stones, stoneTotal, subtotal: metal + making + stoneTotal };
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

/** Stone codes and sizes for the type-to-search boxes; rendered once per builder. */
export function MaterialDatalists({ lists }: { lists: Lists }) {
  return (
    <>
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
      <datalist id="qb-sizes">
        {lists.sizes.map((s) => (
          <option key={s.code} value={s.code}>
            {[s.mm, s.caratPerPiece ? `${s.caratPerPiece} ct/pc` : ""].filter(Boolean).join(" · ")}
          </option>
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

/**
 * One item of a sale quote: what it is (type, design, size), its gold (item
 * code, weight, rate, making per gram) and its diamonds (D) and colour stones
 * (C) by item-master code. Entering a style number loads the design's default
 * materials, which are then changed for the customer.
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
  const styles = useStyleSearch(item.styleNumber);
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

  async function loadStyle() {
    const code = item.styleNumber.trim();
    if (!code || loading) return;
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
            <Input
              id={`qb-style-${item.id}`}
              list={`qb-styles-${item.id}`}
              value={item.styleNumber}
              onChange={(e) => set({ styleNumber: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void loadStyle();
                }
              }}
              placeholder="e.g. ALR-0006"
              autoComplete="off"
            />
            <datalist id={`qb-styles-${item.id}`}>
              {(styles.data ?? []).map((s) => (
                <option key={s.styleCode} value={s.styleCode} />
              ))}
            </datalist>
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
              onChange={(e) => set({ size: e.target.value.replace(/[^A-Za-z0-9 ./-]/g, "") })}
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

      {/* Gold */}
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="grid gap-1.5">
          <Label>Metal</Label>
          <Select value={item.metalCode} onValueChange={(v) => set({ metalCode: v, manualRate: "" })}>
            <SelectTrigger aria-label={`Item ${index + 1} metal`}>
              <SelectValue placeholder="G14YG…" />
            </SelectTrigger>
            <SelectContent>
              {lists.metals.map((m) => (
                <SelectItem key={m.code} value={m.code}>
                  {m.code} <span className="text-xs text-muted-foreground">{m.karat}K {m.tone ?? ""}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`qb-wt-${item.id}`}>Weight (g)</Label>
          <Input
            id={`qb-wt-${item.id}`}
            inputMode="decimal"
            value={item.weight}
            onChange={(e) => set({ weight: unsigned(e.target.value) })}
            placeholder="0.000"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`qb-rate-${item.id}`}>Gold rate (₹/g)</Label>
          <Input
            id={`qb-rate-${item.id}`}
            inputMode="decimal"
            value={item.manualRate}
            onChange={(e) => set({ manualRate: unsigned(e.target.value) })}
            placeholder={auto ? String(auto.rate) : "Pick metal"}
            title="Today's rate unless you type another"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`qb-making-${item.id}`}>Making (₹/g)</Label>
          <Input
            id={`qb-making-${item.id}`}
            inputMode="decimal"
            value={item.makingRate}
            onChange={(e) => set({ makingRate: unsigned(e.target.value) })}
            placeholder="0"
          />
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {auto && !item.manualRate ? (
          auto.fallback || auto.stale ? (
            <Badge variant="destructive" className="text-[10px]">{auto.note}</Badge>
          ) : (
            <Badge variant="outline" className="text-[10px]">{auto.note}</Badge>
          )
        ) : null}
        {price.weight > 0 ? (
          <span>
            Gold {formatINR(price.metal)} · Making {formatINR(price.making)}
            {num(item.makingRate) ? ` (${item.makingRate} × ${price.weight} g)` : ""}
          </span>
        ) : null}
      </div>

      {/* Diamonds and colour stones */}
      <div className="mt-3 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <Gem className="h-4 w-4 text-muted-foreground" />
            Diamonds &amp; stones
            {price.stoneTotal > 0 ? (
              <span className="num text-xs font-normal text-muted-foreground">{formatINR(price.stoneTotal)}</span>
            ) : null}
          </p>
          <div className="flex gap-1.5">
            <Button type="button" variant="outline" size="sm" title="Alt+D" onClick={() => set({ stones: [...item.stones, emptyStone("D")] })}>
              <Plus className="h-4 w-4" /> Diamond
            </Button>
            <Button type="button" variant="outline" size="sm" title="Alt+C" onClick={() => set({ stones: [...item.stones, emptyStone("C")] })}>
              <Plus className="h-4 w-4" /> Colour stone
            </Button>
          </div>
        </div>
        {item.stones.length ? (
          <div className="hidden grid-cols-[2.2rem_1.6fr_1fr_3.2rem_4.2rem_5rem_3.6rem_5rem_2rem] gap-1.5 px-1 text-[11px] font-medium text-muted-foreground md:grid">
            <span>Type</span>
            <span>Code</span>
            <span>Size</span>
            <span>Pcs</span>
            <span>Carats</span>
            <span>Rate/ct</span>
            <span title="Staff only — never printed">× Mult</span>
            <span className="text-right">Amount</span>
            <span />
          </div>
        ) : null}
        {item.stones.map((s, i) => (
          <div
            key={s.id}
            className="grid grid-cols-[2.2rem_1fr_2rem] gap-1.5 rounded-md bg-muted/30 p-1.5 md:grid-cols-[2.2rem_1.6fr_1fr_3.2rem_4.2rem_5rem_3.6rem_5rem_2rem] md:items-center md:bg-transparent md:p-0"
          >
            <button
              type="button"
              title={s.type === "D" ? "Diamond — switch to colour stone" : "Colour stone — switch to diamond"}
              onClick={() => setStone(s.id, { type: s.type === "D" ? "C" : "D", code: "" })}
              className={cn(
                "h-9 rounded-md border text-xs font-semibold",
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
            <div className="col-span-3 grid grid-cols-3 gap-x-1.5 gap-y-0.5 md:contents">
              <span className="text-[10px] text-muted-foreground md:hidden">Size</span>
              <span className="text-[10px] text-muted-foreground md:hidden">Pcs</span>
              <span className="text-[10px] text-muted-foreground md:hidden">Carats</span>
              <Input
                aria-label="Size"
                list="qb-sizes"
                value={s.size}
                onChange={(e) => setStone(s.id, { size: e.target.value })}
                placeholder="Size"
                autoComplete="off"
              />
              <Input
                aria-label="Pieces"
                inputMode="numeric"
                value={s.pieces}
                onChange={(e) => setStone(s.id, { pieces: e.target.value.replace(/\D/g, "") })}
                placeholder="Pcs"
              />
              <Input
                aria-label="Carats"
                inputMode="decimal"
                value={s.carats}
                onChange={(e) => setStone(s.id, { carats: unsigned(e.target.value) })}
                onBlur={() => {
                  const c = num(s.carats);
                  if (c != null) setStone(s.id, { carats: round2(c).toFixed(2) });
                }}
                placeholder="0.00"
              />
              <span className="text-[10px] text-muted-foreground md:hidden">Rate/ct</span>
              <span className="text-[10px] text-muted-foreground md:hidden">× Mult (staff)</span>
              <span className="text-[10px] text-muted-foreground md:hidden">Amount</span>
              <Input
                aria-label="Rate per carat"
                inputMode="decimal"
                value={s.rate}
                onChange={(e) => setStone(s.id, { rate: unsigned(e.target.value), rateAuto: false })}
                placeholder="₹/ct"
              />
              <Input
                aria-label="Multiplier (staff only)"
                title="Staff only — the customer sees rate × multiplier"
                inputMode="decimal"
                value={s.multiplier}
                onChange={(e) => setStone(s.id, { multiplier: unsigned(e.target.value) })}
                placeholder="1"
              />
              <span className="num flex items-center justify-end text-sm">{formatINR(price.stones[i] ?? 0)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
