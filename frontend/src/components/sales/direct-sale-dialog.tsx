"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Banknote, CreditCard, ImagePlus, Smartphone, X } from "lucide-react";
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
import { useCreateSale, useUploadSaleDoc } from "@/lib/queries/sales";
import { cn } from "@/lib/utils";
import { useSession } from "@/store/use-session";

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

interface DirectSaleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Direct-sale entry (client call § "Sales (Direct Sales)"). Captures the sale
 * for reporting plus the advance vs total split (Module 12). On save it POSTs
 * the sale, then uploads whichever of the three counter photos (quotation /
 * invoice / receipt) the user attached to the `/sales/:id/...` routes.
 */
export function DirectSaleDialog({ open, onOpenChange }: DirectSaleDialogProps) {
  const { currentStore } = useSession();
  const createSale = useCreateSale();
  const uploadDoc = useUploadSaleDoc();

  const [customer, setCustomer] = useState("");
  const [description, setDescription] = useState("");
  const [invoiceNo, setInvoiceNo] = useState("");
  const [salesValue, setSalesValue] = useState("");
  const [afterDiscount, setAfterDiscount] = useState("");
  const [mode, setMode] = useState<SalePaymentMode | "">("");
  const [advance, setAdvance] = useState("");
  const [docs, setDocs] = useState<StagedDocs>(EMPTY_DOCS);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Aggregate ("all") scope has no concrete store to write to — fall back to
  // the first real store id; broad roles normally pick a store first.
  const targetStoreId = currentStore.isAggregate
    ? "surat-main"
    : currentStore.id;
  const storeLabel = currentStore.isAggregate
    ? "Surat — Main"
    : currentStore.name;

  const salesNum = toNumber(salesValue);
  const advanceNum = toNumber(advance);
  // After-discount defaults to the sales value when left blank (no discount).
  const afterNum = toNumber(afterDiscount) ?? salesNum;
  const balance =
    afterNum !== undefined ? Math.max(afterNum - (advanceNum ?? 0), 0) : undefined;

  function reset() {
    setCustomer("");
    setDescription("");
    setInvoiceNo("");
    setSalesValue("");
    setAfterDiscount("");
    setMode("");
    setAdvance("");
    setDocs(EMPTY_DOCS);
    setErrors({});
  }

  const submitting = createSale.isPending || uploadDoc.isPending;

  async function save() {
    const name = customer.trim();
    const fe: Record<string, string> = {};
    if (!name) fe.customer = "Customer name is required.";
    if (!invoiceNo.trim()) fe.invoiceNo = "Invoice number is required.";
    if (salesNum === undefined || salesNum <= 0)
      fe.salesValue = "Enter a valid sales value.";
    setErrors(fe);
    if (Object.keys(fe).length > 0) {
      toast.error("Please fill in the required fields.");
      return;
    }
    // Validated above; narrow for the type-checker.
    if (salesNum === undefined) return;
    const finalAfter = afterNum ?? salesNum;
    if (finalAfter > salesNum) {
      toast.error("After-discount value cannot exceed the sales value.");
      return;
    }
    if (advanceNum !== undefined && advanceNum > finalAfter) {
      toast.error("Advance received cannot exceed the after-discount value.");
      return;
    }

    try {
      const sale = await createSale.mutateAsync({
        storeId: targetStoreId,
        customerName: name,
        description: description.trim() || undefined,
        invoiceNo: invoiceNo.trim(),
        salesValue: salesNum,
        afterDiscountValue: finalAfter,
        paymentMode: mode || undefined,
        advanceReceived: advanceNum,
      });

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
          <DialogTitle>Record a sale</DialogTitle>
          <DialogDescription>
            Direct sale booked against {storeLabel} — feeds the weekly report.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
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

          {/* Sales value + after discount */}
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
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
            <div className="grid gap-1.5">
              <Label htmlFor="sale-after">After-discount (₹)</Label>
              <Input
                id="sale-after"
                type="number"
                min={0}
                inputMode="numeric"
                placeholder="Defaults to sales value"
                value={afterDiscount}
                onChange={(e) => setAfterDiscount(e.target.value)}
              />
            </div>
          </div>

          {/* Payment mode — large, touch-friendly segmented control */}
          <div className="grid gap-1.5">
            <Label>Advance payment mode</Label>
            <div className="grid grid-cols-3 gap-2">
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
              onChange={(e) => setAdvance(e.target.value)}
            />
          </div>

          {/* Live advance vs balance summary */}
          <div className="grid grid-cols-3 gap-3 rounded-lg border bg-muted/30 p-3 text-center">
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Billed
              </p>
              <p className="num mt-0.5 text-sm font-semibold">
                {afterNum !== undefined ? formatINR(afterNum) : "—"}
              </p>
            </div>
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
            <div className="grid grid-cols-3 gap-3">
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
