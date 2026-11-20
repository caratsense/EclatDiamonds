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
import { useCreatePull, usePullableStock } from "@/lib/queries/stock-transfers";
import { useSignupStores } from "@/lib/queries/auth";
import { useConfigBootstrap } from "@/lib/queries/tenant-config";
import { useSession } from "@/store/use-session";
import { formatGrams } from "@/lib/format";
import { apiErrorMessage, cn } from "@/lib/utils";

interface RequestPieceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Module 9 — ask ANOTHER branch for a piece (creates a DRAFT pull).
 *
 * The mirror of CreateTransferDialog, and kept separate from it on purpose:
 * there, the pieces come from your own stock list and you choose where to send
 * them; here, you choose a branch and the pieces come from a shelf you cannot
 * otherwise see. Folding both into one dialog would mean a source picker that
 * means two different things depending on a toggle.
 *
 * What that shelf shows is narrow by design — SKU, design, weight and that it
 * is available, no prices (see backend pullable-stock.ts). The screen shows
 * exactly those columns so it never promises a number the API will not send.
 */
export function RequestPieceDialog({
  open,
  onOpenChange,
}: RequestPieceDialogProps) {
  // The branch the piece is being asked FOR — the counter the customer is at.
  const { targetStoreId: toStoreId, storeLabel, pickedStoreId, setPickedStoreId } =
    useStoreScope();
  const create = useCreatePull();
  const organisationSlug = useConfigBootstrap().data?.organisation.slug ?? "";
  const { data: directory } = useSignupStores(organisationSlug);
  const { stores } = useSession();

  const [fromStoreId, setFromStoreId] = React.useState("");
  const [q, setQ] = React.useState("");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [note, setNote] = React.useState("");

  // Every branch of this tenant EXCEPT the ones this person runs: their stock is
  // already on their own stock screen, and the API refuses a branch of your own.
  // Every branch the person runs, not just the one selected above — a manager
  // of two branches moves pieces between them with an ordinary transfer.
  const ownStoreIds = React.useMemo(
    () => new Set(stores.filter((s) => !s.isAggregate).map((s) => s.id)),
    [stores],
  );
  const sources = organisationSlug
    ? (directory ?? []).filter((s) => !ownStoreIds.has(s.id))
    : [];
  const fromStore = sources.some((s) => s.id === fromStoreId) ? fromStoreId : "";

  const { data: pieces = [], isLoading, isError } = usePullableStock(fromStore, q);

  function reset() {
    setFromStoreId("");
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
    if (!toStoreId) {
      toast.error("Select the branch the piece is needed at.");
      return;
    }
    if (!fromStore) {
      toast.error("Select the branch to ask.");
      return;
    }
    if (selected.size === 0) {
      toast.error("Select at least one piece to ask for.");
      return;
    }
    create.mutate(
      {
        fromStoreId: fromStore,
        toStoreId,
        stockItemIds: [...selected],
        note: note.trim() || undefined,
      },
      {
        onSuccess: (rec) => {
          toast.success(`Draft request ${rec.ref} created`, {
            description: "Open it to send the request to that branch.",
          });
          reset();
          onOpenChange(false);
        },
        onError: (err) =>
          toast.error(apiErrorMessage(err, "Could not create the request.")),
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
          <DialogTitle>Ask another branch for a piece</DialogTitle>
          <DialogDescription>
            For{" "}
            <span className="font-medium text-foreground">{storeLabel}</span>.
            That branch&apos;s manager accepts or declines; if they accept it
            goes to Head Office like any other transfer.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          {/* Where the piece is needed — only pickable on the aggregate scope. */}
          <StoreScopeField
            value={pickedStoreId}
            onChange={setPickedStoreId}
            label="Needed at"
          />

          <div className="grid gap-1.5">
            <Label htmlFor="pull-source">
              Branch to ask <span className="text-destructive">*</span>
            </Label>
            <Select value={fromStore} onValueChange={setFromStoreId}>
              <SelectTrigger id="pull-source" aria-invalid={!fromStore}>
                <SelectValue placeholder="Select a branch…" />
              </SelectTrigger>
              <SelectContent>
                {sources.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Piece picker — that branch's available stock, nothing else. */}
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
                placeholder="Search SKU, design or piece number…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="pl-8"
                disabled={!fromStore}
              />
            </div>

            <div className="max-h-64 overflow-y-auto rounded-lg border">
              {!fromStore ? (
                <p className="p-4 text-center text-sm text-muted-foreground">
                  Choose a branch to see what they have available.
                </p>
              ) : isLoading ? (
                <div className="space-y-2 p-2">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-10 w-full" />
                  ))}
                </div>
              ) : isError ? (
                <p className="p-4 text-center text-sm text-muted-foreground">
                  Couldn&apos;t load that branch&apos;s stock.
                </p>
              ) : pieces.length === 0 ? (
                <p className="p-4 text-center text-sm text-muted-foreground">
                  Nothing available there{q.trim() ? " for that search" : ""}.
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
                              {p.styleNumber ? ` · ${p.styleNumber}` : ""}
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
            <Label htmlFor="pull-note">Why you need it</Label>
            <Textarea
              id="pull-note"
              placeholder="e.g. Customer at the counter wants this in 18k — asking for it today."
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
