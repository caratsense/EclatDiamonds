"use client";

import * as React from "react";
import { Check, Search, UserRound } from "lucide-react";
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
import { Skeleton } from "@/components/ui/skeleton";
import { REFERRAL_COMMISSION_PCT } from "@/lib/mock/loyalty";
import { useCreateReferralCode } from "@/lib/queries/loyalty";
import { useParties, type PartyRow } from "@/lib/queries/parties";
import {
  StoreScopeField,
  useStoreScope,
} from "@/components/common/store-scope-field";
import { apiErrorMessage, cn, normalizeIndianMobile } from "@/lib/utils";

interface CreateReferralCodeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Module 17 — open a REFERRER ACCOUNT for an existing customer (client rework,
 * 9 Oct 2026). The old flow minted a coupon code to share; now the referrer is
 * simply chosen from the customer directory by name/phone (same lookup the
 * consent screen uses) and purchases are recorded against their account. The
 * server still mints an internal code on the row — legacy codes stay readable —
 * but it is no longer part of the workflow, so it is not surfaced here.
 */
export function CreateReferralCodeDialog({
  open,
  onOpenChange,
}: CreateReferralCodeDialogProps) {
  const { targetStoreId, pickedStoreId, setPickedStoreId } = useStoreScope();
  const createAccount = useCreateReferralCode();

  const [search, setSearch] = React.useState("");
  const [selected, setSelected] = React.useState<PartyRow | null>(null);

  const parties = useParties({
    page: 1,
    pageSize: 8,
    q: search.trim() || undefined,
    type: "customer",
  });

  function reset() {
    setSearch("");
    setSelected(null);
  }

  function submit() {
    if (!targetStoreId) {
      toast.error("Select a store to open this account at.");
      return;
    }
    if (!selected) {
      toast.error("Search for and choose the customer who will refer.");
      return;
    }
    // Party phones can be stored formatted; the API validates a bare 10-digit
    // mobile, so normalise — and omit it rather than fail when it is not one.
    const phone = selected.phone ? normalizeIndianMobile(selected.phone) : null;
    createAccount.mutate(
      {
        referrerName: selected.name,
        referrerPhone: phone ?? undefined,
        storeId: targetStoreId,
      },
      {
        onSuccess: (account) => {
          toast.success("Referrer account opened", {
            description: `${account.referrerName} earns ${REFERRAL_COMMISSION_PCT}% credit on every referred purchase.`,
          });
          reset();
          onOpenChange(false);
        },
        onError: (err) =>
          toast.error(apiErrorMessage(err, "Could not open the referrer account.")),
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
            <UserRound className="h-4 w-4 text-gold-strong" />
            New referrer account
          </DialogTitle>
          <DialogDescription>
            Choose an existing customer. They earn {REFERRAL_COMMISSION_PCT}%
            credit on every purchase they refer, collected in their wallet.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <StoreScopeField value={pickedStoreId} onChange={setPickedStoreId} />

          <div className="grid gap-1.5">
            <Label htmlFor="ra-search">
              Customer <span className="text-destructive">*</span>
            </Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="ra-search"
                className="pl-8"
                placeholder="Search by name or phone"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            {parties.isLoading ? (
              <div className="space-y-1.5 pt-1">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-9 w-full" />
                ))}
              </div>
            ) : (parties.data?.items ?? []).length === 0 ? (
              <p className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                No customer matches that. Add them on the Customers page first.
              </p>
            ) : (
              <ul className="max-h-56 space-y-1 overflow-y-auto rounded-lg border p-1">
                {parties.data!.items.map((p) => {
                  const isSelected = selected?.id === p.id;
                  return (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => setSelected(p)}
                        className={cn(
                          "flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted",
                          isSelected && "bg-muted",
                        )}
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-medium">
                            {p.name}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {p.phone ?? "No phone on file"}
                          </span>
                        </span>
                        {isSelected ? (
                          <Check className="h-4 w-4 shrink-0 text-success" />
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="gold"
            onClick={submit}
            disabled={createAccount.isPending || !selected}
          >
            {createAccount.isPending ? "Opening…" : "Open account"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
