"use client";

import * as React from "react";
import { Check, Search } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
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
import { Skeleton } from "@/components/ui/skeleton";
import {
  StoreScopeField,
  useStoreScope,
} from "@/components/common/store-scope-field";
import { useStock } from "@/lib/queries/stock";
import { useCreateTransfer } from "@/lib/queries/stock-transfers";
import { useSignupStores, type SignupStore } from "@/lib/queries/auth";
import { useConfigBootstrap } from "@/lib/queries/tenant-config";
import { formatGrams } from "@/lib/format";
import { apiErrorMessage, cn } from "@/lib/utils";

/** Humanized stock statuses that are transferable (available, in-ledger). */
const AVAILABLE_STATUSES = new Set(["In stock", "Aging", "Dead stock"]);

/**
 * The branches this transfer may be sent to.
 *
 * Two gates. Without a resolved tenant there are no destinations at all — the
 * directory used to fall back to a fixed organisation, which listed one
 * jeweller's branches to every other tenant. And the source store cannot also be
 * the destination. `directory` is undefined while the list for the current
 * tenant loads (the query is keyed by slug), which is what keeps a previous
 * tenant's branches out of the picker rather than merely re-sorting them.
 */
export function transferDestinations(
  directory: SignupStore[] | undefined,
  organisationSlug: string,
  sourceStoreId: string,
): SignupStore[] {
  if (!organisationSlug) return [];
  return (directory ?? []).filter((s) => s.id !== sourceStoreId);
}

interface CreateTransferDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Prefill the piece selection (Bulk Transfer from the stock table). */
  initialStockItemIds?: string[];
  /** Prefill the source store (only takes effect on the "All Stores" scope). */
  initialSourceStoreId?: string;
}

/**
 * Module 9 — raise an inter-store transfer (creates a DRAFT).
 *
 * Source is the store the user operates (their active store, or a picked one on
 * the aggregate). Destination is any other branch. Pieces are chosen from the
 * live stock at the source via GET /stock scoped to that store; only available
 * (in_stock/aging/dead_stock) pieces are transferable. The backend re-validates
 * every id, so this list is a convenience, not the source of truth.
 */
export function CreateTransferDialog({
  open,
  onOpenChange,
  initialStockItemIds,
  initialSourceStoreId,
}: CreateTransferDialogProps) {
  // Bulk Transfer prefills the source store + selection; the parent remounts
  // this dialog via `key`, so these lazy initial values run fresh each open.
  const { targetStoreId: sourceStoreId, storeLabel, pickedStoreId, setPickedStoreId } =
    useStoreScope(initialSourceStoreId);
  const create = useCreateTransfer();
  // Which tenant's branches to offer, taken from the authenticated bootstrap the
  // app shell has already loaded — not the hostname, not local storage, and not
  // a second copy of the tenant kept here. Empty until it resolves.
  const organisationSlug =
    useConfigBootstrap().data?.organisation.slug ?? "";
  const { data: directory } = useSignupStores(organisationSlug);

  const [toStoreId, setToStoreId] = React.useState("");
  const [q, setQ] = React.useState("");
  const [selected, setSelected] = React.useState<Set<string>>(
    () => new Set(initialStockItemIds ?? []),
  );
  const [note, setNote] = React.useState("");

  const { data, isLoading, isError } = useStock({
    page: 1,
    pageSize: 50,
    q: q.trim() || undefined,
    storeId: sourceStoreId || undefined,
  });

  const pieces = (data?.items ?? []).filter((p) =>
    AVAILABLE_STATUSES.has(p.status),
  );

  // Destination cannot be the source store, and belongs to the signed-in tenant.
  const destinations = transferDestinations(
    directory,
    organisationSlug,
    sourceStoreId,
  );
  // A branch picked before the tenant resolved — or under a previous one — is no
  // longer on offer, so it must not stay selected or be submitted.
  const toStore = destinations.some((s) => s.id === toStoreId) ? toStoreId : "";

  function reset() {
    setToStoreId("");
    setQ("");
    setSelected(new Set());
    setNote("");
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function submit() {
    if (!sourceStoreId) {
      toast.error("Select the source store to transfer from.");
      return;
    }
    if (!toStore) {
      toast.error("Select a destination store.");
      return;
    }
    if (selected.size === 0) {
      toast.error("Select at least one piece to transfer.");
      return;
    }
    create.mutate(
      {
        fromStoreId: sourceStoreId,
        toStoreId: toStore,
        stockItemIds: [...selected],
        note: note.trim() || undefined,
      },
      {
        onSuccess: (rec) => {
          toast.success(`Draft transfer ${rec.ref} created`, {
            description: "Open it to submit for Head-Office approval.",
          });
          reset();
          onOpenChange(false);
        },
        onError: (err) =>
          toast.error(apiErrorMessage(err, "Could not create the transfer.")),
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
          <DialogTitle>New stock transfer</DialogTitle>
          <DialogDescription>
            From <span className="font-medium text-foreground">{storeLabel}</span>{" "}
            to another branch. Creates a draft you then submit for Head-Office
            approval.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          {/* Source — only shown to pick on the aggregate scope. */}
          <StoreScopeField
            value={pickedStoreId}
            onChange={setPickedStoreId}
            label="Source store"
          />

          <div className="grid gap-1.5">
            <Label htmlFor="tr-dest">
              Destination store <span className="text-destructive">*</span>
            </Label>
            <Select value={toStore} onValueChange={setToStoreId}>
              <SelectTrigger id="tr-dest" aria-invalid={!toStore}>
                <SelectValue placeholder="Select a branch…" />
              </SelectTrigger>
              <SelectContent>
                {destinations.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Piece picker. */}
          <div className="grid gap-1.5">
            <Label>
              Pieces <span className="text-destructive">*</span>
              {selected.size > 0 ? (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {selected.size} selected
                </span>
              ) : null}
            </Label>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search SKU or name…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="pl-8"
              />
            </div>

            <div className="max-h-64 overflow-y-auto rounded-lg border">
              {isLoading ? (
                <div className="space-y-2 p-2">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-10 w-full" />
                  ))}
                </div>
              ) : isError ? (
                <p className="p-4 text-center text-sm text-muted-foreground">
                  Couldn&apos;t load stock for this store.
                </p>
              ) : pieces.length === 0 ? (
                <p className="p-4 text-center text-sm text-muted-foreground">
                  No available pieces at the source store.
                </p>
              ) : (
                <ul className="divide-y">
                  {pieces.map((p) => {
                    const on = selected.has(p.id);
                    return (
                      <li key={p.id}>
                        <button
                          type="button"
                          onClick={() => toggle(p.id)}
                          aria-pressed={on}
                          className={cn(
                            "flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/50",
                            on && "bg-[color-mix(in_srgb,var(--gold)_10%,transparent)]",
                          )}
                        >
                          <span
                            className={cn(
                              "flex h-5 w-5 shrink-0 items-center justify-center rounded border",
                              on
                                ? "border-transparent bg-[var(--gold)] text-white"
                                : "border-border",
                            )}
                          >
                            {on ? <Check className="h-3.5 w-3.5" /> : null}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">
                              {p.sku}
                            </span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {p.name} · {formatGrams(p.grossGrams)}
                            </span>
                          </span>
                          <Badge variant="outline" className="shrink-0">
                            {p.status}
                          </Badge>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="tr-note">Note</Label>
            <Textarea
              id="tr-note"
              placeholder="Optional context for the approver / receiving store."
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="gold" onClick={submit} disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Create draft"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
