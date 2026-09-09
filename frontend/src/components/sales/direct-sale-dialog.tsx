"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Banknote,
  CreditCard,
  Gem,
  Hammer,
  ImagePlus,
  Lock,
  Smartphone,
  X,
} from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { formatINR } from "@/lib/format";
import {
  SALE_DOC_META,
  SALE_PAYMENT_MODES,
  type SaleDocType,
  type SalePaymentMode,
} from "@/lib/mock/sales";
import {
  isApprovalRequired,
  useCreateSale,
  useUploadSaleDoc,
} from "@/lib/queries/sales";
import { cn } from "@/lib/utils";
import {
  StoreScopeField,
  useStoreScope,
} from "@/components/common/store-scope-field";
import { useResetOn } from "@/lib/use-reset-on";

/** Parse a currency input into a number, or undefined when blank/invalid. */
function toNumber(v: string): number | undefined {
  const n = Number(v);
  return v.trim() !== "" && Number.isFinite(n) ? n : undefined;
}

const MODE_ICON: Record<SalePaymentMode, typeof Banknote> = {
  cash: Banknote,
  card: CreditCard,
  upi: Smartphone,
};

type StagedDocs = Record<SaleDocType, File | null>;
const EMPTY_DOCS: StagedDocs = { quotation: null, invoice: null, receipt: null };

/**
 * An approved-but-unbilled over-cap discount request. When passed to
 * `DirectSaleDialog`, the dialog opens in "completion" mode: customer/item are
 * pre-filled and the diamond/making discount %s are locked to the approved
 * values, so submitting records the sale linked to `id` without re-escalating.
 */
export interface SaleApprovalCompletion {
  id: string;
  ref: string;
  customer: string;
  item: string;
  diamondPercent: number;
  makingPercent: number;
}

interface DirectSaleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, complete this approved discount request instead of a fresh sale. */
  approval?: SaleApprovalCompletion | null;
}

/**
 * Direct-sale entry (client call § "Sales (Direct Sales)"). Captures the sale
 * for reporting plus the advance vs total split (Module 12). On save it POSTs
 * the sale, then uploads whichever of the three counter photos (quotation /
 * invoice / receipt) the user attached to the `/sales/:id/...` routes.
 */
