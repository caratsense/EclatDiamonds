"use client";

import * as React from "react";
import { AlertCircle, ArrowRight, CheckCircle2, Gem, Wallet } from "lucide-react";
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
import { formatINR, formatPercent } from "@/lib/format";
import {
  REFERRAL_COMMISSION_PCT,
  REFERRAL_DIAMOND_DISCOUNT_PCT,
  type Referral,
} from "@/lib/mock/loyalty";
import { useApplyReferral } from "@/lib/queries/loyalty";
import {
  StoreScopeField,
  useStoreScope,
} from "@/components/common/store-scope-field";
import { apiErrorMessage, phoneInputValue, positiveNumberInput } from "@/lib/utils";
import { useResetOn } from "@/lib/use-reset-on";

/** Parse a numeric input into a number, or undefined when blank/invalid. */
function toNumber(v: string): number | undefined {
  const n = Number(v);
  return v.trim() !== "" && Number.isFinite(n) ? n : undefined;
}

interface ApplyReferralDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-fill the code (e.g. from the "Apply" action on a code row). */
  initialCode?: string;
}

/**
 * Module 17 — apply an "Earn with Éclat" code at a sale.
 *
 * Referee Y gets {@link REFERRAL_DIAMOND_DISCOUNT_PCT}% off their diamond value;
 * referrer X earns {@link REFERRAL_COMMISSION_PCT}% commission on Y's total
 * bill. The server is authoritative on both amounts (it knows the diamond
 * split), so we render the returned figures. A 400 "usage limit reached" is
 * caught and shown inline — never a crash.
 */
