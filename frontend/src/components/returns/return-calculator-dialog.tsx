"use client";

import * as React from "react";
import { ArrowLeftRight, Banknote, Check, Gem, Info } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { formatINR } from "@/lib/format";
import {
  cn,
  normalizeIndianMobile,
  phoneInputValue,
  positiveNumberInput,
} from "@/lib/utils";
import type { ChosenOption } from "@/lib/mock/returns";
import {
  useCreateReturn,
  useRates,
  useValuate,
  type ValuateInput,
} from "@/lib/queries/returns";
import {
  StoreScopeField,
  useStoreScope,
} from "@/components/common/store-scope-field";

/** Parse a numeric input into a number, or undefined when blank/invalid. */
function toNumber(v: string): number | undefined {
  const n = Number(v);
  return v.trim() !== "" && Number.isFinite(n) ? n : undefined;
}

interface ReturnCalculatorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Module 14 — Returns / Exchange / Buyback calculator.
 *
 * The manager enters the ORIGINAL bill (gold + diamond + making). As they type,
 * we debounce a `/returns/valuate` preview and show two big cards — Exchange and
 * Buyback — each with the gold + diamond breakdown. The customer picks one; the
 * submit posts `/returns`, which lands as `pending_approval` for Head Office.
 */
export function ReturnCalculatorDialog({
  open,
  onOpenChange,
}: ReturnCalculatorDialogProps) {
  const { targetStoreId, storeLabel, pickedStoreId, setPickedStoreId } =
    useStoreScope();
  const createReturn = useCreateReturn();
  const valuate = useValuate();
  const { data: rates } = useRates();

  const [entryMode, setEntryMode] = React.useState<"manual" | "invoice">(
    "manual",
  );
  const [invoiceNo, setInvoiceNo] = React.useState("");
  const [customer, setCustomer] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [item, setItem] = React.useState("");
  const [goldWtG, setGoldWtG] = React.useState("");
  const [goldKarat, setGoldKarat] = React.useState("22");
  const [goldRate, setGoldRate] = React.useState("");
  const [diaCarat, setDiaCarat] = React.useState("");
  const [diaSpec, setDiaSpec] = React.useState("");
  const [diaRate, setDiaRate] = React.useState("");
  const [making, setMaking] = React.useState("");
  const [purchaseDiscountType, setPurchaseDiscountType] = React.useState<"percent" | "value" | "piece">("percent");
  const [purchaseDiscountValue, setPurchaseDiscountValue] = React.useState("");
  const [chosen, setChosen] = React.useState<ChosenOption>("exchange");
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  const diamondSpecs = rates?.diamond ?? [];

  const goldWtNum = toNumber(goldWtG);
  const diaCaratNum = toNumber(diaCarat);
  const makingNum = toNumber(making);
  // In invoice mode a valid invoice number is enough for the server to value the
  // piece; in manual mode we need gold or diamond figures typed in.
  const invoiceReady = entryMode === "invoice" && invoiceNo.trim().length > 0;
  const hasValuationInput =
    (goldWtNum ?? 0) > 0 || (diaCaratNum ?? 0) > 0 || invoiceReady;

  function reset() {
    setEntryMode("manual");
    setInvoiceNo("");
    setCustomer("");
    setPhone("");
    setItem("");
    setGoldWtG("");
    setGoldKarat("22");
    setGoldRate("");
    setDiaCarat("");
    setDiaSpec("");
    setDiaRate("");
    setMaking("");
    setChosen("exchange");
    setErrors({});
    valuate.reset();
  }

  // Debounced live valuation. Re-runs whenever any priced input changes; skipped
  // (and cleared) when there's nothing to value yet.
  const { mutate: runValuate, reset: resetValuate } = valuate;
  React.useEffect(() => {
    if (!open) return;
    if (!hasValuationInput) {
      resetValuate();
      return;
    }
    // Only tag the preview as 'invoice' once a number is present, so a half-typed
    // invoice-mode form doesn't 400 on the live valuation.
    const useInvoice = entryMode === "invoice" && invoiceNo.trim().length > 0;
    const body: ValuateInput = {
      goldWtG: goldWtNum,
      goldKarat: toNumber(goldKarat),
      goldRateAtPurchase: toNumber(goldRate),
      diaCarat: diaCaratNum,
      diaSpec: diaSpec || undefined,
      diaRateAtPurchase: toNumber(diaRate),
      making: makingNum,
      entryMode: useInvoice ? "invoice" : "manual",
      invoiceNo: useInvoice ? invoiceNo.trim() : undefined,
    };
    const t = setTimeout(() => runValuate(body), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, goldWtG, goldKarat, goldRate, diaCarat, diaSpec, diaRate, making, entryMode, invoiceNo]);

  const result = valuate.data;
  const goldToday = result?.goldValueToday ?? 0;
  // Derive each option's diamond portion from the server totals so the cards
  // always agree with the persisted valuation (exchange = 100%, buyback = 80%).
  const exchangeDia = result ? result.exchangeValue - goldToday : 0;
  const buybackDia = result ? result.buybackValue - goldToday : 0;

  async function submit() {
    if (!targetStoreId) {
      toast.error("Select a store to raise this return against.");
      return;
    }
    const nextErrors: Record<string, string> = {};
    if (!customer.trim()) nextErrors.customer = "Customer name is required.";
    // Phone is now mandatory + must be a valid Indian mobile (backend @IsNotEmpty
    // + @IsIndianMobile) — block/normalise before the call.
    const normalizedPhone = normalizeIndianMobile(phone);
    if (!phone.trim()) nextErrors.phone = "Phone number is required.";
    else if (!normalizedPhone)
      nextErrors.phone = "Enter a valid 10-digit mobile number.";
    if (entryMode === "invoice" && !invoiceNo.trim())
      nextErrors.invoiceNo = "Invoice number is required for an invoice-based return.";
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      toast.error("Please fill in the required fields.");
      return;
    }
    if (!hasValuationInput) {
      toast.error(
        "Enter the gold or diamond details (or an invoice number) to value the piece.",
      );
      return;
    }
    try {
      const created = await createReturn.mutateAsync({
        storeId: targetStoreId,
        customerName: customer.trim(),
        // Validated non-null just above; send the canonical 10-digit value.
        phone: normalizedPhone as string,
        // `type` mirrors the chosen option: exchange → exchange, buyback → return.
        type: chosen === "exchange" ? "exchange" : "return",
        item: item.trim() || undefined,
        goldWtG: goldWtNum,
        goldKarat: toNumber(goldKarat),
        goldRateAtPurchase: toNumber(goldRate),
        diaCarat: diaCaratNum,
        diaSpec: diaSpec || undefined,
        diaRateAtPurchase: toNumber(diaRate),
        making: makingNum,
        chosenOption: chosen,
        entryMode,
        invoiceNo: entryMode === "invoice" ? invoiceNo.trim() : undefined,
      });
      toast.success("Sent to Head Office for approval", {
        description: `${created.ref ?? "Return"} · ${
          chosen === "exchange" ? "Exchange" : "Buyback"
        } ${formatINR(
          chosen === "exchange"
            ? created.exchangeValue ?? 0
            : created.buybackValue ?? 0,
        )}`,
      });
      reset();
      onOpenChange(false);
    } catch {
      toast.error("Could not submit. Please try again.");
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Returns · Exchange · Buyback</DialogTitle>
          <DialogDescription>
            Enter the original bill for {storeLabel}. Values are computed at
            today&apos;s rates — gold at 100%, diamond at 100% for exchange and
            80% for buyback. Making &amp; GST are never returned.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-5">
          <StoreScopeField value={pickedStoreId} onChange={setPickedStoreId} />

          {/* Entry mode: pull the original bill by invoice, or type it manually. */}
          <div className="grid gap-2">
            <div className="grid grid-cols-2 gap-2 sm:max-w-sm">
              {(["invoice", "manual"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setEntryMode(m)}
                  aria-pressed={entryMode === m}
                  className={cn(
                    "rounded-lg border px-3 py-2 text-sm font-medium transition-colors",
                    entryMode === m
                      ? "border-gold-strong bg-[color-mix(in_srgb,var(--gold)_12%,transparent)] text-gold-strong"
                      : "text-muted-foreground hover:bg-muted/50",
                  )}
                >
                  {m === "invoice" ? "By Invoice" : "By Manual"}
                </button>
              ))}
            </div>
            {entryMode === "invoice" ? (
              <div className="grid gap-1.5 sm:max-w-sm">
                <Label htmlFor="rc-invoice">
                  Invoice number <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="rc-invoice"
                  placeholder="e.g. INV-2026-0481"
                  value={invoiceNo}
                  onChange={(e) => {
                    setInvoiceNo(e.target.value);
                    if (errors.invoiceNo)
                      setErrors((p) => ({ ...p, invoiceNo: "" }));
                  }}
                  aria-invalid={!!errors.invoiceNo}
                />
                {errors.invoiceNo ? (
                  <p className="mt-1 text-xs text-destructive">
                    {errors.invoiceNo}
                  </p>
                ) : null}
                <p className="text-[11px] text-muted-foreground">
                  The original bill is pulled from this invoice; adjust the figures
                  below if needed.
                </p>
              </div>
            ) : null}
          </div>

          {/* Customer */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="rc-customer">
                Customer name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="rc-customer"
                placeholder="e.g. Priya Sharma"
                value={customer}
                onChange={(e) => {
                  setCustomer(e.target.value);
                  if (errors.customer) setErrors((p) => ({ ...p, customer: "" }));
                }}
                aria-invalid={!!errors.customer}
              />
              {errors.customer ? (
                <p className="mt-1 text-xs text-destructive">
                  {errors.customer}
                </p>
              ) : null}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="rc-phone">
                Phone <span className="text-destructive">*</span>
              </Label>
              <Input
                id="rc-phone"
                placeholder="10-digit mobile"
                inputMode="numeric"
                maxLength={10}
                value={phone}
                aria-invalid={!!errors.phone}
                onChange={(e) => {
                  setPhone(phoneInputValue(e.target.value));
                  if (errors.phone) setErrors((p) => ({ ...p, phone: "" }));
                }}
              />
              {errors.phone ? (
                <p className="mt-1 text-xs text-destructive">{errors.phone}</p>
              ) : null}
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="rc-item">Item / original piece</Label>
            <Input
              id="rc-item"
              placeholder="e.g. 18K Diamond pendant — DP-4471"
              value={item}
              onChange={(e) => setItem(e.target.value)}
            />
          </div>

          {/* Gold block */}
          <div className="rounded-lg border bg-muted/20 p-4">
            <p className="mb-3 text-sm font-semibold">Gold (original bill)</p>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="grid gap-1.5">
                <Label htmlFor="rc-gold-wt">Gold weight (g)</Label>
                <Input
                  id="rc-gold-wt"
                  type="number"
                  inputMode="decimal"
                  step="0.001"
                  min={0}
                  placeholder="0.000"
                  value={goldWtG}
                  onChange={(e) => setGoldWtG(positiveNumberInput(e.target.value))}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="rc-gold-karat">Gold purity</Label>
                <Select value={goldKarat} onValueChange={setGoldKarat}>
                  <SelectTrigger id="rc-gold-karat">
                    <SelectValue placeholder="Karat" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="24">24K (999)</SelectItem>
                    <SelectItem value="22">22K (916)</SelectItem>
                    <SelectItem value="18">18K (750)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="rc-gold-rate">Gold rate at purchase (₹/g)</Label>
                <Input
                  id="rc-gold-rate"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  placeholder="0"
                  value={goldRate}
                  onChange={(e) => setGoldRate(positiveNumberInput(e.target.value))}
                />
              </div>
            </div>
          </div>

          {/* Diamond block */}
          <div className="rounded-lg border bg-muted/20 p-4">
            <p className="mb-3 flex items-center gap-1.5 text-sm font-semibold">
              <Gem className="h-4 w-4 text-primary" />
              Diamond (original bill)
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="grid gap-1.5">
                <Label htmlFor="rc-dia-carat">Diamond weight (ct)</Label>
                <Input
                  id="rc-dia-carat"
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min={0}
                  placeholder="0.00"
                  value={diaCarat}
                  onChange={(e) => setDiaCarat(positiveNumberInput(e.target.value))}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="rc-dia-spec">Specification</Label>
                <Select value={diaSpec} onValueChange={setDiaSpec}>
                  <SelectTrigger id="rc-dia-spec">
                    <SelectValue placeholder="Select spec / code" />
                  </SelectTrigger>
                  <SelectContent>
                    {diamondSpecs.length === 0 ? (
                      <SelectItem value="__none" disabled>
                        No diamond rates configured
                      </SelectItem>
                    ) : (
                      diamondSpecs.map((d) => (
                        <SelectItem key={d.spec} value={d.spec}>
                          {d.spec} — {formatINR(d.ratePerCarat)}/ct
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="rc-dia-rate">Rate at purchase (₹/ct)</Label>
                <Input
                  id="rc-dia-rate"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  placeholder="0"
                  value={diaRate}
                  onChange={(e) => setDiaRate(positiveNumberInput(e.target.value))}
                />
              </div>
            </div>
          </div>

          {/* Making */}
          <div className="grid gap-1.5 sm:max-w-xs">
            <Label htmlFor="rc-making">Making charge at purchase (₹)</Label>
            <Input
              id="rc-making"
              type="number"
              inputMode="numeric"
              min={0}
              placeholder="0"
              value={making}
              onChange={(e) => setMaking(positiveNumberInput(e.target.value))}
            />
            <p className="text-[11px] text-muted-foreground">
              Recorded for reference — never returned.
            </p>
          </div>

          {/* Today's diamond rate readout — gold rate lives in the top-bar chip. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <Gem className="h-3 w-3 text-primary" />
              Today&apos;s diamond{diaSpec ? ` (${diaSpec})` : ""}:{" "}
              <span className="num font-medium text-foreground">
                {result && result.todayDiaRate
                  ? `${formatINR(result.todayDiaRate)}/ct`
                  : "—"}
              </span>
            </span>
          </div>

          {/* The two value cards — selectable */}
          <div className="grid gap-3 sm:grid-cols-2">
            <ValueCard
              label="Exchange value"
              hint="Adjusted against a new purchase bill"
              icon={<ArrowLeftRight className="h-4 w-4" />}
              selected={chosen === "exchange"}
              onSelect={() => setChosen("exchange")}
              total={result?.exchangeValue ?? 0}
              goldValue={goldToday}
              diamondValue={exchangeDia}
              diamondPct="100%"
              making={makingNum ?? 0}
              loading={valuate.isPending}
              hasInput={hasValuationInput}
            />
            <ValueCard
              label="Buyback value"
              hint="Paid out as cash"
              icon={<Banknote className="h-4 w-4" />}
              selected={chosen === "buyback"}
              onSelect={() => setChosen("buyback")}
              total={result?.buybackValue ?? 0}
              goldValue={goldToday}
              diamondValue={buybackDia}
              diamondPct="80%"
              making={makingNum ?? 0}
              loading={valuate.isPending}
              hasInput={hasValuationInput}
            />
          </div>
          {valuate.isError ? (
            <p className="text-xs text-destructive">
              Could not fetch a live valuation — check the connection and retry.
            </p>
          ) : null}
        </div>

        <DialogFooter className="items-center sm:justify-between">
          <p className="hidden text-xs text-muted-foreground sm:block">
            Customer chose{" "}
            <span className="font-medium text-foreground">
              {chosen === "exchange" ? "Exchange" : "Buyback"}
            </span>{" "}
            · goes to Head Office for approval.
          </p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant="gold"
              onClick={submit}
              disabled={createReturn.isPending}
            >
              {createReturn.isPending ? "Submitting…" : "Submit for approval"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */

interface ValueCardProps {
  label: string;
  hint: string;
  icon: React.ReactNode;
  selected: boolean;
  onSelect: () => void;
  total: number;
  goldValue: number;
  diamondValue: number;
  diamondPct: string;
  making: number;
  loading: boolean;
  hasInput: boolean;
}

/** One of the two big selectable option cards (Exchange / Buyback). */
function ValueCard({
  label,
  hint,
  icon,
  selected,
  onSelect,
  total,
  goldValue,
  diamondValue,
  diamondPct,
  making,
  loading,
  hasInput,
}: ValueCardProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "group relative flex flex-col rounded-xl border p-4 text-left transition-all",
        selected
          ? "border-[var(--gold)] bg-[color-mix(in_srgb,var(--gold)_7%,transparent)] shadow-sm ring-1 ring-[var(--gold)]"
          : "border-border bg-card hover:border-primary/40 hover:bg-accent/40",
      )}
    >
      <span
        className={cn(
          "absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full border transition-colors",
          selected
            ? "border-transparent bg-[var(--gold)] text-gold-foreground"
            : "border-muted-foreground/40 text-transparent",
        )}
      >
        <Check className="h-3 w-3" />
      </span>

      <span className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
        <span className={selected ? "text-gold-strong" : "text-primary"}>
          {icon}
        </span>
        {label}
      </span>

      <span className="num mt-1.5 text-2xl font-semibold tabular-nums">
        {hasInput ? (loading ? "…" : formatINR(total)) : "—"}
      </span>
      <span className="text-xs text-muted-foreground">{hint}</span>

      <dl className="mt-3 space-y-1.5 border-t pt-3 text-xs">
        <div className="flex items-center justify-between">
          <dt className="text-muted-foreground">Gold (100%)</dt>
          <dd className="num font-medium">
            {hasInput ? formatINR(goldValue) : "—"}
          </dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-muted-foreground">Diamond ({diamondPct})</dt>
          <dd className="num font-medium">
            {hasInput ? formatINR(Math.max(0, diamondValue)) : "—"}
          </dd>
        </div>
        <div className="flex items-center justify-between text-muted-foreground/80">
          <dt className="flex items-center gap-1">
            <Info className="h-3 w-3" />
            Making &amp; GST
          </dt>
          <dd className="num line-through decoration-muted-foreground/50">
            {formatINR(making)}
          </dd>
        </div>
      </dl>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Making &amp; GST not returned.
      </p>
    </button>
  );
}
