"use client";

import * as React from "react";
import { format } from "date-fns";
import { AlertCircle, ArrowRight, CheckCircle2, Receipt, Wallet } from "lucide-react";
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
import { formatINR, formatPercent } from "@/lib/format";
import { REFERRAL_COMMISSION_PCT, type Referral } from "@/lib/mock/loyalty";
import { useApplyReferral, useReferralCodes } from "@/lib/queries/loyalty";
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
  /** Pre-select the referrer account (e.g. from a row's "Record" action). */
  initialReferrerId?: string;
}

/**
 * Module 17 — record a referred purchase against a referrer account (client
 * rework, 9 Oct 2026). No code is asked for: the referrer is picked by
 * name/phone from the accounts list. The purchase is recorded with the referred
 * customer, bill date, invoice number and bill amount, and the account is
 * credited {@link REFERRAL_COMMISSION_PCT}% of the bill (the server is
 * authoritative; the percent is stored per entry).
 */
export function ApplyReferralDialog({
  open,
  onOpenChange,
  initialReferrerId,
}: ApplyReferralDialogProps) {
  const { targetStoreId, pickedStoreId, setPickedStoreId } = useStoreScope();
  const applyReferral = useApplyReferral();
  const { data: accounts = [] } = useReferralCodes();

  const today = format(new Date(), "yyyy-MM-dd");

  const [referrerId, setReferrerId] = React.useState(initialReferrerId ?? "");
  const [refereeName, setRefereeName] = React.useState("");
  const [refereePhone, setRefereePhone] = React.useState("");
  const [bill, setBill] = React.useState("");
  const [invoiceNo, setInvoiceNo] = React.useState("");
  const [billDate, setBillDate] = React.useState(today);
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>(
    {},
  );
  const [result, setResult] = React.useState<Referral | null>(null);

  // Re-seed the referrer whenever the dialog is (re)opened for a specific row.
  useResetOn(open ? (initialReferrerId ?? "") : null, () => {
    if (open) setReferrerId(initialReferrerId ?? "");
  });

  function reset() {
    setReferrerId(initialReferrerId ?? "");
    setRefereeName("");
    setRefereePhone("");
    setBill("");
    setInvoiceNo("");
    setBillDate(today);
    setError(null);
    setFieldErrors({});
    setResult(null);
  }

  const referrer = accounts.find((a) => a.id === referrerId) ?? null;
  const billAmount = toNumber(bill);
  // Credit is a clean 5% of the total bill — safe to preview client-side.
  const estCredit =
    billAmount != null ? (billAmount * REFERRAL_COMMISSION_PCT) / 100 : null;

  function submit() {
    setError(null);
    if (!targetStoreId) {
      toast.error("Select a store to record this purchase at.");
      return;
    }
    const fe: Record<string, string> = {};
    if (!referrerId) fe.referrer = "Choose the referrer account.";
    if (!refereeName.trim()) fe.refereeName = "Referred customer is required.";
    if (billAmount == null || billAmount <= 0)
      fe.bill = "Enter the total bill amount.";
    if (!invoiceNo.trim()) fe.invoiceNo = "Invoice number is required.";
    if (!billDate) fe.billDate = "Purchase date is required.";
    setFieldErrors(fe);
    if (Object.keys(fe).length > 0) {
      toast.error("Please fill in the required fields.");
      return;
    }
    // Validated above; narrow for the type-checker.
    if (billAmount == null) return;
    applyReferral.mutate(
      {
        referrerId,
        refereeName: refereeName.trim(),
        refereePhone: refereePhone.trim() || undefined,
        billAmount,
        storeId: targetStoreId,
        invoiceNo: invoiceNo.trim(),
        billDate,
      },
      {
        onSuccess: (rec) => {
          setResult(rec);
          toast.success("Purchase recorded", {
            description: `${formatINR(rec.commissionAmount)} credited to ${
              rec.referrerName ?? referrer?.referrerName ?? "the referrer"
            }.`,
          });
        },
        onError: (err) => {
          // 400 = capped legacy code / server rule — inline, no crash.
          setError(
            apiErrorMessage(
              err,
              "Could not record this purchase. Check the details and try again.",
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
            <Receipt className="h-4 w-4 text-gold-strong" />
            Record referred purchase
          </DialogTitle>
          <DialogDescription>
            The referrer is credited {REFERRAL_COMMISSION_PCT}% of the bill into
            their wallet.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          /* ---- Outcome: the authoritative credit from the API ---- */
          <div className="grid gap-4">
            <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 p-3 text-sm text-success">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              Recorded for <span className="font-medium">{result.refereeName}</span>
              {" · "}
              <span className="num">{formatINR(result.billAmount)}</span> bill.
            </div>

            <div className="rounded-lg border bg-card p-4">
              <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Wallet className="h-3.5 w-3.5 text-gold-strong" />
                Credit earned by {result.referrerName ?? referrer?.referrerName ?? "the referrer"}
              </div>
              <div className="num mt-1 text-xl font-semibold text-gold-strong">
                {formatINR(result.commissionAmount)}
              </div>
              <div className="text-[11px] text-muted-foreground">
                {formatPercent(result.commissionPct)} of the total bill
              </div>
            </div>

            <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2 text-xs">
              <span className="text-muted-foreground">
                Wallet balance now{" "}
                <span className="num font-medium text-foreground">
                  {formatINR(result.codeBalanceAfter)}
                </span>
              </span>
              <span className="text-muted-foreground">
                Referrals:{" "}
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
                  setBillDate(today);
                }}
              >
                Record another
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
              <Label htmlFor="ar-referrer">
                Referrer account <span className="text-destructive">*</span>
              </Label>
              <Select
                value={referrerId}
                onValueChange={(v) => {
                  setReferrerId(v);
                  setError(null);
                  if (fieldErrors.referrer)
                    setFieldErrors((p) => ({ ...p, referrer: "" }));
                }}
                disabled={accounts.length === 0}
              >
                <SelectTrigger id="ar-referrer" aria-invalid={!!fieldErrors.referrer}>
                  <SelectValue
                    placeholder={
                      accounts.length === 0
                        ? "No referrer accounts yet"
                        : "Choose the referrer"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.referrerName}
                      {a.referrerPhone ? ` · ${a.referrerPhone}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {fieldErrors.referrer ? (
                <p className="mt-1 text-xs text-destructive">
                  {fieldErrors.referrer}
                </p>
              ) : null}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="ar-name">
                  Referred customer <span className="text-destructive">*</span>
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
                <Label htmlFor="ar-phone">Phone</Label>
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
              {estCredit != null && estCredit > 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  ≈ {formatINR(estCredit)} credit ({REFERRAL_COMMISSION_PCT}% of
                  the bill) to the referrer&apos;s wallet.
                </p>
              ) : null}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="ar-invoice">
                  Invoice No <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="ar-invoice"
                  placeholder="e.g. INV-2026-0481"
                  value={invoiceNo}
                  onChange={(e) => {
                    setInvoiceNo(e.target.value);
                    if (fieldErrors.invoiceNo)
                      setFieldErrors((p) => ({ ...p, invoiceNo: "" }));
                  }}
                  aria-invalid={!!fieldErrors.invoiceNo}
                />
                {fieldErrors.invoiceNo ? (
                  <p className="mt-1 text-xs text-destructive">
                    {fieldErrors.invoiceNo}
                  </p>
                ) : null}
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ar-billdate">
                  Purchase date <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="ar-billdate"
                  type="date"
                  value={billDate}
                  onChange={(e) => {
                    setBillDate(e.target.value);
                    if (fieldErrors.billDate)
                      setFieldErrors((p) => ({ ...p, billDate: "" }));
                  }}
                  aria-invalid={!!fieldErrors.billDate}
                />
                {fieldErrors.billDate ? (
                  <p className="mt-1 text-xs text-destructive">
                    {fieldErrors.billDate}
                  </p>
                ) : null}
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
                  "Recording…"
                ) : (
                  <>
                    Record purchase
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
