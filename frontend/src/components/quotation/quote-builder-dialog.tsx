"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ImagePlus, Plus, Sparkles, Wrench, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { formatINR, formatPercent } from "@/lib/format";
import {
  GOLD_RATE_PER_GRAM,
  GST_RATE,
  type QuoteKind,
  type QuoteLine,
} from "@/lib/mock/quotation";
import {
  ADVANCE_MODE_OPTIONS,
  METAL_COLOR_PRESETS,
} from "@/lib/mock/timelines";
import {
  useConvertQuoteToOrder,
  useCreateQuote,
  useUploadQuotePhoto,
} from "@/lib/queries/quotes";
import { useMetalRates } from "@/lib/queries/integrations";
import { useMaterials } from "@/lib/queries/materials";
import { staleNote } from "@/components/rates/metal-rates-widget";
import { apiErrorMessage, cn, normalizeIndianMobile } from "@/lib/utils";
import {
  StoreScopeField,
  useStoreScope,
} from "@/components/common/store-scope-field";
import {
  MaterialDatalists,
  QuoteItemEditor,
  emptyItem,
  emptyStone,
  masterLists,
  num,
  priceItem,
  round2,
  sizeText,
  type AutoRate,
  type ItemRow,
} from "@/components/quotation/quote-item-editor";

