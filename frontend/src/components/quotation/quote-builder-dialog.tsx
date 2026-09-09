"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  ChevronDown,
  Gem,
  ImagePlus,
  Plus,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
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
import { cn, normalizeIndianMobile } from "@/lib/utils";
import {
  StoreScopeField,
  useStoreScope,
} from "@/components/common/store-scope-field";

const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** Parse a numeric input into a number, or undefined when blank/invalid. */
function toNumber(v: string): number | undefined {
  const n = Number(v);
  return v.trim() !== "" && Number.isFinite(n) ? n : undefined;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

interface DiamondRow {
  id: number;
  desc: string;
  carat: string;
  perCaratRate: string;
  price: string;
}

type QuoteLineInput = Omit<QuoteLine, "id">;

interface QuoteBuilderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Module 2 — Quote builder. Round-2 merged Quotation + Custom-order flow.
 *
 * Sale mode prices gold (weight × rate + making) plus any number of diamond
 * lines; repair mode is making-only (metal & stones zero, GST on labour). The
 * live preview mirrors the server formula. Two actions: "Create Quote" (shares
 * a priced quote) and "Custom Order" (creates the quote then converts it to a
 * timeline production order). Reference photos upload after the id is known.
 */
export function QuoteBuilderDialog({
  open,
  onOpenChange,
}: QuoteBuilderDialogProps) {
  const { targetStoreId, storeLabel, pickedStoreId, setPickedStoreId } =
    useStoreScope();
  const createQuote = useCreateQuote();
  const metalRates = useMetalRates();
  const uploadPhoto = useUploadQuotePhoto();
  const convertToOrder = useConvertQuoteToOrder();

  const [mode, setMode] = useState<QuoteKind>("sale");

  // Quick = simplified front door (gold + one diamond); Advanced = the full
  // builder. Both drive the SAME state/totals/submit — Quick only hides extra
  // controls, so nothing about pricing or saving changes between them.
  const [view, setView] = useState<"quick" | "advanced">("quick");
  // Inline validation errors, keyed by field. Cleared per-field on change.
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Shared
  const [customer, setCustomer] = useState("");
  const [phone, setPhone] = useState("");
  // Kaccha ("@") estimate — rough, no-GST, kept head-office-only.
  const [isKaccha, setIsKaccha] = useState(false);

  // Sale — gold
  const [category, setCategory] = useState("ring");
  const [saleDesc, setSaleDesc] = useState("");
  const [karat, setKarat] = useState(18);
  const [weight, setWeight] = useState("");
  const [rateMode, setRateMode] = useState<"auto" | "manual">("auto");
  const [manualRate, setManualRate] = useState("");
  const [makingMode, setMakingMode] = useState<"flat" | "per_gram">("flat");
  const [makingRatePerGram, setMakingRatePerGram] = useState("1500");
  const [making, setMaking] = useState("");

  // Sale — diamonds
  const [diamonds, setDiamonds] = useState<DiamondRow[]>([]);
  const diamondId = useRef(0);

  // Repair
  const [grossWeight, setGrossWeight] = useState("");
  const [repairDetails, setRepairDetails] = useState("");
  const [remarks, setRemarks] = useState("");
  const [repairMaking, setRepairMaking] = useState("");

  // Reference photos (uploaded after the quote id is known)
  const [refFiles, setRefFiles] = useState<File[]>([]);
  const refInput = useRef<HTMLInputElement>(null);

  // Diamond pricing reference (client's chart — placeholder until provided)
  const [chartOpen, setChartOpen] = useState(false);
  const [chartFile, setChartFile] = useState<File | null>(null);
  const chartInput = useRef<HTMLInputElement>(null);

  // Custom-order details (revealed for the "Custom Order" action)
  const [customOpen, setCustomOpen] = useState(false);
  const [ringSize, setRingSize] = useState("");
  const [bangleSize, setBangleSize] = useState("");
  const [metalColorSel, setMetalColorSel] = useState("");
  const [metalColorOther, setMetalColorOther] = useState("");
  const [deliveryDate, setDeliveryDate] = useState("");
  const [advance, setAdvance] = useState("");
  const [advanceMode, setAdvanceMode] = useState("");

  const metalColor =
    metalColorSel === "other" ? metalColorOther.trim() : metalColorSel;

  /*
   * Object-URL previews are DERIVED from the picked files, not state that
   * happens to follow them. Computing them in an effect meant one render with
   * the previous files' URLs still on screen; a memo has the right value on the
   * first render, and the effect below exists only to release them.
   */
  const refUrls = useMemo(() => refFiles.map((f) => URL.createObjectURL(f)), [refFiles]);
  useEffect(() => () => refUrls.forEach((u) => URL.revokeObjectURL(u)), [refUrls]);

  const chartUrl = useMemo(
    () => (chartFile ? URL.createObjectURL(chartFile) : null),
    [chartFile],
  );
  useEffect(() => {
    if (!chartUrl) return;
    const u = chartUrl;
    return () => URL.revokeObjectURL(u);
  }, [chartUrl]);

  const weightNum = toNumber(weight) ?? 0;
  const makingNum = makingMode === "per_gram" 
    ? (toNumber(makingRatePerGram) ?? 0) * weightNum 
    : (toNumber(making) ?? 0);
  // "Auto" now means the rate on record for this store, not a constant baked
  // into the repo. GOLD_RATE_PER_GRAM survives only as the last-resort fallback
  // for a fresh deployment with no MetalRate rows yet — every quote priced off
  // it was otherwise using whatever gold cost the day that file was written.
  const liveRate = metalRates.rateFor(karat);
  const autoRate = liveRate?.ratePerGram ?? GOLD_RATE_PER_GRAM[karat] ?? 7180;
  const rateIsStale = liveRate?.stale ?? false;
  const rateIsFallback = liveRate == null;
  const goldRate = rateMode === "auto" ? autoRate : toNumber(manualRate) ?? 0;
  const diamondsTotal = diamonds.reduce((s, d) => {
    const p = toNumber(d.price);
    const c = toNumber(d.carat);
    const r = toNumber(d.perCaratRate);
    const calcP = r != null && c != null ? r * c : (p ?? 0);
    return s + calcP;
  }, 0);

  const repairMakingNum = toNumber(repairMaking) ?? 0;

  // Quick-mode gold rate: show the live auto rate but let the user overwrite it
  // (typing switches the shared rate control to manual so goldRate follows).
  const quickRate = rateMode === "manual" ? manualRate : String(autoRate);
  function onQuickRateChange(v: string) {
    setRateMode("manual");
    setManualRate(v);
  }
  // Quick mode edits a single diamond — the first row of the shared array — so
  // buildLines()/totals treat it identically to an Advanced diamond line.
  const quickDiamond = diamonds[0];
  function setQuickDiamond(patch: Partial<DiamondRow>) {
    setDiamonds((d) =>
      d.length === 0
        ? [
            {
              id: (diamondId.current += 1),
              desc: "",
              carat: "",
              perCaratRate: "",
              price: "",
              ...patch,
            },

          ]
        : d.map((x, i) => (i === 0 ? { ...x, ...patch } : x)),
    );
  }

  function clearError(field: string) {
    setErrors((prev) => (prev[field] ? { ...prev, [field]: "" } : prev));
  }

  function changeView(next: "quick" | "advanced") {
    // Quick only handles Sale (gold + diamond); returning to Quick from an
    // Advanced repair snaps the mode back so the simplified form stays coherent.
    if (next === "quick" && mode === "repair") setMode("sale");
    setView(next);
  }

  const preview = useMemo(() => {
    // Kaccha estimates carry no GST — mirror the server (GST = 0, grand =
    // taxable) for both Sale and Repair modes.
    const rate = isKaccha ? 0 : GST_RATE;
    if (mode === "repair") {
      const makingV = repairMakingNum;
      const taxable = makingV;
      const gst = taxable * rate;
      return {
        metal: 0,
        making: makingV,
        stones: 0,
        taxable,
        gst,
        grand: taxable + gst,
      };
    }
    const metal = weightNum * goldRate;
    const taxable = metal + makingNum + diamondsTotal;
    const gst = taxable * rate;
    return {
      metal,
      making: makingNum,
      stones: diamondsTotal,
      taxable,
      gst,
      grand: taxable + gst,
    };
  }, [
    mode,
    isKaccha,
    repairMakingNum,
    weightNum,
    goldRate,
    makingNum,
    diamondsTotal,
  ]);

  const busy =
    createQuote.isPending ||
    uploadPhoto.isPending ||
    convertToOrder.isPending;

  function addDiamond() {
    setDiamonds((d) => [
      ...d,
      { id: (diamondId.current += 1), desc: "", carat: "", perCaratRate: "", price: "" },
    ]);
  }
  function updateDiamond(id: number, patch: Partial<DiamondRow>) {
    setDiamonds((d) => d.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  }
  function removeDiamond(id: number) {
    setDiamonds((d) => d.filter((x) => x.id !== id));
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
  function onPickChart(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    if (f && f.size > MAX_FILE_BYTES) {
      toast.error("Chart image is too large — keep it under 8 MB.");
      e.target.value = "";
      return;
    }
    setChartFile(f);
  }

  function reset() {
    setMode("sale");
    setView("quick");
    setErrors({});
    setCustomer("");
    setPhone("");
    setIsKaccha(false);
    setSaleDesc("");
    setKarat(22);
    setWeight("");
    setRateMode("auto");
    setManualRate("");
    setMaking("");
    setDiamonds([]);
    setGrossWeight("");
    setRepairDetails("");
    setRemarks("");
    setRepairMaking("");
    setRefFiles([]);
    setChartOpen(false);
    setChartFile(null);
    setCustomOpen(false);
    setRingSize("");
    setBangleSize("");
    setMetalColorSel("");
    setMetalColorOther("");
    setDeliveryDate("");
    setAdvance("");
    setAdvanceMode("");
    if (refInput.current) refInput.current.value = "";
    if (chartInput.current) chartInput.current.value = "";
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
    const lines: QuoteLineInput[] = [];
    if (weightNum > 0 || makingNum > 0) {
      lines.push({
        description: saleDesc.trim() || `${karat}K gold`,
        karat,
        weightGrams: weightNum,
        goldRatePerGram: goldRate,
        makingCharges: makingNum,
        stoneCharges: 0,
        caratWeight: 0,
      });
    }
    for (const d of diamonds) {
      const price = toNumber(d.price) ?? 0;
      const carat = toNumber(d.carat) ?? 0;
      const perCaratRate = toNumber(d.perCaratRate) ?? 0;
      const calcPrice = perCaratRate > 0 && carat > 0 ? perCaratRate * carat : price;
      if (calcPrice > 0 || carat > 0 || d.desc.trim()) {
        lines.push({
          description: d.desc.trim() || "Diamond",
          karat: 0,
          weightGrams: 0,
          goldRatePerGram: 0,
          makingCharges: 0,
          stoneCharges: calcPrice,
          caratWeight: carat,
          perCaratRate: perCaratRate > 0 ? perCaratRate : undefined,
        });
      }
    }

    return lines;
  }

  /** Best-effort upload of every picked reference + the diamond chart. */
  async function uploadPhotos(id: string) {
    let failed = false;
    const jobs: Promise<unknown>[] = [];
    for (const f of refFiles) {
      jobs.push(
        uploadPhoto
          .mutateAsync({ id, file: f, label: "Reference" })
          .catch(() => {
            failed = true;
          }),
      );
    }
    if (chartFile) {
      jobs.push(
        uploadPhoto
          .mutateAsync({ id, file: chartFile, label: "Diamond pricing chart" })
          .catch(() => {
            failed = true;
          }),
      );
    }
    await Promise.all(jobs);
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
          `<tr><td>${escapeHtml(l.description)}</td><td style="text-align:right">${formatINR(
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
    // Weights can't be negative (backend @Min(0) on weightGrams / gross weight).
    if (weightNum < 0 || (toNumber(grossWeight) ?? 0) < 0) {
      toast.error("Weight cannot be negative.");
      return;
    }
    const lines = buildLines();
    // Guard: at least one line must carry a weight or a price before saving.
    if (lines.length === 0) {
      toast.error(
        mode === "repair"
          ? "Enter a making charge for the repair."
          : "Add a gold weight/making charge or at least one diamond.",
      );
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
        grossWeightG: mode === "repair" ? toNumber(grossWeight) : undefined,
        lines,
      });

      await uploadPhotos(quote.id);

      if (asCustomOrder) {
        const res = await convertToOrder.mutateAsync({
          id: quote.id,
          ringSize: ringSize.trim() || undefined,
          bangleSize: bangleSize.trim() || undefined,
          metalColor: metalColor || undefined,
          deliveryDate: deliveryDate || undefined,
          advanceReceived: toNumber(advance),
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
          description: `${formatINR(preview.grand)} · ready for ${name}.`,
          action: { label: "Print", onClick: () => printSummary(html) },
        });
      }
      reset();
      onOpenChange(false);
    } catch {
      toast.error("Could not create the quote. Please try again.");
    }
  }

  function onCustomOrderClick() {
    // A custom order needs the extra details (size, delivery, advance) that
    // only live in Advanced — jump there and open that section first.
    if (view === "quick") {
      setView("advanced");
      setCustomOpen(true);
      return;
    }
    // First tap reveals the custom-order fields; second tap submits.
    if (!customOpen) {
      setCustomOpen(true);
      return;
    }
    submit(true);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>New quote</DialogTitle>
          <DialogDescription>
            Raised at {storeLabel}. Gold rate is snapshotted from the active feed
            unless overridden.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <StoreScopeField value={pickedStoreId} onChange={setPickedStoreId} />

          {/* Quick vs Advanced — simplified front door defaults on */}
          <Tabs
            value={view}
            onValueChange={(v) => changeView(v as "quick" | "advanced")}
          >
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="quick">
                <Zap className="mr-1.5 h-4 w-4" />
                Quick
              </TabsTrigger>
              <TabsTrigger value="advanced">
                <SlidersHorizontal className="mr-1.5 h-4 w-4" />
                Advanced
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {/* Sale / Repair mode — Advanced only */}
          {view === "advanced" ? (
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
          ) : null}

          {/* Customer */}
          <div className="grid grid-cols-2 gap-3">
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
                  clearError("customer");
                }}
                placeholder="e.g. Meera Iyer"
              />
              {errors.customer ? (
                <p className="mt-1 text-xs text-destructive">
                  {errors.customer}
                </p>
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
                  clearError("phone");
                }}
                placeholder="+91 ..."
              />
              {errors.phone ? (
                <p className="mt-1 text-xs text-destructive">{errors.phone}</p>
              ) : null}
            </div>
          </div>

          {/* Quick mode — essentials only. Reuses the SAME weight/rate/making
              and first-diamond state that Advanced edits, so totals + submit
              are identical; this is just a simplified front door. */}
          {view === "quick" ? (
            <>
              {/* Gold */}
              <div className="rounded-lg border p-3">
                <p className="mb-3 flex items-center gap-1.5 text-sm font-medium">
                  <Sparkles className="h-4 w-4 text-gold-strong" />
                  Gold
                </p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="qb-q-wt">Weight (g)</Label>
                    <Input
                      id="qb-q-wt"
                      type="number"
                      inputMode="decimal"
                      min={0}
                      placeholder="0"
                      value={weight}
                      onChange={(e) => setWeight(e.target.value)}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="qb-q-rate">Rate (₹/g)</Label>
                    <Input
                      id="qb-q-rate"
                      type="number"
                      inputMode="numeric"
                      placeholder="0"
                      value={quickRate}
                      onChange={(e) => onQuickRateChange(e.target.value)}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="qb-q-making">Making (₹)</Label>
                    <Input
                      id="qb-q-making"
                      type="number"
                      inputMode="numeric"
                      placeholder="0"
                      value={making}
                      onChange={(e) => setMaking(e.target.value)}
                    />
                  </div>
                </div>
              </div>

              {/* One diamond (optional) */}
              <div className="rounded-lg border p-3">
                <p className="mb-3 flex items-center gap-1.5 text-sm font-medium">
                  <Gem className="h-4 w-4 text-muted-foreground" />
                  Diamond
                  <span className="text-xs font-normal text-muted-foreground">
                    optional
                  </span>
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="qb-q-carat">Carat (ct)</Label>
                    <Input
                      id="qb-q-carat"
                      type="number"
                      inputMode="decimal"
                      placeholder="0"
                      value={quickDiamond?.carat ?? ""}
                      onChange={(e) =>
                        setQuickDiamond({ carat: e.target.value })
                      }
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="qb-q-price">Price (₹)</Label>
                    <Input
                      id="qb-q-price"
                      type="number"
                      inputMode="numeric"
                      placeholder="0"
                      value={quickDiamond?.price ?? ""}
                      onChange={(e) =>
                        setQuickDiamond({ price: e.target.value })
                      }
                    />
                  </div>
                </div>
              </div>

              {/* Escalate to the full builder */}
              <button
                type="button"
                onClick={() => changeView("advanced")}
                className="inline-flex items-center gap-1 justify-self-start text-sm font-medium text-primary hover:underline"
              >
                More options
                <ArrowRight className="h-4 w-4" />
              </button>
            </>
          ) : null}

          {/* Advanced-only body — kaccha toggle, full gold/repair sections and
              reference images. Quick mode hides all of this. */}
          {view === "advanced" ? (
            <>
          {/* Kaccha ("@") estimate — no-GST, head-office-only */}
          <div className="flex items-start justify-between gap-4 rounded-lg border bg-muted/30 px-3 py-2.5">
            <div className="min-w-0">
              <Label htmlFor="qb-kaccha" className="text-sm font-medium">
                Kaccha estimate — no GST (head-office only)
              </Label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Rough estimate; typing &ldquo;@&rdquo; before an amount is the
                kaccha convention. Saved privately, hidden from the normal quote
                list.
              </p>
            </div>
            <button
              id="qb-kaccha"
              type="button"
              role="switch"
              aria-checked={isKaccha}
              aria-label="Kaccha estimate — no GST"
              onClick={() => setIsKaccha((v) => !v)}
              className={cn(
                "relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
            <>
              {/* Gold section */}
              <div className="rounded-lg border p-3">
                <p className="mb-3 flex items-center gap-1.5 text-sm font-medium">
                  <Sparkles className="h-4 w-4 text-gold-strong" />
                  Gold
                </p>
                <div className="grid gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="qb-desc">Item / description</Label>
                    <Input
                      id="qb-desc"
                      value={saleDesc}
                      onChange={(e) => setSaleDesc(e.target.value)}
                      placeholder="e.g. 22K gold chain"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <div className="grid gap-1.5">
                      <Label htmlFor="qb-karat">Karat</Label>
                      <Input
                        id="qb-karat"
                        type="number"
                        inputMode="numeric"
                        value={karat}
                        onChange={(e) =>
                          setKarat(Number(e.target.value) || 22)
                        }
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="qb-wt">Weight (g)</Label>
                      <Input
                        id="qb-wt"
                        type="number"
                        inputMode="decimal"
                        min={0}
                        placeholder="0"
                        value={weight}
                        onChange={(e) => setWeight(e.target.value)}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="qb-making">Making (₹)</Label>
                      <Input
                        id="qb-making"
                        type="number"
                        inputMode="numeric"
                        placeholder="0"
                        value={making}
                        onChange={(e) => setMaking(e.target.value)}
                      />
                    </div>
                  </div>

                  {/* Gold rate — auto vs manual */}
                  <div className="grid gap-1.5">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="qb-rate">Gold rate (₹/g)</Label>
                      <Tabs
                        value={rateMode}
                        onValueChange={(v) =>
                          setRateMode(v as "auto" | "manual")
                        }
                      >
                        <TabsList className="h-7">
                          <TabsTrigger value="auto" className="text-xs">
                            Auto
                          </TabsTrigger>
                          <TabsTrigger value="manual" className="text-xs">
                            Manual
                          </TabsTrigger>
                        </TabsList>
                      </Tabs>
                    </div>
                    {rateMode === "auto" ? (
                      <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
                        <span className="num font-medium">
                          {formatINR(autoRate)}/g
                        </span>
                        {/* Say where the number came from. A rate that is stale
                            or a built-in default looks identical to a fresh one
                            on the total, and the difference is real money. */}
                        {rateIsFallback ? (
                          <>
                            <Badge variant="destructive" className="text-[10px]">
                              No rate on record
                            </Badge>
                            <span className="text-xs text-muted-foreground">
                              Using a built-in default — check today&apos;s rate
                              and switch to Manual.
                            </span>
                          </>
                        ) : rateIsStale ? (
                          <>
                            <Badge variant="destructive" className="text-[10px]">
                              {karat}K · out of date
                            </Badge>
                            <span className="text-xs text-muted-foreground">
                              Last updated{" "}
                              {Math.round((liveRate?.ageHours ?? 0) / 24)} day(s)
                              ago. Confirm today&apos;s rate before quoting.
                            </span>
                          </>
                        ) : (
                          <Badge variant="outline" className="text-[10px]">
                            {karat}K · today&apos;s rate
                          </Badge>
                        )}
                      </div>
                    ) : (
                      <Input
                        id="qb-rate"
                        type="number"
                        inputMode="numeric"
                        placeholder="e.g. 7180"
                        value={manualRate}
                        onChange={(e) => setManualRate(e.target.value)}
                      />
                    )}
                  </div>
                </div>
              </div>

              {/* Diamonds section */}
              <div className="rounded-lg border p-3">
                <div className="mb-2 flex items-center justify-between">
                  <p className="flex items-center gap-1.5 text-sm font-medium">
                    <Gem className="h-4 w-4 text-muted-foreground" />
                    Diamonds
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={addDiamond}
                  >
                    <Plus className="h-4 w-4" />
                    Add diamond
                  </Button>
                </div>
                {diamonds.length === 0 ? (
                  <p className="rounded-md border border-dashed py-3 text-center text-xs text-muted-foreground">
                    No diamonds yet — add one line per stone/lot with its own
                    price.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {diamonds.map((d) => (
                      <div
                        key={d.id}
                        className="grid grid-cols-[1fr_auto] items-end gap-2 rounded-md bg-muted/30 p-2"
                      >
                        <div className="grid gap-2">
                          <Input
                            aria-label="Diamond type / description"
                            placeholder="Type / description (e.g. VVS round 0.30ct)"
                            value={d.desc}
                            onChange={(e) =>
                              updateDiamond(d.id, { desc: e.target.value })
                            }
                          />
                          <div className="grid grid-cols-2 gap-2">
                            <Input
                              aria-label="Carat weight"
                              type="number"
                              inputMode="decimal"
                              placeholder="Carat (ct)"
                              value={d.carat}
                              onChange={(e) =>
                                updateDiamond(d.id, { carat: e.target.value })
                              }
                            />
                            <Input
                              aria-label="Diamond price"
                              type="number"
                              inputMode="numeric"
                              placeholder="Price (₹)"
                              value={d.price}
                              onChange={(e) =>
                                updateDiamond(d.id, { price: e.target.value })
                              }
                            />
                          </div>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => removeDiamond(d.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                          <span className="sr-only">Remove diamond</span>
                        </Button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Diamond pricing reference — placeholder chart slot */}
                <div className="mt-3 rounded-md border border-dashed">
                  <button
                    type="button"
                    onClick={() => setChartOpen((v) => !v)}
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium"
                  >
                    <span>Diamond pricing reference</span>
                    <ChevronDown
                      className={cn(
                        "h-4 w-4 transition-transform",
                        chartOpen && "rotate-180",
                      )}
                    />
                  </button>
                  {chartOpen ? (
                    <div className="border-t px-3 py-3">
                      <p className="mb-2 text-xs text-muted-foreground">
                        Upload the client&apos;s diamond pricing chart here — the
                        chart isn&apos;t provided yet, so diamond prices are
                        entered manually per line for now.
                      </p>
                      {chartUrl ? (
                        <div className="relative flex items-center gap-3 rounded-md border bg-muted/30 p-2">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={chartUrl}
                            alt="Diamond pricing chart"
                            className="h-14 w-14 shrink-0 rounded object-cover"
                          />
                          <p className="min-w-0 flex-1 truncate text-xs">
                            {chartFile?.name}
                          </p>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => {
                              setChartFile(null);
                              if (chartInput.current)
                                chartInput.current.value = "";
                            }}
                          >
                            <X className="h-4 w-4" />
                            <span className="sr-only">Remove chart</span>
                          </Button>
                        </div>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => chartInput.current?.click()}
                        >
                          <ImagePlus className="h-4 w-4" />
                          Upload pricing chart
                        </Button>
                      )}
                      <input
                        ref={chartInput}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={onPickChart}
                      />
                    </div>
                  ) : null}
                </div>
              </div>
            </>
          ) : (
            /* Repair mode */
            <div className="rounded-lg border p-3">
              <p className="mb-3 flex items-center gap-1.5 text-sm font-medium">
                <Wrench className="h-4 w-4 text-muted-foreground" />
                Repair / service
              </p>
              <div className="grid gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="qb-gross">Gross weight (g)</Label>
                  <Input
                    id="qb-gross"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    placeholder="0"
                    value={grossWeight}
                    onChange={(e) => setGrossWeight(e.target.value)}
                  />
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
                <div className="grid gap-1.5">
                  <Label htmlFor="qb-rmaking">Making / labour charge (₹)</Label>
                  <Input
                    id="qb-rmaking"
                    type="number"
                    inputMode="numeric"
                    placeholder="0"
                    value={repairMaking}
                    onChange={(e) => setRepairMaking(e.target.value)}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Reference images */}
          <div className="grid gap-1.5">
            <Label>Reference images</Label>
            {refUrls.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {refUrls.map((u, i) => (
                  <div
                    key={u}
                    className="relative h-20 w-20 overflow-hidden rounded-md border bg-muted/30"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={u}
                      alt={`Reference ${i + 1}`}
                      className="h-full w-full object-cover"
                    />
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
                  className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed border-muted-foreground/25 text-muted-foreground transition-colors hover:border-primary/50"
                >
                  <ImagePlus className="h-5 w-5" />
                  <span className="text-[10px]">Add</span>
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => refInput.current?.click()}
                className="flex flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed border-muted-foreground/25 p-5 text-center transition-colors hover:border-primary/50"
              >
                <ImagePlus className="h-5 w-5 text-muted-foreground" />
                <span className="text-sm font-medium">Add reference photos</span>
                <span className="text-xs text-muted-foreground">
                  JPG / PNG up to 8 MB each — uploaded once the quote is created
                </span>
              </button>
            )}
            <input
              ref={refInput}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={onPickRefs}
            />
          </div>
            </>
          ) : null}

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
                  <PreviewRow label="Diamonds" value={preview.stones} />
                </>
              ) : (
                <PreviewRow label="Making / labour" value={preview.making} />
              )}
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

          {/* Custom-order details — Advanced only (Quick escalates here). */}
          {view === "advanced" ? (
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
                  Fill these to book the piece into production when you tap{" "}
                  <span className="font-medium">Custom Order</span>. All optional.
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="qb-ring">Ring size</Label>
                    <Input
                      id="qb-ring"
                      value={ringSize}
                      onChange={(e) => setRingSize(e.target.value)}
                      placeholder="e.g. 16"
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="qb-bangle">Bangle size</Label>
                    <Input
                      id="qb-bangle"
                      value={bangleSize}
                      onChange={(e) => setBangleSize(e.target.value)}
                      placeholder="e.g. 2.6"
                    />
                  </div>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="qb-metal">Metal colour</Label>
                  <Select
                    value={metalColorSel}
                    onValueChange={setMetalColorSel}
                  >
                    <SelectTrigger id="qb-metal">
                      <SelectValue placeholder="Select metal colour" />
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
                <div className="grid grid-cols-2 gap-3">
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
                      type="number"
                      inputMode="numeric"
                      placeholder="0"
                      value={advance}
                      onChange={(e) => setAdvance(e.target.value)}
                    />
                  </div>
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
            ) : null}
          </div>
          ) : null}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            variant="outline"
            onClick={() => submit(false)}
            disabled={busy}
          >
            {busy ? "Working…" : "Create Quote"}
          </Button>
          <Button variant="gold" onClick={onCustomOrderClick} disabled={busy}>
            <Sparkles className="h-4 w-4" />
            {customOpen ? "Create Custom Order" : "Custom Order"}
          </Button>
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
