"use client";

import * as React from "react";
import { Check, Gem, Hammer, Lock, ShieldAlert } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatINR, formatPercent } from "@/lib/format";
import { cn, apiErrorMessage, isRealName, positiveNumberInput } from "@/lib/utils";
import { ROLE_LABELS } from "@/lib/types";
import {
  DISCOUNT_STATUS_LABELS,
  STORE_MANAGER_CAPS,
} from "@/lib/mock/discounts";
import { useCreateDiscountRequest, useDiscountPresets } from "@/lib/queries/discounts";
import {
  StoreScopeField,
  useStoreScope,
} from "@/components/common/store-scope-field";


/** Parse a numeric input into a number, or undefined when blank/invalid. */
function toNumber(v: string): number | undefined {
  const n = Number(v);
  return v.trim() !== "" && Number.isFinite(n) ? n : undefined;
}

interface DiscountRequestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Module 15 — raise a discount request.
 *
 * Gold is never discounted, so we only collect **diamond %** and **making %**
 * (plus the selling price). We never ask for — or show — cost or margin here;
 * that stays with the approver. The server decides auto-approve vs escalate and
 * returns the `status` + `requiredRole`, which we surface on submit.
 */
export function DiscountRequestDialog({
  open,
  onOpenChange,
}: DiscountRequestDialogProps) {
  const { targetStoreId, storeLabel, pickedStoreId, setPickedStoreId } =
    useStoreScope();
  const createRequest = useCreateDiscountRequest();
  const { data: presets = [] } = useDiscountPresets();

  const [customer, setCustomer] = React.useState("");
  const [item, setItem] = React.useState("");
  const [selectedPreset, setSelectedPreset] = React.useState<string>("");
  const [diamond, setDiamond] = React.useState("");
  const [making, setMaking] = React.useState("");
  const [selling, setSelling] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  const diamondPct = toNumber(diamond) ?? 0;
  const makingPct = toNumber(making) ?? 0;
  const hasDiscount = diamondPct > 0 || makingPct > 0;

  // Client-side prediction only — the server is authoritative on submit.
  const withinCaps =
    diamondPct <= STORE_MANAGER_CAPS.diamondPercent &&
    makingPct <= STORE_MANAGER_CAPS.makingPercent;

  function reset() {
    setCustomer("");
    setItem("");
    setDiamond("");
    setMaking("");
    setSelling("");
    setReason("");
    setErrors({});
  }

  function submit() {
    if (!targetStoreId) {
      toast.error("Select a store to raise this request against.");
      return;
    }
    const fe: Record<string, string> = {};
    if (!customer.trim()) fe.customer = "Customer name is required.";
    else if (!isRealName(customer)) fe.customer = "Enter a real name — letters, not just a number.";
    if (!item.trim()) fe.item = "Item name is required.";
    else if (!isRealName(item)) fe.item = "Enter a real item name.";
    if (!hasDiscount)
      fe.discount = "Enter a diamond % or making % — gold is never discounted.";
    setErrors(fe);
    if (Object.keys(fe).length > 0) {
      toast.error("Please fill in the required fields.");
      return;
    }
    createRequest.mutate(
      {
        storeId: targetStoreId,
        customerName: customer.trim(),
        item: item.trim(),
        diamondPercent: diamondPct,
        makingPercent: makingPct,
        sellingPrice: toNumber(selling),
        reason: reason.trim() || undefined,
      },
      {
        onSuccess: (rec) => {
          if (rec.status === "approved") {
            toast.success("Discount auto-approved", {
              description: `Within store-manager caps · Diamond ${formatPercent(
                rec.diamondPercent,
              )} / Making ${formatPercent(rec.makingPercent)}.`,
            });
          } else {
            toast.info(
              `Sent to ${ROLE_LABELS[rec.requiredRole]} for approval`,
              {
                description: `${DISCOUNT_STATUS_LABELS[rec.status]} · Diamond ${formatPercent(
                  rec.diamondPercent,
                )} / Making ${formatPercent(rec.makingPercent)}.`,
              },
            );
          }
          reset();
          onOpenChange(false);
        },
        onError: (err) => toast.error(apiErrorMessage(err, "Could not submit the discount request.")),
      },
    );
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
          <DialogTitle>Request a discount</DialogTitle>
          <DialogDescription>
            Raised against {storeLabel}. Within store-manager caps it
            auto-approves; higher amounts escalate for approval.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <StoreScopeField value={pickedStoreId} onChange={setPickedStoreId} />

          <div className="grid gap-1.5">
            <Label htmlFor="dr-customer">
              Customer name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="dr-customer"
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

          <div className="grid gap-1.5">
            <Label htmlFor="dr-item">
              Item <span className="text-destructive">*</span>
            </Label>
            <Input
              id="dr-item"
              placeholder="e.g. 18K Diamond Ring — DR-3380"
              value={item}
              onChange={(e) => {
                setItem(e.target.value);
                if (errors.item) setErrors((p) => ({ ...p, item: "" }));
              }}
              aria-invalid={!!errors.item}
            />
            {errors.item ? (
              <p className="mt-1 text-xs text-destructive">{errors.item}</p>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                Product name or code.
              </p>
            )}
          </div>

          {/* Discount Preset Code Dropdown */}
          <div className="grid gap-1.5">
            <Label htmlFor="dr-preset">Preset Discount Code</Label>
            <Select
              value={selectedPreset}
              onValueChange={(code) => {
                setSelectedPreset(code);
                const p = presets.find((pr) => pr.code === code);
                if (p) {
                  setDiamond(String(p.diamondPercent));
                  setMaking(String(p.makingPercent));
                  if (errors.discount) setErrors((prev) => ({ ...prev, discount: "" }));
                }
              }}
            >
              <SelectTrigger id="dr-preset">
                <SelectValue placeholder="Select preset code (or enter manually below)" />
              </SelectTrigger>
              <SelectContent>
                {presets.map((p) => (
                  <SelectItem key={p.code} value={p.code}>
                    {p.code} — {p.name} ({p.diamondPercent}% Dia / {p.makingPercent}% Making)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Gold-no-discount note + the two discountable inputs. */}
          <div className="rounded-lg border bg-muted/20 p-4">
            <p className="mb-3 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Lock className="h-3.5 w-3.5" />
              Gold: no discount — only diamond &amp; making are discountable.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label
                  htmlFor="dr-diamond"
                  className="flex items-center gap-1.5"
                >
                  <Gem className="h-3.5 w-3.5 text-primary" />
                  Diamond %
                </Label>
                <Input
                  id="dr-diamond"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={100}
                  step={0.5}
                  placeholder="0"
                  value={diamond}
                  onChange={(e) => {
                    setDiamond(positiveNumberInput(e.target.value));
                    if (errors.discount)
                      setErrors((p) => ({ ...p, discount: "" }));
                  }}
                  aria-invalid={!!errors.discount}
                />
              </div>
              <div className="grid gap-1.5">
                <Label
                  htmlFor="dr-making"
                  className="flex items-center gap-1.5"
                >
                  <Hammer className="h-3.5 w-3.5 text-primary" />
                  Making %
                </Label>
                <Input
                  id="dr-making"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={100}
                  step={0.5}
                  placeholder="0"
                  value={making}
                  onChange={(e) => {
                    setMaking(positiveNumberInput(e.target.value));
                    if (errors.discount)
                      setErrors((p) => ({ ...p, discount: "" }));
                  }}
                  aria-invalid={!!errors.discount}
                />
              </div>
            </div>
            {errors.discount ? (
              <p className="mt-2 text-xs text-destructive">{errors.discount}</p>
            ) : null}
          </div>

          <div className="grid gap-1.5 sm:max-w-xs">
            <Label htmlFor="dr-selling">Selling price (₹)</Label>
            <Input
              id="dr-selling"
              type="number"
              inputMode="numeric"
              min={0}
              placeholder="0"
              value={selling}
              onChange={(e) => setSelling(positiveNumberInput(e.target.value))}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="dr-reason">Reason</Label>
            <Textarea
              id="dr-reason"
              placeholder="Context for the approver — bulk order, repeat customer, price-match…"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>

          {/* Live outcome hint (server decides on submit). */}
          {hasDiscount ? (
            <div
              className={cn(
                "flex items-start gap-2 rounded-lg border p-3 text-sm",
                withinCaps
                  ? "border-success/30 bg-success/10"
                  : "border-warning/30 bg-warning/10",
              )}
            >
              {withinCaps ? (
                <>
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                  <span>
                    Within store-manager caps (Diamond ≤{" "}
                    {formatPercent(STORE_MANAGER_CAPS.diamondPercent)} / Making ≤{" "}
                    {formatPercent(STORE_MANAGER_CAPS.makingPercent)}) — likely
                    auto-approved.
                  </span>
                </>
              ) : (
                <>
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                  <span>
                    Above store-manager caps — this will escalate for approval.
                  </span>
                </>
              )}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="gold"
            onClick={submit}
            disabled={createRequest.isPending}
          >
            {createRequest.isPending ? "Submitting…" : "Submit request"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
