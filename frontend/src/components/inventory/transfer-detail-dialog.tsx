"use client";

import * as React from "react";
import { ArrowRight } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  availableActions,
  useStockTransfer,
  useTransferAction,
  TRANSFER_STATUS_LABELS,
  type ActionMeta,
  type StockTransfer,
  type TransferActor,
} from "@/lib/queries/stock-transfers";
import { useSession } from "@/store/use-session";
import { apiErrorMessage, cn } from "@/lib/utils";
import { STATUS_VARIANT } from "@/app/(app)/stock-transfers/status-variant";

interface TransferDetailDialogProps {
  transferId: string | null;
  onOpenChange: (open: boolean) => void;
}

function fmtDateTime(s: string | null | undefined): string | null {
  if (!s) return null;
  return new Date(s).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface Stage {
  label: string;
  actor: TransferActor | null;
  at: string | null;
}

/** Build the ordered lifecycle stages that have happened, for the timeline. */
function stagesFor(t: StockTransfer): Stage[] {
  return [
    { label: "Created", actor: t.requestedBy, at: t.createdAt },
    { label: "Submitted to HO", actor: t.requestedBy, at: t.submittedAt },
    { label: "HO approved", actor: t.approvedBy, at: t.approvedAt },
    { label: "Dispatched", actor: t.dispatchedBy, at: t.dispatchedAt },
    { label: "Received", actor: t.receivedBy, at: t.receivedAt },
    { label: "Acknowledged", actor: t.acknowledgedBy, at: t.acknowledgedAt },
  ];
}

export function TransferDetailDialog({
  transferId,
  onOpenChange,
}: TransferDetailDialogProps) {
  const { role, stores } = useSession();
  const { data: t, isLoading, isError } = useStockTransfer(transferId);
  const action = useTransferAction();

  // Reason prompt (reject / cancel).
  const [reasonFor, setReasonFor] = React.useState<ActionMeta | null>(null);
  const [reason, setReason] = React.useState("");

  const operatedStoreIds = React.useMemo(
    () => new Set(stores.filter((s) => !s.isAggregate).map((s) => s.id)),
    [stores],
  );

  const actions = t ? availableActions(t, role, operatedStoreIds) : [];

  function run(meta: ActionMeta, note?: string) {
    if (!t) return;
    action.mutate(
      { id: t.id, action: meta.action, reason: note },
      {
        onSuccess: () => {
          toast.success(`Transfer ${meta.label.toLowerCase()} done`);
          setReasonFor(null);
          setReason("");
        },
        onError: (err) =>
          // 409 (concurrent action) / 403 (not permitted) surface here; the
          // mutation's onSettled has already refetched the true state.
          toast.error(apiErrorMessage(err, "Could not complete that action.")),
      },
    );
  }

  function onAction(meta: ActionMeta) {
    if (meta.needsReason) {
      setReason("");
      setReasonFor(meta);
    } else {
      run(meta);
    }
  }

  const open = transferId != null;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          {isLoading ? (
            <div className="space-y-3 py-2">
              <Skeleton className="h-6 w-48" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : isError || !t ? (
            <>
              <DialogHeader>
                <DialogTitle>Transfer</DialogTitle>
              </DialogHeader>
              <p className="py-6 text-center text-sm text-muted-foreground">
                Couldn&apos;t load this transfer.
              </p>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-3">
                  <span className="num">{t.ref}</span>
                  <Badge variant={STATUS_VARIANT[t.status]}>
                    {TRANSFER_STATUS_LABELS[t.status]}
                  </Badge>
                </DialogTitle>
                <DialogDescription className="flex items-center gap-1.5 pt-1">
                  <span className="font-medium text-foreground">
                    {t.fromStoreName}
                  </span>
                  <ArrowRight className="h-3.5 w-3.5" />
                  <span className="font-medium text-foreground">
                    {t.toStoreName}
                  </span>
                  <span>· {t.itemCount} piece{t.itemCount === 1 ? "" : "s"}</span>
                </DialogDescription>
              </DialogHeader>

              {/* Rejection / cancellation reason. */}
              {t.reason &&
              (t.status === "rejected" || t.status === "cancelled") ? (
                <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
                  <span className="font-medium">
                    {t.status === "rejected" ? "Rejected" : "Cancelled"}:
                  </span>{" "}
                  {t.reason}
                </p>
              ) : null}

              {/* Pieces. */}
              <div>
                <p className="mb-2 text-sm font-medium">Pieces</p>
                <div className="rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>SKU</TableHead>
                        <TableHead>Name</TableHead>
                        <TableHead>Current status</TableHead>
                        <TableHead>Location</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {t.items.map((it) => (
                        <TableRow key={it.stockItemId}>
                          <TableCell className="font-medium">{it.sku}</TableCell>
                          <TableCell className="max-w-[220px] truncate">
                            {it.name}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">{it.currentStatus}</Badge>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {it.currentStoreId === t.fromStoreId
                              ? t.fromStoreName
                              : it.currentStoreId === t.toStoreId
                                ? t.toStoreName
                                : it.currentStoreId}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>

              {/* Timeline. */}
              <div>
                <p className="mb-2 text-sm font-medium">Status timeline</p>
                <ol className="space-y-3">
                  {stagesFor(t).map((stage, i) => {
                    const done = !!stage.at;
                    return (
                      <li key={i} className="flex gap-3">
                        <span
                          className={cn(
                            "mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full",
                            done ? "bg-[var(--gold)]" : "bg-muted",
                          )}
                        />
                        <div className="text-sm">
                          <span
                            className={cn(
                              "font-medium",
                              !done && "text-muted-foreground",
                            )}
                          >
                            {stage.label}
                          </span>
                          {done ? (
                            <span className="text-muted-foreground">
                              {stage.actor
                                ? ` · ${stage.actor.name} (${stage.actor.roleLabel})`
                                : ""}
                              {" · "}
                              {fmtDateTime(stage.at)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground"> · pending</span>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </div>

              <DialogFooter className="gap-2">
                {actions.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No actions available to you at this stage.
                  </p>
                ) : (
                  actions.map((meta) => (
                    <Button
                      key={meta.action}
                      variant={meta.variant}
                      className={
                        meta.action === "reject"
                          ? "text-destructive hover:text-destructive"
                          : undefined
                      }
                      disabled={action.isPending}
                      onClick={() => onAction(meta)}
                    >
                      {meta.label}
                    </Button>
                  ))
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Reason prompt for reject / cancel. */}
      <Dialog
        open={reasonFor != null}
        onOpenChange={(o) => {
          if (!o) {
            setReasonFor(null);
            setReason("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {reasonFor?.action === "reject"
                ? "Reject transfer"
                : "Cancel transfer"}
            </DialogTitle>
            <DialogDescription>
              Add an optional reason — it is recorded on the transfer.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="tr-reason">Reason</Label>
            <Textarea
              id="tr-reason"
              placeholder={
                reasonFor?.action === "reject"
                  ? "e.g. Pieces needed at the source store this week."
                  : "e.g. Requested in error."
              }
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setReasonFor(null);
                setReason("");
              }}
            >
              Back
            </Button>
            <Button
              variant="destructive"
              disabled={action.isPending}
              onClick={() =>
                reasonFor && run(reasonFor, reason.trim() || undefined)
              }
            >
              {action.isPending
                ? "Working…"
                : reasonFor?.action === "reject"
                  ? "Reject transfer"
                  : "Cancel transfer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
