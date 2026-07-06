"use client";

import * as React from "react";
import { AlertCircle, BadgeIndianRupee, HandCoins } from "lucide-react";
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
import { formatINR } from "@/lib/format";
import { apiErrorMessage, cn } from "@/lib/utils";
import {
  PAYOUT_TYPE_LABELS,
  type PayoutType,
  type ReferralCode,
} from "@/lib/mock/loyalty";
import { usePayout } from "@/lib/queries/loyalty";

/** Parse a numeric input into a number, or undefined when blank/invalid. */
function toNumber(v: string): number | undefined {
  const n = Number(v);
  return v.trim() !== "" && Number.isFinite(n) ? n : undefined;
}

interface PayoutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  code: ReferralCode | null;
}

/**
 * Module 17 — redeem or cash out a referrer's accrued commission.
 * The amount can't exceed the code's `commissionBalance` (guarded client-side
 * and enforced by the API's 400). On success we show the new balance from the
 * response and let the caller's invalidation refresh the list.
 */
export function PayoutDialog({ open, onOpenChange, code }: PayoutDialogProps) {
  const payout = usePayout();

  const [amount, setAmount] = React.useState("");
  const [type, setType] = React.useState<PayoutType>("redeem");
  const [error, setError] = React.useState<string | null>(null);
  const [balanceAfter, setBalanceAfter] = React.useState<number | null>(null);

  const balance = code?.commissionBalance ?? 0;
  const amt = toNumber(amount);
  const exceeds = amt != null && amt > balance;

  // Reset local state each time a new code opens the dialog.
  React.useEffect(() => {
    if (open) {
      setAmount("");
      setType("redeem");
      setError(null);
      setBalanceAfter(null);
    }
  }, [open, code?.id]);

  function submit() {
    setError(null);
    if (!code) return;
    if (amt == null || amt <= 0) {
      toast.error("Enter an amount to pay out.");
      return;
    }
    if (exceeds) {
      setError("Amount exceeds the available commission balance.");
      return;
    }
    payout.mutate(
      { codeId: code.id, amount: amt, type },
      {
        onSuccess: (res) => {
          setBalanceAfter(res.balanceAfter);
          toast.success(
            `${PAYOUT_TYPE_LABELS[type]} of ${formatINR(amt)} recorded`,
            { description: `New balance ${formatINR(res.balanceAfter)}` },
          );
        },
        onError: (err) => {
          setError(apiErrorMessage(err, "Could not process the payout."));
        },
      },
    );
  }

  const shownBalance = balanceAfter ?? balance;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HandCoins className="h-4 w-4 text-gold-strong" />
            Redeem / cash out
          </DialogTitle>
          <DialogDescription>
            {code
              ? `Pay out ${code.referrerName}’s accrued commission.`
              : "Select a code first."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          {/* Available balance */}
          <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-4 py-3">
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <BadgeIndianRupee className="h-4 w-4" />
              {balanceAfter != null ? "Balance now" : "Available balance"}
            </span>
            <span className="num text-lg font-semibold text-gold-strong">
              {formatINR(shownBalance)}
            </span>
          </div>

          {balanceAfter == null ? (
            <>
              {/* Type toggle */}
              <div className="grid grid-cols-2 gap-2">
                {(["redeem", "cashout"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setType(t)}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-sm font-medium transition-colors",
                      type === t
                        ? "border-gold-strong bg-[color-mix(in_srgb,var(--gold)_12%,transparent)] text-gold-strong"
                        : "text-muted-foreground hover:bg-muted/50",
                    )}
                  >
                    {PAYOUT_TYPE_LABELS[t]}
                  </button>
                ))}
              </div>
              <p className="-mt-2 text-[11px] text-muted-foreground">
                {type === "redeem"
                  ? "Adjust the commission against a purchase in-store."
                  : "Pay the commission out as cash."}
              </p>

              {/* Amount */}
              <div className="grid gap-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="po-amount">Amount (₹)</Label>
                  <button
                    type="button"
                    className="text-[11px] text-gold-strong underline underline-offset-2"
                    onClick={() => setAmount(String(balance))}
                    disabled={balance <= 0}
                  >
                    Use full balance
                  </button>
                </div>
                <Input
                  id="po-amount"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={balance}
                  placeholder="0"
                  value={amount}
                  onChange={(e) => {
                    setAmount(e.target.value);
                    setError(null);
                  }}
                  aria-invalid={exceeds}
                />
                {exceeds ? (
                  <p className="text-[11px] text-destructive">
                    Can’t exceed {formatINR(balance)}.
                  </p>
                ) : null}
              </div>

              {error ? (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </div>
              ) : null}
            </>
          ) : null}
        </div>

        <DialogFooter>
          {balanceAfter != null ? (
            <Button variant="gold" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                variant="gold"
                onClick={submit}
                disabled={payout.isPending || !code || balance <= 0 || exceeds}
              >
                {payout.isPending
                  ? "Processing…"
                  : `${PAYOUT_TYPE_LABELS[type]} ${amt ? formatINR(amt) : ""}`.trim()}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
