"use client";

import * as React from "react";
import { Copy, Gem, Sparkles } from "lucide-react";
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
  REFERRAL_COMMISSION_PCT,
  REFERRAL_DIAMOND_DISCOUNT_PCT,
} from "@/lib/mock/loyalty";
import { useCreateReferralCode } from "@/lib/queries/loyalty";
import { useSession } from "@/store/use-session";

/** Parse a numeric input into a positive integer, or undefined when blank. */
function toMaxUses(v: string): number | undefined {
  const n = Math.floor(Number(v));
  return v.trim() !== "" && Number.isFinite(n) && n > 0 ? n : undefined;
}

interface CreateReferralCodeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Module 17 — mint an "Earn with Ratanlall" coupon code for a referrer (X).
 * The server generates the actual code; we capture the referrer + an optional
 * usage cap (a leaked-code safeguard the owner asked for).
 */
export function CreateReferralCodeDialog({
  open,
  onOpenChange,
}: CreateReferralCodeDialogProps) {
  const { currentStore } = useSession();
  const createCode = useCreateReferralCode();

  const targetStoreId = currentStore.isAggregate
    ? "surat-main"
    : currentStore.id;

  const [name, setName] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [maxUses, setMaxUses] = React.useState("");

  function reset() {
    setName("");
    setPhone("");
    setMaxUses("");
  }

  function submit() {
    if (!name.trim()) {
      toast.error("Referrer name is required.");
      return;
    }
    createCode.mutate(
      {
        referrerName: name.trim(),
        referrerPhone: phone.trim() || undefined,
        maxUses: toMaxUses(maxUses),
        storeId: targetStoreId,
      },
      {
        onSuccess: (code) => {
          toast.success("Referral code created", {
            description: (
              <span className="inline-flex items-center gap-2">
                <span className="num font-medium">{code.code}</span>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-xs underline underline-offset-2"
                  onClick={() => {
                    void navigator.clipboard?.writeText(code.code);
                    toast.success("Code copied");
                  }}
                >
                  <Copy className="h-3 w-3" /> Copy
                </button>
              </span>
            ),
          });
          reset();
          onOpenChange(false);
        },
        onError: () => toast.error("Could not create the referral code."),
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
            <Sparkles className="h-4 w-4 text-gold-strong" />
            Create referral code
          </DialogTitle>
          <DialogDescription>
            Mint an “Earn with Ratanlall” code for a referrer. They earn{" "}
            {REFERRAL_COMMISSION_PCT}% on every referred bill; their referrals
            get {REFERRAL_DIAMOND_DISCOUNT_PCT}% off diamond.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="rc-name">
              Referrer name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="rc-name"
              placeholder="e.g. Priya Sharma"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="rc-phone">Phone</Label>
            <Input
              id="rc-phone"
              placeholder="+91 …"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="rc-max">Max uses</Label>
            <Input
              id="rc-max"
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              placeholder="Unlimited"
              value={maxUses}
              onChange={(e) => setMaxUses(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">
              Optional cap so a shared code can’t be used endlessly — leave blank
              for unlimited.
            </p>
          </div>

          <div className="flex items-start gap-2 rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
            <Gem className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gold-strong" />
            The code is generated by the system and shown in the codes list —
            copy and share it on WhatsApp.
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="gold" onClick={submit} disabled={createCode.isPending}>
            {createCode.isPending ? "Creating…" : "Create code"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
