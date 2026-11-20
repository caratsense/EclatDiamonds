"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ImagePlus, Package, Sparkles, X } from "lucide-react";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { formatINR } from "@/lib/format";
import {
  ADVANCE_MODE_OPTIONS,
  METAL_COLOR_PRESETS,
  ORDER_CATEGORY_OPTIONS,
  STOCK_ORDER_SLA_DAYS,
  type OrderCategory,
  type OrderKind,
} from "@/lib/mock/timelines";
import {
  useCreateOrder,
  useUploadOrderImage,
  useUploadReceipt,
} from "@/lib/queries/timelines";
import { cn, positiveNumberInput } from "@/lib/utils";
import {
  StoreScopeField,
  useStoreScope,
} from "@/components/common/store-scope-field";
import { useResetOn } from "@/lib/use-reset-on";

/** Local yyyy-mm-dd (en-CA yields that format without UTC drift). */
function todayIso(): string {
  return new Date().toLocaleDateString("en-CA");
}

/** Add `days` to a yyyy-mm-dd string, returning yyyy-mm-dd. */
function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA");
}

function prettyDate(iso: string): string {
  if (!iso) return "—";
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/** Parse a currency/qty input into a number, or undefined when blank/invalid. */
function toNumber(v: string): number | undefined {
  const n = Number(v);
  return v.trim() !== "" && Number.isFinite(n) ? n : undefined;
}

interface OrderBookingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Module 2 — Order Booking. Books a custom (bespoke) or stock (replenishment)
 * order against the active store. Stock orders auto-fill a fixed 21-day SLA
 * ETA. The reference image is uploaded after the order is created (needs the
 * new order id), then the orders list is invalidated.
 */
export function OrderBookingDialog({
  open,
  onOpenChange,
}: OrderBookingDialogProps) {
  const { targetStoreId, storeLabel, pickedStoreId, setPickedStoreId } =
    useStoreScope();
  const createOrder = useCreateOrder();
  const uploadImage = useUploadOrderImage();
  const uploadReceipt = useUploadReceipt();

  const [kind, setKind] = useState<OrderKind>("custom");
  const [customer, setCustomer] = useState("");
  const [category, setCategory] = useState<OrderCategory | "">("");
  const [item, setItem] = useState("");
  const [qty, setQty] = useState("1");
  const [details, setDetails] = useState("");
  const [bookedOn, setBookedOn] = useState(todayIso());
  const [eta, setEta] = useState("");
  const [etaTouched, setEtaTouched] = useState(false);
  const [advance, setAdvance] = useState("");
  const [advanceMode, setAdvanceMode] = useState("");
  const [estimation, setEstimation] = useState("");
  const [ringSize, setRingSize] = useState("");
  const [bangleSize, setBangleSize] = useState("");
  const [metalColorSel, setMetalColorSel] = useState("");
  const [metalColorOther, setMetalColorOther] = useState("");
  const [deliveryDate, setDeliveryDate] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const receiptRef = useRef<HTMLInputElement>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const metalColor =
    metalColorSel === "other" ? metalColorOther.trim() : metalColorSel;

  // Stock orders carry a fixed 21-day back-office SLA. Auto-fill the ETA from
  // the order-placed date unless the manager has overridden it (still editable).
  // Re-seeded during render, so the date field is never painted with the ETA
  // for the previously chosen order kind.
  useResetOn(etaTouched ? null : `${kind}|${bookedOn}`, () => {
    if (kind === "stock" && !etaTouched) {
      setEta(addDaysIso(bookedOn, STOCK_ORDER_SLA_DAYS));
    }
  });

  // Previews are DERIVED from the picked files; the effects exist only to
  // release the URLs once nothing is pointing at them.
  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => {
    if (!previewUrl) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const receiptUrl = useMemo(
    () => (receiptFile ? URL.createObjectURL(receiptFile) : null),
    [receiptFile],
  );
  useEffect(() => {
    if (!receiptUrl) return;
    return () => URL.revokeObjectURL(receiptUrl);
  }, [receiptUrl]);

  function reset() {
    setKind("custom");
    setCustomer("");
    setCategory("");
    setItem("");
    setQty("1");
    setDetails("");
    setBookedOn(todayIso());
    setEta("");
    setEtaTouched(false);
    setAdvance("");
    setAdvanceMode("");
    setEstimation("");
    setRingSize("");
    setBangleSize("");
    setMetalColorSel("");
    setMetalColorOther("");
    setDeliveryDate("");
    setFile(null);
    setReceiptFile(null);
    setErrors({});
    if (fileRef.current) fileRef.current.value = "";
    if (receiptRef.current) receiptRef.current.value = "";
  }

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    if (f && f.size > 8 * 1024 * 1024) {
      toast.error("Image is too large — please keep it under 8 MB.");
      e.target.value = "";
      return;
    }
    setFile(f);
  }

  function onPickReceipt(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    if (f && f.size > 8 * 1024 * 1024) {
      toast.error("Receipt image is too large — please keep it under 8 MB.");
      e.target.value = "";
      return;
    }
    setReceiptFile(f);
  }

  const submitting =
    createOrder.isPending || uploadImage.isPending || uploadReceipt.isPending;
  const isStock = kind === "stock";
  const advanceNum = toNumber(advance);
  const estimationNum = toNumber(estimation);

  async function save() {
    if (!targetStoreId) {
      toast.error("Select a store to book this order against.");
      return;
    }
    const name = customer.trim();
    const fe: Record<string, string> = {};
    if (kind === "custom" && !name)
      fe.customer = "Customer name is required for a custom order.";
    if (!item.trim() && !category)
      fe.item = "Add an item description or pick a category.";
    setErrors(fe);
    if (Object.keys(fe).length > 0) {
      toast.error("Please fill in the required fields.");
      return;
    }
    if (advanceNum !== undefined && estimationNum !== undefined && advanceNum > estimationNum) {
      toast.error("Advance received cannot exceed the estimate.");
      return;
    }

    try {
      const order = await createOrder.mutateAsync({
        storeId: targetStoreId,
        // Stock orders have no customer — record a clear placeholder instead.
        customerName: name || (isStock ? "Stock replenishment" : name),
        kind,
        category: category || undefined,
        qty: toNumber(qty),
        details: details.trim() || undefined,
        item: item.trim() || undefined,
        estimation: estimationNum,
        advanceReceived: advanceNum,
        advanceMode: advanceMode || undefined,
        // Custom-order specifics (ignored server-side for stock orders).
        ringSize: kind === "custom" ? ringSize.trim() || undefined : undefined,
        bangleSize:
          kind === "custom" ? bangleSize.trim() || undefined : undefined,
        metalColor: kind === "custom" ? metalColor || undefined : undefined,
        deliveryDate:
          kind === "custom" ? deliveryDate || undefined : undefined,
        bookedOn: bookedOn || undefined,
        // Let the server apply the +21-day SLA if a stock ETA is blank.
        eta: eta || undefined,
      });

      if (file && order?.id) {
        try {
          await uploadImage.mutateAsync({ id: order.id, file });
        } catch {
          toast.warning(
            "Order booked, but the reference image failed to upload. You can add it from the order.",
          );
        }
      }

      if (receiptFile && order?.id) {
        try {
          await uploadReceipt.mutateAsync({ id: order.id, file: receiptFile });
        } catch {
          toast.warning(
            "Order booked, but the advance receipt failed to upload. You can add it from the order.",
          );
        }
      }

      toast.success(
        isStock ? "Stock order booked" : "Custom order booked",
        { description: item.trim() || name || undefined },
      );
      reset();
      onOpenChange(false);
    } catch {
      toast.error("Could not book the order. Please try again.");
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
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Book an order</DialogTitle>
          <DialogDescription>
            Booked against {storeLabel}. Custom orders are bespoke customer
            pieces; stock orders replenish showcase inventory.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <StoreScopeField value={pickedStoreId} onChange={setPickedStoreId} />

          {/* Kind toggle */}
          <div className="grid gap-1.5">
            <Label>Order type</Label>
            <Tabs value={kind} onValueChange={(v) => setKind(v as OrderKind)}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="custom">
                  <Sparkles className="mr-1.5 h-4 w-4" />
                  Custom order
                </TabsTrigger>
                <TabsTrigger value="stock">
                  <Package className="mr-1.5 h-4 w-4" />
                  Stock (replenishment)
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          {/* Customer */}
          <div className="grid gap-1.5">
            <Label htmlFor="ob-customer">
              {isStock ? (
                "Requested for / reference"
              ) : (
                <>
                  Customer name <span className="text-destructive">*</span>
                </>
              )}
            </Label>
            <Input
              id="ob-customer"
              placeholder={
                isStock
                  ? "Optional — defaults to “Stock replenishment”"
                  : "e.g. Priya Sharma"
              }
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

          {/* Category + Quantity */}
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="ob-category">Category</Label>
              <Select
                value={category}
                onValueChange={(v) => {
                  setCategory(v as OrderCategory);
                  if (errors.item) setErrors((p) => ({ ...p, item: "" }));
                }}
              >
                <SelectTrigger id="ob-category">
                  <SelectValue placeholder="Select category" />
                </SelectTrigger>
                <SelectContent>
                  {ORDER_CATEGORY_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ob-qty">Quantity</Label>
              <Input
                id="ob-qty"
                type="number"
                min={1}
                inputMode="numeric"
                value={qty}
                onChange={(e) => setQty(positiveNumberInput(e.target.value))}
              />
            </div>
          </div>

          {/* Item / short description */}
          <div className="grid gap-1.5">
            <Label htmlFor="ob-item">Item / short description</Label>
            <Input
              id="ob-item"
              placeholder="e.g. 22K Bridal Necklace Set"
              value={item}
              onChange={(e) => {
                setItem(e.target.value);
                if (errors.item) setErrors((p) => ({ ...p, item: "" }));
              }}
              aria-invalid={!!errors.item}
            />
            {errors.item ? (
              <p className="mt-1 text-xs text-destructive">{errors.item}</p>
            ) : null}
          </div>

          {/* Details */}
          <div className="grid gap-1.5">
            <Label htmlFor="ob-details">Details</Label>
            <Textarea
              id="ob-details"
              placeholder="e.g. red stone → green, ring size 16, diamond 1.71ct"
              value={details}
              onChange={(e) => setDetails(e.target.value)}
            />
          </div>

          {/* Custom-order specifics */}
          {kind === "custom" ? (
            <div className="grid gap-3 rounded-lg border p-3">
              <p className="text-sm font-medium">Custom-order specifics</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="ob-ring">Ring size</Label>
                  <Input
                    id="ob-ring"
                    placeholder="e.g. 16"
                    value={ringSize}
                    onChange={(e) => setRingSize(e.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="ob-bangle">Bangle size</Label>
                  <Input
                    id="ob-bangle"
                    placeholder="e.g. 2.6"
                    value={bangleSize}
                    onChange={(e) => setBangleSize(e.target.value)}
                  />
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ob-metal">Metal colour</Label>
                <Select
                  value={metalColorSel}
                  onValueChange={setMetalColorSel}
                >
                  <SelectTrigger id="ob-metal">
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
                    placeholder="e.g. Platinum"
                    value={metalColorOther}
                    onChange={(e) => setMetalColorOther(e.target.value)}
                  />
                ) : null}
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ob-delivery">Promised delivery date</Label>
                <Input
                  id="ob-delivery"
                  type="date"
                  value={deliveryDate}
                  onChange={(e) => setDeliveryDate(e.target.value)}
                />
              </div>
            </div>
          ) : null}

          {/* Reference image */}
          <div className="grid gap-1.5">
            <Label>Reference image</Label>
            {previewUrl ? (
              <div className="relative flex items-center gap-3 rounded-lg border bg-muted/30 p-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={previewUrl}
                  alt="Reference preview"
                  className="h-16 w-16 shrink-0 rounded-md object-cover"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{file?.name}</p>
                  <p className="text-xs text-muted-foreground">
                    Uploaded after the order is created.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    setFile(null);
                    if (fileRef.current) fileRef.current.value = "";
                  }}
                >
                  <X className="h-4 w-4" />
                  <span className="sr-only">Remove image</span>
                </Button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className={cn(
                  "flex flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed border-muted-foreground/25 p-5 text-center transition-colors hover:border-primary/50",
                )}
              >
                <ImagePlus className="h-5 w-5 text-muted-foreground" />
                <span className="text-sm font-medium">Add a reference photo</span>
                <span className="text-xs text-muted-foreground">
                  JPG / PNG up to 8 MB — sketches and screenshots welcome
                </span>
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={onPickFile}
            />
          </div>

          {/* Dates */}
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="ob-booked">Order placed</Label>
              <Input
                id="ob-booked"
                type="date"
                value={bookedOn}
                onChange={(e) => setBookedOn(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ob-eta">Estimated delivery</Label>
              <Input
                id="ob-eta"
                type="date"
                value={eta}
                onChange={(e) => {
                  setEta(e.target.value);
                  setEtaTouched(true);
                }}
              />
            </div>
          </div>
          {isStock ? (
            <p className="-mt-2 flex items-start gap-1.5 rounded-md bg-primary/5 px-2.5 py-1.5 text-xs text-muted-foreground">
              <Package className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
              <span>
                Fixed {STOCK_ORDER_SLA_DAYS}-day back-office SLA — auto-set to{" "}
                <span className="num font-medium text-foreground">
                  {prettyDate(eta || addDaysIso(bookedOn, STOCK_ORDER_SLA_DAYS))}
                </span>
                . Editable if needed.
              </span>
            </p>
          ) : null}

          {/* Money */}
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="ob-advance">Advance received (₹)</Label>
              <Input
                id="ob-advance"
                type="number"
                min={0}
                inputMode="numeric"
                placeholder="0"
                value={advance}
                onChange={(e) => setAdvance(positiveNumberInput(e.target.value))}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ob-estimation">Estimate / quote (₹)</Label>
              <Input
                id="ob-estimation"
                type="number"
                min={0}
                inputMode="numeric"
                placeholder="0"
                value={estimation}
                onChange={(e) => setEstimation(positiveNumberInput(e.target.value))}
              />
            </div>
          </div>
          {advanceNum !== undefined && estimationNum !== undefined ? (
            <p className="-mt-2 text-xs text-muted-foreground">
              Balance due:{" "}
              <span className="num font-medium text-foreground">
                {formatINR(Math.max(estimationNum - advanceNum, 0))}
              </span>
            </p>
          ) : null}

          {/* Advance mode */}
          <div className="grid gap-1.5">
            <Label htmlFor="ob-advmode">Advance mode</Label>
            <Select value={advanceMode} onValueChange={setAdvanceMode}>
              <SelectTrigger id="ob-advmode">
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

          {/* Advance receipt */}
          <div className="grid gap-1.5">
            <Label>Advance receipt</Label>
            {receiptUrl ? (
              <div className="relative flex items-center gap-3 rounded-lg border bg-muted/30 p-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={receiptUrl}
                  alt="Advance receipt preview"
                  className="h-16 w-16 shrink-0 rounded-md object-cover"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {receiptFile?.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Uploaded after the order is created.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    setReceiptFile(null);
                    if (receiptRef.current) receiptRef.current.value = "";
                  }}
                >
                  <X className="h-4 w-4" />
                  <span className="sr-only">Remove receipt</span>
                </Button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => receiptRef.current?.click()}
                className={cn(
                  "flex flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed border-muted-foreground/25 p-4 text-center transition-colors hover:border-primary/50",
                )}
              >
                <ImagePlus className="h-5 w-5 text-muted-foreground" />
                <span className="text-sm font-medium">
                  Attach advance receipt
                </span>
                <span className="text-xs text-muted-foreground">
                  Photo of the cash/card/UPI receipt — up to 8 MB
                </span>
              </button>
            )}
            <input
              ref={receiptRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={onPickReceipt}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="gold" onClick={save} disabled={submitting}>
            {submitting ? "Booking…" : "Book order"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