const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** Metal colour for a custom order, from the gold item's tone. */
const TONE_COLOUR: Record<string, (typeof METAL_COLOR_PRESETS)[number]> = {
  YG: "Yellow gold",
  WG: "White gold",
  PG: "Rose gold",
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

type QuoteLineInput = Omit<QuoteLine, "id">;

interface QuoteBuilderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Module 2 — Quote builder. Round-2 merged Quotation + Custom-order flow.
 *
 * A sale quote is one or more items, each priced from the item master: gold by
 * item code and weight at today's rate, making per gram x weight, and diamonds
 * (D) and colour stones (C) by code and size at a rate per carat x a staff-only
 * multiplier. A style number loads the design's default materials. Discounts:
 * % off making, % off stones, then a flat amount; never into the gold. Repair
 * mode is making-only. The live preview mirrors the server formula.
 *
 * Keyboard: Alt+N new item, Alt+D diamond, Alt+C colour stone (on the item
 * being edited), Ctrl+Enter creates the quote.
 */
export function QuoteBuilderDialog({
  open,
  onOpenChange,
}: QuoteBuilderDialogProps) {
  const { targetStoreId, storeLabel, pickedStoreId, setPickedStoreId } =
    useStoreScope();
  const createQuote = useCreateQuote();
  const metalRates = useMetalRates();
  const materials = useMaterials();
  const uploadPhoto = useUploadQuotePhoto();
  const convertToOrder = useConvertQuoteToOrder();
  const lists = useMemo(() => masterLists(materials.data), [materials.data]);

  const [mode, setMode] = useState<QuoteKind>("sale");
  // Inline validation errors, keyed by field. Cleared per-field on change.
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Shared
  const [customer, setCustomer] = useState("");
  const [phone, setPhone] = useState("");
  // Kaccha ("@") estimate — rough, no-GST, kept head-office-only.
  const [isKaccha, setIsKaccha] = useState(false);

  // Sale — the items, and which one the keyboard shortcuts add stones to.
  const [items, setItems] = useState<ItemRow[]>(() => [emptyItem()]);
  const [activeItem, setActiveItem] = useState(0);

  // Repair
  const [grossWeight, setGrossWeight] = useState("");
  const [repairDetails, setRepairDetails] = useState("");
  const [remarks, setRemarks] = useState("");
  const [repairMaking, setRepairMaking] = useState("");

  // Discounts: % off making, % off diamonds and stones, a flat amount at the end.
  const [makingDiscount, setMakingDiscount] = useState("");
  const [stoneDiscount, setStoneDiscount] = useState("");
  const [additionalDiscount, setAdditionalDiscount] = useState("");

  // Reference photos (uploaded after the quote id is known)
  const [refFiles, setRefFiles] = useState<File[]>([]);
  const refInput = useRef<HTMLInputElement>(null);

  // Custom-order details (revealed for the "Custom Order" action)
  const [customOpen, setCustomOpen] = useState(false);
  const [metalColorSel, setMetalColorSel] = useState("");
  const [metalColorOther, setMetalColorOther] = useState("");
  const [deliveryDate, setDeliveryDate] = useState("");
  const [advance, setAdvance] = useState("");
  const [advanceMode, setAdvanceMode] = useState("");

  const firstMetal = lists.metals.find((m) => m.code === items[0]?.metalCode);
  const metalColor =
    metalColorSel === "other"
      ? metalColorOther.trim()
      : metalColorSel || (firstMetal?.tone ? TONE_COLOUR[firstMetal.tone] ?? "" : "");
  const itemTypeName = (code: string) => lists.itemTypes.find((t) => t.code === code)?.name ?? "";

  /*
   * Object-URL previews are DERIVED from the picked files, not state that
   * happens to follow them. Computing them in an effect meant one render with
   * the previous files' URLs still on screen; a memo has the right value on the
   * first render, and the effect below exists only to release them.
   */
  const refUrls = useMemo(() => refFiles.map((f) => URL.createObjectURL(f)), [refFiles]);
  useEffect(() => () => refUrls.forEach((u) => URL.revokeObjectURL(u)), [refUrls]);

  /*
   * "Today's rate" is the rate on record for this store. GOLD_RATE_PER_GRAM
   * survives only as the last-resort fallback for a fresh deployment with no
   * MetalRate rows yet, and a quote cannot be saved on it (see submit).
   */
  function autoRate(karat: number): AutoRate {
    const live = metalRates.rateFor(karat);
    return {
      rate: live?.ratePerGram ?? GOLD_RATE_PER_GRAM[karat] ?? 0,
      stale: live?.stale ?? false,
      fallback: live == null,
      note: live == null
        ? "No rate on record — type today's"
        : live.stale
          ? `${karat}K · ${staleNote(live) ?? "out of date"}`
          : `${karat}K · ${live.derived ? "derived from 24K by purity" : "today's rate"}`,
    };
  }
  const karatOf = (item: ItemRow) => lists.metals.find((m) => m.code === item.metalCode)?.karat ?? 0;
  const goldRateOf = (item: ItemRow) =>
    num(item.manualRate) ?? (karatOf(item) ? autoRate(karatOf(item)).rate : 0);

  const repairMakingNum = num(repairMaking) ?? 0;
  const disc = {
    making: Math.min(Math.max(num(makingDiscount) ?? 0, 0), 100),
    stone: Math.min(Math.max(num(stoneDiscount) ?? 0, 0), 100),
    additional: Math.max(num(additionalDiscount) ?? 0, 0),
  };

  const preview = (() => {
    // Kaccha estimates carry no GST — mirror the server (GST = 0, grand =
    // taxable). The discounts come off making + stones before tax, exactly as
    // the server computes them.
    const rate = isKaccha ? 0 : GST_RATE;
    let metal = 0;
    let making = repairMakingNum;
    let stones = 0;
    if (mode === "sale") {
      making = 0;
      for (const it of items) {
        const p = priceItem(it, goldRateOf(it));
        metal += p.metal;
        making += p.making;
        stones += p.stoneTotal;
      }
    }
    const makingOff = round2((making * disc.making) / 100);
    const byPercent = (making * disc.making + stones * disc.stone) / 100;
    const discount = round2(byPercent + disc.additional);
    const taxable = metal + making + stones - discount;
    const gst = taxable * rate;
    return {
      metal,
      making,
      stones,
      makingOff,
      stoneOff: round2(byPercent - makingOff),
      additional: disc.additional,
      discount,
      overDiscount: disc.additional > round2(making + stones - byPercent) + 0.001,
      taxable,
      gst,
      grand: taxable + gst,
    };
  })();

  const busy =
    createQuote.isPending ||
    uploadPhoto.isPending ||
    convertToOrder.isPending;

  const updateItem = (i: number, next: ItemRow) =>
    setItems((list) => list.map((x, idx) => (idx === i ? next : x)));
  function addItem() {
    setItems((list) => [...list, emptyItem()]);
    setActiveItem(items.length);
  }
  function addStone(type: "D" | "C") {
    const i = Math.min(activeItem, items.length - 1);
    setItems((list) =>
      list.map((x, idx) => (idx === i ? { ...x, stones: [...x.stones, emptyStone(type)] } : x)),
    );
  }

  function onPickRefs(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    const ok = picked.filter((f) => f.size <= MAX_FILE_BYTES);
    if (ok.length !== picked.length) {
      toast.error("Some images exceeded 8 MB and were skipped.");
    }
    if (ok.length) setRefFiles((prev) => [...prev, ...ok]);
    e.target.value = "";
  }
  function removeRef(i: number) {
    setRefFiles((prev) => prev.filter((_, idx) => idx !== i));
  }

  function reset() {
    setMode("sale");
    setErrors({});
    setCustomer("");
    setPhone("");
    setIsKaccha(false);
    setItems([emptyItem()]);
    setActiveItem(0);
    setGrossWeight("");
    setRepairDetails("");
    setRemarks("");
    setRepairMaking("");
    setMakingDiscount("");
    setStoneDiscount("");
    setAdditionalDiscount("");
    setRefFiles([]);
    setCustomOpen(false);
    setMetalColorSel("");
    setMetalColorOther("");
    setDeliveryDate("");
    setAdvance("");
    setAdvanceMode("");
    if (refInput.current) refInput.current.value = "";
  }

  /** Build the payload lines for the active mode. */
  function buildLines(): QuoteLineInput[] {
    if (mode === "repair") {
      return [
        {
          description: repairDetails.trim() || "Repair / service",
          karat: 0,
          weightGrams: 0,
          goldRatePerGram: 0,
          makingCharges: repairMakingNum,
          stoneCharges: 0,
          caratWeight: 0,
        },
      ];
    }
    return items
      .filter((it) => (num(it.weight) ?? 0) > 0 || it.stones.length > 0)
      .map((it) => {
        const p = priceItem(it, goldRateOf(it));
        const hasGold = p.weight > 0;
        return {
          description: itemTypeName(it.itemType) || "Item",
          karat: hasGold ? karatOf(it) : 0,
          weightGrams: p.weight,
          goldRatePerGram: hasGold ? goldRateOf(it) : 0,
          makingCharges: p.making,
          stoneCharges: p.stoneTotal,
          caratWeight: it.stones.reduce((s, x) => s + (num(x.carats) ?? 0), 0),
          styleNumber: it.styleNumber.trim() || undefined,
          size: sizeText(it) || undefined,
          metalCode: hasGold ? it.metalCode : undefined,
          makingRatePerGram: hasGold ? num(it.makingRate) ?? 0 : undefined,
          stones: it.stones.length
            ? it.stones.map((s) => ({
                type: s.type,
                code: s.code.trim(),
                size: s.size.trim() || undefined,
                pieces: num(s.pieces),
                carats: round2(num(s.carats) ?? 0),
                ratePerCt: num(s.rate) ?? 0,
                multiplier: num(s.multiplier) ?? 1,
              }))
            : undefined,
        };
      });
  }

  /** What stops the items being priced, if anything. */
  function itemProblem(): string | null {
    const priced = items.filter((it) => (num(it.weight) ?? 0) > 0 || it.stones.length > 0);
    if (!priced.length) return "Add a gold weight or a diamond to an item.";
    for (const [i, it] of items.entries()) {
      if (!priced.includes(it)) continue;
      const n = `Item ${i + 1}`;
      if (!it.itemType) return `${n}: pick the item type.`;
      if ((num(it.weight) ?? 0) > 0 && !karatOf(it)) return `${n}: pick the metal (9K, 10K, 14K or 18K).`;
      if ((num(it.weight) ?? 0) > 0 && !num(it.manualRate)) {
        const a = autoRate(karatOf(it));
        // A quote freezes the gold rate it was priced at. It must not freeze a
        // built-in default or a rate that has gone out of date while looking
        // like today's: with either, the person confirms today's by typing it.
        if (a.fallback || a.stale) return `${n}: the ${karatOf(it)}K rate is not today's — type today's rate.`;
      }
      for (const s of it.stones) {
        const list = s.type === "D" ? lists.diamonds : lists.stones;
        if (!s.code.trim()) return `${n}: a ${s.type === "D" ? "diamond" : "colour stone"} has no code.`;
        if (list.length && !list.some((m) => m.code === s.code.trim())) {
          return `${n}: ${s.code} is not a ${s.type === "D" ? "diamond" : "colour stone"} code — pick one from the list.`;
        }
        if (!((num(s.carats) ?? 0) > 0)) return `${n}: ${s.code} needs its carats.`;
      }
      if (sizeText(it).length > 30) return `${n}: the size is too long.`;
    }
    return null;
  }

  /** Best-effort upload of every picked reference photo. */
  async function uploadPhotos(id: string) {
    let failed = false;
    await Promise.all(
      refFiles.map((f) =>
        uploadPhoto.mutateAsync({ id, file: f, label: "Reference" }).catch(() => {
          failed = true;
        }),
      ),
    );
    if (failed) {
      toast.warning(
        "Quote saved, but one or more photos failed to upload. You can re-attach them from the quote.",
      );
    }
  }

  function summaryHtml(ref: string): string {
    const rows = buildLines()
      .map(
        (l) =>
          `<tr><td>${escapeHtml([l.description, l.size ? `size ${l.size}` : ""].filter(Boolean).join(" · "))}</td><td style="text-align:right">${formatINR(
            l.weightGrams * l.goldRatePerGram +
              l.makingCharges +
              l.stoneCharges,
          )}</td></tr>`,
      )
      .join("");
    return `<!doctype html><html><head><title>${escapeHtml(
      ref,
    )}</title><meta charset="utf-8"/><style>
      body{font-family:system-ui,Segoe UI,sans-serif;padding:24px;color:#1a1a1a}
      h1{font-size:18px;margin:0 0 2px}
      .muted{color:#666;font-size:12px;margin:0 0 16px}
      table{width:100%;border-collapse:collapse;font-size:13px}
      td{padding:6px 0;border-bottom:1px solid #eee}
      .tot td{border:0;padding:3px 0}
      .grand td{font-weight:700;border-top:2px solid #333;padding-top:8px}
    </style></head><body>
      <h1>${escapeHtml(ref)} · ${mode === "repair" ? "Repair" : "Sale"} quote</h1>
      <p class="muted">${escapeHtml(customer.trim())}${
        phone.trim() ? " · " + escapeHtml(phone.trim()) : ""
      } · ${escapeHtml(storeLabel)}</p>
      <table><tbody>${rows}</tbody></table>
      <table class="tot" style="margin-top:16px"><tbody>
        ${
          preview.discount > 0
            ? `<tr><td>Discount</td><td style="text-align:right">- ${formatINR(preview.discount)}</td></tr>`
            : ""
        }
        <tr><td>Taxable</td><td style="text-align:right">${formatINR(
          preview.taxable,
        )}</td></tr>
        <tr><td>GST @ ${formatPercent(GST_RATE * 100, 0)}</td><td style="text-align:right">${formatINR(
          preview.gst,
        )}</td></tr>
        <tr class="grand"><td>Grand total</td><td style="text-align:right">${formatINR(
          preview.grand,
        )}</td></tr>
      </tbody></table>
    </body></html>`;
  }

  function printSummary(html: string) {
    const w = window.open("", "_blank", "width=520,height=680");
    if (!w) {
      toast.error("Enable pop-ups to print the quote summary.");
      return;
    }
    w.document.write(html);
    w.document.close();
    w.focus();
    w.print();
  }

  async function submit(asCustomOrder: boolean) {
    if (busy) return;
    if (!targetStoreId) {
      toast.error("Select a store to raise this quote at.");
      return;
    }
    const name = customer.trim();
    // Inline-validate the required identity fields first; toast is the summary.
    const next: Record<string, string> = {};
    if (!name) next.customer = "Customer name is required.";
    // Name must contain a letter, not just digits/spaces (backend @Matches).
    else if (!/[^\d\s]/.test(name))
      next.customer = "Enter a valid name (letters, not just numbers).";
    // Phone is mandatory on quote creation and must be a valid Indian mobile —
    // the backend enforces @IsIndianMobile, so block/normalise client-side.
    const normalizedPhone = normalizeIndianMobile(phone);
    if (!phone.trim()) next.phone = "Phone number is required.";
    else if (!normalizedPhone)
      next.phone = "Enter a valid 10-digit mobile number.";
    if (Object.keys(next).length > 0) {
      setErrors(next);
      toast.error("Please fill in the required fields.");
      return;
    }
    if (mode === "sale") {
      const problem = itemProblem();
      if (problem) {
        toast.error(problem);
        return;
      }
    } else if (repairMakingNum <= 0) {
      toast.error("Enter a making charge for the repair.");
      return;
    }
    if (preview.overDiscount) {
      toast.error("The discount comes to more than the making and diamonds. Gold is never discounted.");
      return;
    }

    try {
      const quote = await createQuote.mutateAsync({
        storeId: targetStoreId,
        customerName: name,
        phone: normalizedPhone ?? undefined,
        kind: mode,
        isKaccha: isKaccha || undefined,
        remarks: mode === "repair" ? remarks.trim() || undefined : undefined,
        grossWeightG: mode === "repair" ? num(grossWeight) : undefined,
        makingDiscountPercent: disc.making || undefined,
        stoneDiscountPercent: disc.stone || undefined,
        additionalDiscount: disc.additional || undefined,
        lines: buildLines(),
      });

      await uploadPhotos(quote.id);

      if (asCustomOrder) {
        // The item type and size travel on the quote's first item.
        const res = await convertToOrder.mutateAsync({
          id: quote.id,
          metalColor: metalColor || undefined,
          deliveryDate: deliveryDate || undefined,
          advanceReceived: num(advance),
          advanceMode: advanceMode || undefined,
        });
        toast.success(`Custom order ${res.order.ref} created`, {
          description: `Quote ${quote.ref} accepted and routed to the timeline / back office.`,
        });
      } else {
        const html = summaryHtml(quote.ref);
        // "created", not "created & shared" — nothing is sent from here. The
        // sharing action lives on the quote itself; saying it had already gone
        // out meant a rep could walk away believing the customer had the price.
        toast.success(`Quote ${quote.ref} created`, {
          description: `${formatINR(quote.totals?.grandTotal ?? preview.grand)} · ready for ${name}.`,
          action: { label: "Print", onClick: () => printSummary(html) },
        });
      }
      reset();
      onOpenChange(false);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Could not create the quote. Please try again."));
    }
  }

  function onCustomOrderClick() {
    // First tap reveals the custom-order fields; second tap submits.
    if (!customOpen) {
      setCustomOpen(true);
      return;
    }
    void submit(true);
  }

  function onShortcut(e: React.KeyboardEvent) {
    if (e.ctrlKey && e.key === "Enter") {
      e.preventDefault();
      void submit(false);
      return;
    }
    if (!e.altKey || mode !== "sale") return;
    const key = e.key.toLowerCase();
    if (key === "n") addItem();
    else if (key === "d") addStone("D");
    else if (key === "c") addStone("C");
    else return;
    e.preventDefault();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-4xl" onKeyDown={onShortcut}>
        <DialogHeader>
          <DialogTitle>New quote</DialogTitle>
          <DialogDescription>
            Raised at {storeLabel}. Gold is priced at today&apos;s rate unless you
            type another.
          </DialogDescription>
        </DialogHeader>

        <MaterialDatalists lists={lists} />

        <div className="grid gap-4">
          <StoreScopeField value={pickedStoreId} onChange={setPickedStoreId} />

          <div className="grid gap-3 sm:grid-cols-[auto_1fr_1fr]">
            <div className="grid gap-1.5">
              <Label>Quote type</Label>
              <Tabs value={mode} onValueChange={(v) => setMode(v as QuoteKind)}>
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="sale">
                    <Sparkles className="mr-1.5 h-4 w-4" />
                    Sale
                  </TabsTrigger>
                  <TabsTrigger value="repair">
                    <Wrench className="mr-1.5 h-4 w-4" />
                    Repair
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="qb-cust">
                Customer name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="qb-cust"
                value={customer}
                aria-invalid={!!errors.customer}
                onChange={(e) => {
                  setCustomer(e.target.value);
                  setErrors((p) => ({ ...p, customer: "" }));
                }}
                placeholder="e.g. Meera Iyer"
              />
              {errors.customer ? (
                <p className="mt-1 text-xs text-destructive">{errors.customer}</p>
              ) : null}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="qb-phone">
                Phone <span className="text-destructive">*</span>
              </Label>
              <Input
                id="qb-phone"
                value={phone}
                aria-invalid={!!errors.phone}
                onChange={(e) => {
                  setPhone(e.target.value);
                  setErrors((p) => ({ ...p, phone: "" }));
                }}
                placeholder="+91 ..."
              />
              {errors.phone ? (
                <p className="mt-1 text-xs text-destructive">{errors.phone}</p>
              ) : null}
            </div>
          </div>

          {/* Kaccha ("@") estimate — no-GST, head-office-only */}
          <div className="flex items-center justify-between gap-4 rounded-lg border bg-muted/30 px-3 py-2">
            <Label htmlFor="qb-kaccha" className="text-sm font-normal">
              Kaccha estimate — no GST, kept private to head office
            </Label>
            <button
              id="qb-kaccha"
              type="button"
              role="switch"
              aria-checked={isKaccha}
              aria-label="Kaccha estimate — no GST"
              onClick={() => setIsKaccha((v) => !v)}
              className={cn(
                "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                isKaccha ? "bg-primary" : "bg-input",
              )}
            >
              <span
                className={cn(
                  "inline-block h-5 w-5 transform rounded-full bg-background shadow-sm transition-transform",
                  isKaccha ? "translate-x-5" : "translate-x-0.5",
                )}
              />
            </button>
          </div>

          {mode === "sale" ? (
            <div className="grid gap-3">
              {items.map((it, i) => (
                <QuoteItemEditor
                  key={it.id}
                  index={i}
                  item={it}
                  lists={lists}
                  master={materials.data}
                  autoRate={autoRate}
                  onChange={(nextItem) => updateItem(i, nextItem)}
                  onRemove={items.length > 1 ? () => setItems((list) => list.filter((x) => x.id !== it.id)) : undefined}
                  onFocus={() => setActiveItem(i)}
                />
              ))}
              <Button type="button" variant="outline" size="sm" className="justify-self-start" title="Alt+N" onClick={addItem}>
                <Plus className="h-4 w-4" />
                Add item
              </Button>
            </div>
          ) : (
            /* Repair mode */
            <div className="rounded-lg border p-3">
              <p className="mb-3 flex items-center gap-1.5 text-sm font-medium">
                <Wrench className="h-4 w-4 text-muted-foreground" />
                Repair / service
              </p>
              <div className="grid gap-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="qb-gross">Gross weight (g)</Label>
                    <Input
                      id="qb-gross"
                      inputMode="decimal"
                      placeholder="0"
                      value={grossWeight}
                      onChange={(e) => setGrossWeight(e.target.value.replace(/[^0-9.]/g, ""))}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="qb-rmaking">Making / labour charge (₹)</Label>
                    <Input
                      id="qb-rmaking"
                      inputMode="decimal"
                      placeholder="0"
                      value={repairMaking}
                      onChange={(e) => setRepairMaking(e.target.value.replace(/[^0-9.]/g, ""))}
                    />
                  </div>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="qb-rdetails">Details</Label>
                  <Input
                    id="qb-rdetails"
                    value={repairDetails}
                    onChange={(e) => setRepairDetails(e.target.value)}
                    placeholder="e.g. Re-tip 4 prongs, rhodium polish"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="qb-remarks">Remarks</Label>
                  <Textarea
                    id="qb-remarks"
                    value={remarks}
                    onChange={(e) => setRemarks(e.target.value)}
                    placeholder="Condition on intake, customer notes…"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Reference images */}
          <div className="grid gap-1.5">
            <Label>Reference images</Label>
            <div className="flex flex-wrap gap-2">
              {refUrls.map((u, i) => (
                <div
                  key={u}
                  className="relative h-16 w-16 overflow-hidden rounded-md border bg-muted/30"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={u} alt={`Reference ${i + 1}`} className="h-full w-full object-cover" />
                  <button
                    type="button"
                    onClick={() => removeRef(i)}
                    className="absolute right-0.5 top-0.5 rounded-full bg-background/80 p-0.5 text-foreground shadow"
                  >
                    <X className="h-3.5 w-3.5" />
                    <span className="sr-only">Remove image</span>
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => refInput.current?.click()}
                className="flex h-16 min-w-16 flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed border-muted-foreground/25 px-3 text-muted-foreground transition-colors hover:border-primary/50"
              >
                <ImagePlus className="h-5 w-5" />
                <span className="text-[10px]">{refUrls.length ? "Add" : "Add photos (8 MB each)"}</span>
              </button>
            </div>
            <input
              ref={refInput}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={onPickRefs}
            />
          </div>

          {/* Discounts — judged on the server against the role's cap. Above it,
              the quote waits for a manager before it can be sent. */}
          <div className="grid gap-1.5">
            <div className={cn("grid gap-3", mode === "sale" ? "grid-cols-3" : "grid-cols-2")}>
              <div className="grid gap-1.5">
                <Label htmlFor="qb-disc-making">Making discount %</Label>
                <Input
                  id="qb-disc-making"
                  inputMode="decimal"
                  value={makingDiscount}
                  onChange={(e) => setMakingDiscount(e.target.value.replace(/[^0-9.]/g, ""))}
                  placeholder="0"
                />
              </div>
              {mode === "sale" ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="qb-disc-stone">Diamond discount %</Label>
                  <Input
                    id="qb-disc-stone"
                    inputMode="decimal"
                    value={stoneDiscount}
                    onChange={(e) => setStoneDiscount(e.target.value.replace(/[^0-9.]/g, ""))}
                    placeholder="0"
                  />
                </div>
              ) : null}
              <div className="grid gap-1.5">
                <Label htmlFor="qb-disc-extra">Additional discount (₹)</Label>
                <Input
                  id="qb-disc-extra"
                  inputMode="decimal"
                  value={additionalDiscount}
                  onChange={(e) => setAdditionalDiscount(e.target.value.replace(/[^0-9.]/g, ""))}
                  placeholder="0"
                  aria-invalid={preview.overDiscount}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Gold is never discounted. Above your limit, a manager must approve
              before the quote can be sent.
            </p>
          </div>

          {/* Live totals preview */}
          <div className="rounded-lg bg-muted/50 p-3">
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">
              Live preview {mode === "repair" ? "(making-only)" : null}
            </p>
            <dl className="space-y-1 text-sm">
              {mode === "sale" ? (
                <>
                  <PreviewRow label="Metal value" value={preview.metal} />
                  <PreviewRow label="Making charges" value={preview.making} />
                  <PreviewRow label="Diamonds & stones" value={preview.stones} />
                </>
              ) : (
                <PreviewRow label="Making / labour" value={preview.making} />
              )}
              {preview.makingOff > 0 ? (
                <PreviewRow label={`Making discount ${disc.making}%`} value={-preview.makingOff} />
              ) : null}
              {preview.stoneOff > 0 ? (
                <PreviewRow label={`Diamond discount ${disc.stone}%`} value={-preview.stoneOff} />
              ) : null}
              {preview.additional > 0 ? (
                <PreviewRow label="Additional discount" value={-preview.additional} />
              ) : null}
              <Separator className="my-1" />
              <PreviewRow label="Taxable value" value={preview.taxable} />
              <PreviewRow
                label={
                  isKaccha
                    ? "GST (kaccha — none)"
                    : `GST @ ${formatPercent(GST_RATE * 100, 0)}`
                }
                value={preview.gst}
              />
              <Separator className="my-1" />
              <PreviewRow label="Grand total" value={preview.grand} bold />
            </dl>
          </div>

          {/* Custom-order details. The item type and size come from item 1. */}
          <div className="rounded-lg border">
            <button
              type="button"
              onClick={() => setCustomOpen((v) => !v)}
              className="flex w-full items-center justify-between px-3 py-2.5 text-left text-sm font-medium"
            >
              <span>Custom-order details</span>
              <ChevronDown
                className={cn(
                  "h-4 w-4 transition-transform",
                  customOpen && "rotate-180",
                )}
              />
            </button>
            {customOpen ? (
              <div className="grid gap-3 border-t p-3">
                <p className="text-xs text-muted-foreground">
                  Booked into production when you tap{" "}
                  <span className="font-medium">Create Custom Order</span>, as{" "}
                  <span className="font-medium">
                    {mode === "sale"
                      ? [itemTypeName(items[0]?.itemType ?? "") || "item 1", sizeText(items[0] ?? emptyItem()) && `size ${sizeText(items[0])}`]
                          .filter(Boolean)
                          .join(", ")
                      : repairDetails.trim() || "Repair / service"}
                  </span>
                  . All optional.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <Label htmlFor="qb-metal">Metal colour</Label>
                    <Select value={metalColorSel} onValueChange={setMetalColorSel}>
                      <SelectTrigger id="qb-metal">
                        <SelectValue placeholder={metalColor || "Select metal colour"} />
                      </SelectTrigger>
                      <SelectContent>
                        {METAL_COLOR_PRESETS.map((c) => (
                          <SelectItem key={c} value={c}>
                            {c}
                          </SelectItem>
                        ))}
                        <SelectItem value="other">
                          Other (platinum / silver…)
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    {metalColorSel === "other" ? (
                      <Input
                        value={metalColorOther}
                        onChange={(e) => setMetalColorOther(e.target.value)}
                        placeholder="e.g. Platinum"
                      />
                    ) : null}
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="qb-delivery">Delivery date</Label>
                    <Input
                      id="qb-delivery"
                      type="date"
                      value={deliveryDate}
                      onChange={(e) => setDeliveryDate(e.target.value)}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="qb-advance">Advance (₹)</Label>
                    <Input
                      id="qb-advance"
                      inputMode="decimal"
                      placeholder="0"
                      value={advance}
                      onChange={(e) => setAdvance(e.target.value.replace(/[^0-9.]/g, ""))}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="qb-advmode">Advance mode</Label>
                    <Select value={advanceMode} onValueChange={setAdvanceMode}>
                      <SelectTrigger id="qb-advmode">
                        <SelectValue placeholder="Cash / Card / UPI / Bank" />
                      </SelectTrigger>
                      <SelectContent>
                        {ADVANCE_MODE_OPTIONS.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <DialogFooter className="gap-2 sm:items-center sm:justify-between">
          <p className="hidden text-[11px] text-muted-foreground sm:block">
            Alt+N item · Alt+D diamond · Alt+C colour stone · Ctrl+Enter save
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="outline" onClick={() => void submit(false)} disabled={busy}>
              {busy ? "Working…" : "Create Quote"}
            </Button>
            <Button variant="gold" onClick={onCustomOrderClick} disabled={busy}>
              <Sparkles className="h-4 w-4" />
              {customOpen ? "Create Custom Order" : "Custom Order"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreviewRow({
  label,
  value,
  bold,
}: {
  label: React.ReactNode;
  value: number;
  bold?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <dt className={bold ? "font-medium" : "text-muted-foreground"}>
        {label}
      </dt>
      <dd className={bold ? "num font-semibold" : "num"}>{formatINR(value)}</dd>
    </div>
  );
}