export function ApplyReferralDialog({
  open,
  onOpenChange,
  initialCode,
}: ApplyReferralDialogProps) {
  const { targetStoreId, pickedStoreId, setPickedStoreId } = useStoreScope();
  const applyReferral = useApplyReferral();

  const [code, setCode] = React.useState(initialCode ?? "");
  const [refereeName, setRefereeName] = React.useState("");
  const [refereePhone, setRefereePhone] = React.useState("");
  const [bill, setBill] = React.useState("");
  const [invoiceNo, setInvoiceNo] = React.useState("");
  const [billDate, setBillDate] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>(
    {},
  );
  const [result, setResult] = React.useState<Referral | null>(null);

  // Re-seed the code whenever the dialog is (re)opened for a specific row.
  useResetOn(open ? (initialCode ?? "") : null, () => {
    if (open) setCode(initialCode ?? "");
  });

  function reset() {
    setCode(initialCode ?? "");
    setRefereeName("");
    setRefereePhone("");
    setBill("");
    setInvoiceNo("");
    setBillDate("");
    setError(null);
    setFieldErrors({});
    setResult(null);
  }

  const billAmount = toNumber(bill);
  // Commission is a clean 5% of the total bill — safe to preview client-side.
  const estCommission =
    billAmount != null ? (billAmount * REFERRAL_COMMISSION_PCT) / 100 : null;

  function submit() {
    setError(null);
    if (!targetStoreId) {
      toast.error("Select a store to apply this referral at.");
      return;
    }
    const fe: Record<string, string> = {};
    if (!code.trim()) fe.code = "Referral code is required.";
    if (!refereeName.trim()) fe.refereeName = "Referee name is required.";
    if (billAmount == null || billAmount <= 0)
      fe.bill = "Enter the referee's total bill amount.";
    setFieldErrors(fe);
    if (Object.keys(fe).length > 0) {
      toast.error("Please fill in the required fields.");
      return;
    }
    // Validated above; narrow for the type-checker.
    if (billAmount == null) return;
    applyReferral.mutate(
      {
        code: code.trim(),
        refereeName: refereeName.trim(),
        refereePhone: refereePhone.trim() || undefined,
        billAmount,
        storeId: targetStoreId,
        invoiceNo: invoiceNo.trim() || undefined,
        billDate: billDate || undefined,
      },
      {
        onSuccess: (rec) => {
          setResult(rec);
          toast.success("Referral applied", {
            description: `${formatINR(
              rec.diamondDiscountAmount,
            )} off diamond · ${formatINR(rec.commissionAmount)} commission`,
          });
        },
        onError: (err) => {
          // 400 = usage limit reached (or other server rule) — inline, no crash.
          setError(
            apiErrorMessage(
              err,
              "Could not apply this code. Check the code and try again.",
            ),
          );
        },
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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Gem className="h-4 w-4 text-gold-strong" />
            Apply a referral
          </DialogTitle>
          <DialogDescription>
            {REFERRAL_DIAMOND_DISCOUNT_PCT}% off diamond for the referee ·{" "}
            {REFERRAL_COMMISSION_PCT}% commission credited to the referrer.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          /* ---- Outcome: the authoritative 5% / 5% split from the API ---- */
          <div className="grid gap-4">
            <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 p-3 text-sm text-success">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              Applied for <span className="font-medium">{result.refereeName}</span>
              {" · "}
              <span className="num">{formatINR(result.billAmount)}</span> bill.
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border bg-card p-4">
                <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Gem className="h-3.5 w-3.5 text-primary" />
                  Referee diamond discount
                </div>
                <div className="num mt-1 text-xl font-semibold">
                  {formatINR(result.diamondDiscountAmount)}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {formatPercent(result.diamondDiscountPct)} off diamond value
                </div>
              </div>
              <div className="rounded-lg border bg-card p-4">
                <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Wallet className="h-3.5 w-3.5 text-gold-strong" />
                  Referrer commission
                </div>
                <div className="num mt-1 text-xl font-semibold text-gold-strong">
                  {formatINR(result.commissionAmount)}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {formatPercent(result.commissionPct)} of the total bill
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2 text-xs">
              <span className="text-muted-foreground">
                Code balance now{" "}
                <span className="num font-medium text-foreground">
                  {formatINR(result.codeBalanceAfter)}
                </span>
              </span>
              <span className="text-muted-foreground">
                Uses:{" "}
                <span className="num font-medium text-foreground">
                  {result.usesAfter}
                </span>
              </span>
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setResult(null);
                  setError(null);
                  setFieldErrors({});
                  setRefereeName("");
                  setRefereePhone("");
                  setBill("");
                  setInvoiceNo("");
                  setBillDate("");
                }}
              >
                Apply another
              </Button>
              <Button variant="gold" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          /* ---- Entry form ---- */
          <div className="grid gap-4">
            <StoreScopeField
              value={pickedStoreId}
              onChange={setPickedStoreId}
            />

            <div className="grid gap-1.5">
              <Label htmlFor="ar-code">
                Referral code <span className="text-destructive">*</span>
              </Label>
              <Input
                id="ar-code"
                className="num uppercase"
                placeholder="RTL-…"
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                  setError(null);
                  if (fieldErrors.code)
                    setFieldErrors((p) => ({ ...p, code: "" }));
                }}
                aria-invalid={!!fieldErrors.code}
              />
              {fieldErrors.code ? (
                <p className="mt-1 text-xs text-destructive">
                  {fieldErrors.code}
                </p>
              ) : null}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="ar-name">
                  Referee name <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="ar-name"
                  placeholder="e.g. Rahul Mehta"
                  value={refereeName}
                  onChange={(e) => {
                    setRefereeName(e.target.value);
                    if (fieldErrors.refereeName)
                      setFieldErrors((p) => ({ ...p, refereeName: "" }));
                  }}
                  aria-invalid={!!fieldErrors.refereeName}
                />
                {fieldErrors.refereeName ? (
                  <p className="mt-1 text-xs text-destructive">
                    {fieldErrors.refereeName}
                  </p>
                ) : null}
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ar-phone">Referee phone</Label>
                <Input
                  id="ar-phone"
                  placeholder="10-digit mobile"
                  inputMode="numeric"
                  maxLength={10}
                  value={refereePhone}
                  onChange={(e) => setRefereePhone(phoneInputValue(e.target.value))}
                />
              </div>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="ar-bill">
                Total bill (₹) <span className="text-destructive">*</span>
              </Label>
              <Input
                id="ar-bill"
                type="number"
                inputMode="numeric"
                min={0}
                placeholder="0"
                value={bill}
                onChange={(e) => {
                  setBill(positiveNumberInput(e.target.value));
                  if (fieldErrors.bill)
                    setFieldErrors((p) => ({ ...p, bill: "" }));
                }}
                aria-invalid={!!fieldErrors.bill}
              />
              {fieldErrors.bill ? (
                <p className="mt-1 text-xs text-destructive">
                  {fieldErrors.bill}
                </p>
              ) : null}
              {estCommission != null && estCommission > 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  ≈ {formatINR(estCommission)} commission ({REFERRAL_COMMISSION_PCT}
                  % of bill). Exact diamond discount is computed on submit.
                </p>
              ) : null}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="ar-invoice">Invoice No</Label>
                <Input
                  id="ar-invoice"
                  placeholder="e.g. INV-2026-0481"
                  value={invoiceNo}
                  onChange={(e) => setInvoiceNo(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ar-billdate">Bill date</Label>
                <Input
                  id="ar-billdate"
                  type="date"
                  value={billDate}
                  onChange={(e) => setBillDate(e.target.value)}
                />
              </div>
            </div>

            {error ? (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            ) : null}

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                variant="gold"
                onClick={submit}
                disabled={applyReferral.isPending}
              >
                {applyReferral.isPending ? (
                  "Applying…"
                ) : (
                  <>
                    Apply code
                    <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