export function DirectSaleDialog({
  open,
  onOpenChange,
  approval = null,
}: DirectSaleDialogProps) {
  const { targetStoreId, storeLabel, pickedStoreId, setPickedStoreId } =
    useStoreScope();
  const createSale = useCreateSale();
  const uploadDoc = useUploadSaleDoc();
  const isCompletion = !!approval;

  const [customer, setCustomer] = useState("");
  const [description, setDescription] = useState("");
  const [invoiceNo, setInvoiceNo] = useState("");
  const [salesValue, setSalesValue] = useState("");
  // Discount split — gold is never discounted (Module 15).
  const [diamondValue, setDiamondValue] = useState("");
  const [diamondPct, setDiamondPct] = useState("");
  const [makingValue, setMakingValue] = useState("");
  const [makingPct, setMakingPct] = useState("");
  const [mode, setMode] = useState<SalePaymentMode | "">("");
  const [advance, setAdvance] = useState("");
  const [docs, setDocs] = useState<StagedDocs>(EMPTY_DOCS);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Completion mode: on open, pre-fill from the approved request and pin the
  // discount %s to the approved values (the % inputs render read-only below).
  useResetOn(open ? (approval?.id ?? "open") : null, () => {
    if (open && approval) {
      setCustomer(approval.customer);
      setDescription(approval.item);
      setDiamondPct(String(approval.diamondPercent));
      setMakingPct(String(approval.makingPercent));
    }
  });

  const salesNum = toNumber(salesValue);
  const advanceNum = toNumber(advance);
  const diamondValueNum = toNumber(diamondValue) ?? 0;
  const makingValueNum = toNumber(makingValue) ?? 0;
  const diamondPctNum = toNumber(diamondPct) ?? 0;
  const makingPctNum = toNumber(makingPct) ?? 0;
  // Mirror the backend: discount = diamondValue×dia% + makingValue×making%.
  const discount =
    (diamondValueNum * diamondPctNum) / 100 +
    (makingValueNum * makingPctNum) / 100;
  const hasDiscount = discount > 0;
  const total = salesNum !== undefined ? salesNum - discount : undefined;
  const balance =
    total !== undefined ? Math.max(total - (advanceNum ?? 0), 0) : undefined;

  function reset() {
    setCustomer("");
    setDescription("");
    setInvoiceNo("");
    setSalesValue("");
    setDiamondValue("");
    setDiamondPct("");
    setMakingValue("");
    setMakingPct("");
    setMode("");
    setAdvance("");
    setDocs(EMPTY_DOCS);
    setErrors({});
  }

  const submitting = createSale.isPending || uploadDoc.isPending;

  async function save() {
    if (!targetStoreId) {
      toast.error("Select a store to record this sale against.");
      return;
    }
    const name = customer.trim();
    const fe: Record<string, string> = {};
    if (!name) fe.customer = "Customer name is required.";
    if (!invoiceNo.trim()) fe.invoiceNo = "Invoice number is required.";
    if (salesNum === undefined || salesNum <= 0)
      fe.salesValue = "Enter a valid sales value.";
    if (diamondPctNum < 0 || diamondPctNum > 100)
      fe.diamondPct = "Enter a value between 0 and 100.";
    if (makingPctNum < 0 || makingPctNum > 100)
      fe.makingPct = "Enter a value between 0 and 100.";
    if (diamondValueNum < 0 || makingValueNum < 0)
      fe.split = "Values cannot be negative.";
    else if (salesNum !== undefined && diamondValueNum + makingValueNum > salesNum)
      fe.split = "Diamond + making value cannot exceed the sales value.";
    if (advanceNum !== undefined && total !== undefined && advanceNum > total)
      fe.advance = "Advance received cannot exceed the total.";
    setErrors(fe);
    if (Object.keys(fe).length > 0) {
      toast.error("Please fix the highlighted fields.");
      return;
    }
    // Validated above; narrow for the type-checker.
    if (salesNum === undefined) return;

    try {
      const result = await createSale.mutateAsync({
        storeId: targetStoreId,
        customerName: name,
        description: description.trim() || undefined,
        invoiceNo: invoiceNo.trim(),
        salesValue: salesNum,
        // Send the split when there's a discount (backend rejects a blended
        // after-discount value without it), or always in completion mode so the
        // approved %s are verified against the request. Gold is never discounted.
        ...(hasDiscount || isCompletion
          ? {
              diamondValue: diamondValueNum,
              makingValue: makingValueNum,
              diamondDiscountPercent: diamondPctNum,
              makingDiscountPercent: makingPctNum,
            }
          : {}),
        // Link to the approved request so the backend bills it (no re-escalation).
        ...(approval ? { discountRequestId: approval.id } : {}),
        paymentMode: mode || undefined,
        advanceReceived: advanceNum,
      });

      // Over-cap discount → no sale created; it was queued for approval.
      if (isApprovalRequired(result)) {
        toast.info(result.message, {
          description: `Reference ${result.discountRequest.ref}`,
        });
        reset();
        onOpenChange(false);
        return;
      }
      const sale = result;

      // Upload whichever photos were attached, against the new sale id.
      const staged = SALE_DOC_META.map((d) => ({ doc: d.type, file: docs[d.type] })).filter(
        (s): s is { doc: SaleDocType; file: File } => s.file !== null,
      );
      let failed = 0;
      for (const { doc, file } of staged) {
        if (!sale?.id) break;
        try {
          await uploadDoc.mutateAsync({ id: sale.id, doc, file });
        } catch {
          failed += 1;
        }
      }

      if (failed > 0) {
        toast.warning(
          `Sale recorded, but ${failed} photo(s) failed to upload. You can add them from the sale.`,
        );
      } else {
        toast.success("Sale recorded", { description: name });
      }
      reset();
      onOpenChange(false);
    } catch {
      toast.error("Could not record the sale. Please try again.");
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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isCompletion ? "Complete approved sale" : "Record a sale"}
          </DialogTitle>
          <DialogDescription>
            {isCompletion
              ? `Completing approved discount ${approval!.ref} — the discount %s are locked to the approved values.`
              : `Direct sale booked against ${storeLabel} — feeds the weekly report.`}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <StoreScopeField value={pickedStoreId} onChange={setPickedStoreId} />

          {/* Customer */}
          <div className="grid gap-1.5">
            <Label htmlFor="sale-customer">
              Customer name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="sale-customer"
              placeholder="e.g. Priya Sharma"
              value={customer}
              onChange={(e) => {
                setCustomer(e.target.value);
                if (errors.customer) setErrors((p) => ({ ...p, customer: "" }));
              }}
              aria-invalid={!!errors.customer}
            />
            {errors.customer ? (
              <p className="mt-1 text-xs text-destructive">{errors.customer}</p>
            ) : null}
          </div>

          {/* Description */}
          <div className="grid gap-1.5">
            <Label htmlFor="sale-desc">Product description</Label>
            <Textarea
              id="sale-desc"
              placeholder="e.g. 22K bridal necklace set, 1.71ct diamond ring"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          {/* Invoice number */}
          <div className="grid gap-1.5">
            <Label htmlFor="sale-invoice">
              Invoice / bill number <span className="text-destructive">*</span>
            </Label>
            <Input
              id="sale-invoice"
              placeholder="e.g. INV-22841"
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
          </div>

          {/* Sales value */}
          <div className="grid gap-1.5 sm:max-w-xs">
            <Label htmlFor="sale-value">
              Sales value (₹) <span className="text-destructive">*</span>
            </Label>
            <Input
              id="sale-value"
              type="number"
              min={0}
              inputMode="numeric"
              placeholder="0"
              value={salesValue}
              onChange={(e) => {
                setSalesValue(e.target.value);
                if (errors.salesValue)
                  setErrors((p) => ({ ...p, salesValue: "" }));
              }}
              aria-invalid={!!errors.salesValue}
            />
            {errors.salesValue ? (
              <p className="mt-1 text-xs text-destructive">
                {errors.salesValue}
              </p>
            ) : null}
          </div>

          {/* Discount split — gold is never discounted (Module 15). */}
          <div className="rounded-lg border bg-muted/20 p-4">
            <p className="mb-3 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Lock className="h-3.5 w-3.5" />
              Gold: no discount — only diamond &amp; making are discountable.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label
                  htmlFor="sale-diamond-value"
                  className="flex items-center gap-1.5"
                >
                  <Gem className="h-3.5 w-3.5 text-primary" />
                  Diamond / stone value (₹)
                </Label>
                <Input
                  id="sale-diamond-value"
                  type="number"
                  min={0}
                  inputMode="numeric"
                  placeholder="0"
                  value={diamondValue}
                  onChange={(e) => {
                    setDiamondValue(e.target.value);
                    if (errors.split) setErrors((p) => ({ ...p, split: "" }));
                  }}
                  aria-invalid={!!errors.split}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="sale-diamond-pct">Diamond discount %</Label>
                <Input
                  id="sale-diamond-pct"
                  type="number"
                  min={0}
                  max={100}
                  step={0.5}
                  inputMode="decimal"
                  placeholder="0"
                  value={diamondPct}
                  readOnly={isCompletion}
                  className={cn(isCompletion && "bg-muted cursor-not-allowed")}
                  onChange={(e) => {
                    if (isCompletion) return;
                    setDiamondPct(e.target.value);
                    if (errors.diamondPct)
                      setErrors((p) => ({ ...p, diamondPct: "" }));
                  }}
                  aria-invalid={!!errors.diamondPct}
                />
                {errors.diamondPct ? (
                  <p className="mt-1 text-xs text-destructive">
                    {errors.diamondPct}
                  </p>
                ) : null}
              </div>
              <div className="grid gap-1.5">
                <Label
                  htmlFor="sale-making-value"
                  className="flex items-center gap-1.5"
                >
                  <Hammer className="h-3.5 w-3.5 text-primary" />
                  Making value (₹)
                </Label>
                <Input
                  id="sale-making-value"
                  type="number"
                  min={0}
                  inputMode="numeric"
                  placeholder="0"
                  value={makingValue}
                  onChange={(e) => {
                    setMakingValue(e.target.value);
                    if (errors.split) setErrors((p) => ({ ...p, split: "" }));
                  }}
                  aria-invalid={!!errors.split}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="sale-making-pct">Making discount %</Label>
                <Input
                  id="sale-making-pct"
                  type="number"
                  min={0}
                  max={100}
                  step={0.5}
                  inputMode="decimal"
                  placeholder="0"
                  value={makingPct}
                  readOnly={isCompletion}
                  className={cn(isCompletion && "bg-muted cursor-not-allowed")}
                  onChange={(e) => {
                    if (isCompletion) return;
                    setMakingPct(e.target.value);
                    if (errors.makingPct)
                      setErrors((p) => ({ ...p, makingPct: "" }));
                  }}
                  aria-invalid={!!errors.makingPct}
                />
                {errors.makingPct ? (
                  <p className="mt-1 text-xs text-destructive">
                    {errors.makingPct}
                  </p>
                ) : null}
              </div>
            </div>
            {errors.split ? (
              <p className="mt-2 text-xs text-destructive">{errors.split}</p>
            ) : null}
          </div>

          {/* Payment mode — large, touch-friendly segmented control */}
          <div className="grid gap-1.5">
            <Label>Advance payment mode</Label>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {SALE_PAYMENT_MODES.map((m) => {
                const Icon = MODE_ICON[m.value];
                const active = mode === m.value;
                return (
                  <button
                    key={m.value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setMode(active ? "" : m.value)}
                    className={cn(
                      "flex flex-col items-center justify-center gap-1 rounded-lg border py-3 text-sm font-medium transition-colors",
                      active
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-input text-muted-foreground hover:border-primary/40 hover:bg-accent",
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    {m.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Advance received */}
          <div className="grid gap-1.5">
            <Label htmlFor="sale-advance">Advance received (₹)</Label>
            <Input
              id="sale-advance"
              type="number"
              min={0}
              inputMode="numeric"
              placeholder="0"
              value={advance}
              onChange={(e) => {
                setAdvance(e.target.value);
                if (errors.advance) setErrors((p) => ({ ...p, advance: "" }));
              }}
              aria-invalid={!!errors.advance}
            />
            {errors.advance ? (
              <p className="mt-1 text-xs text-destructive">{errors.advance}</p>
            ) : null}
          </div>

          {/* Live discount summary — Original · Discount · Total */}
          <div className="grid grid-cols-3 gap-3 rounded-lg border bg-muted/30 p-3 text-center">
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Original
              </p>
              <p className="num mt-0.5 text-sm font-semibold">
                {salesNum !== undefined ? formatINR(salesNum) : "—"}
              </p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Discount
              </p>
              <p
                className={cn(
                  "num mt-0.5 text-sm font-semibold",
                  hasDiscount ? "text-warning" : "text-foreground",
                )}
              >
                {hasDiscount ? `− ${formatINR(discount)}` : formatINR(0)}
              </p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Total
              </p>
              <p className="num mt-0.5 text-sm font-semibold">
                {total !== undefined ? formatINR(total) : "—"}
              </p>
            </div>
          </div>

          {/* Live advance vs balance summary */}
          <div className="grid grid-cols-2 gap-3 rounded-lg border bg-muted/30 p-3 text-center">
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Advance
              </p>
              <p className="num mt-0.5 text-sm font-semibold text-success">
                {formatINR(advanceNum ?? 0)}
              </p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Balance
              </p>
              <p
                className={cn(
                  "num mt-0.5 text-sm font-semibold",
                  balance && balance > 0 ? "text-warning" : "text-foreground",
                )}
              >
                {balance !== undefined ? formatINR(balance) : "—"}
              </p>
            </div>
          </div>

          {/* Counter photos — quotation / invoice / receipt */}
          <div className="grid gap-1.5">
            <Label>Photos (optional)</Label>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {SALE_DOC_META.map(({ type, label, hint }) => (
                <SaleDocSlot
                  key={type}
                  label={label}
                  hint={hint}
                  file={docs[type]}
                  onPick={(f) => setDocs((prev) => ({ ...prev, [type]: f }))}
                  onClear={() =>
                    setDocs((prev) => ({ ...prev, [type]: null }))
                  }
                />
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Uploaded after the sale is created. JPG / PNG up to 8 MB.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="gold" onClick={save} disabled={submitting}>
            {submitting ? "Saving…" : "Record sale"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A single staged photo slot with an object-URL preview (not yet uploaded). */
function SaleDocSlot({
  label,
  hint,
  file,
  onPick,
  onClear,
}: {
  label: string;
  hint: string;
  file: File | null;
  onPick: (file: File) => void;
  onClear: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Derive the object URL from the file (no setState-in-effect); the effect
  // only revokes the previous URL on change/unmount to avoid leaks.
  const previewUrl = useMemo(
    () => (file ? URL.createObjectURL(file) : null),
    [file],
  );
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f && f.size > 8 * 1024 * 1024) {
      toast.error("Image is too large — please keep it under 8 MB.");
      e.target.value = "";
      return;
    }
    if (f) onPick(f);
  }

  return (
    <div className="space-y-1.5">
      {previewUrl ? (
        <div className="relative aspect-square overflow-hidden rounded-lg border">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={previewUrl}
            alt={label}
            className="h-full w-full object-cover"
          />
          <button
            type="button"
            onClick={() => {
              onClear();
              if (inputRef.current) inputRef.current.value = "";
            }}
            className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-background/85 text-foreground shadow-sm"
          >
            <X className="h-3 w-3" />
            <span className="sr-only">Remove {label}</span>
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="flex aspect-square w-full flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-muted-foreground/25 text-center transition-colors hover:border-primary/50 hover:bg-accent"
        >
          <ImagePlus className="h-4 w-4 text-muted-foreground" />
          <span className="px-1 text-[11px] text-muted-foreground">Add</span>
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={pick}
      />
      <p
        className="text-center text-[11px] font-medium text-muted-foreground"
        title={hint}
      >
        {label}
      </p>
    </div>
  );
}
