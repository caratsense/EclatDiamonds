"use client";

import { useState } from "react";
import { CalendarClock, Gem, Package, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { OrderStepper } from "@/components/timelines/order-stepper";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { assetUrl } from "@/lib/api";
import { formatINR } from "@/lib/format";
import {
  ADVANCE_MODE_LABELS,
  ORDER_CATEGORY_LABELS,
  ORDER_STAGES,
  STOCK_ORDER_SLA_DAYS,
  TIMELINE_ROLE_LABELS,
  type AdvanceMode,
  type CustomOrder,
  type OrderCategory,
  type TimelineRole,
} from "@/lib/mock/timelines";
import {
  ORDER_STATUS_LABELS,
  ORDER_STATUS_SEQUENCE,
  TERMINAL_ORDER_STATUSES,
  useAdvanceOrderStage,
  useOrderDetail,
  type OrderStatus,
} from "@/lib/queries/timelines";
import { ROLE_RANK } from "@/lib/types";
import { useSession } from "@/store/use-session";
import { apiErrorMessage } from "@/lib/utils";

function prettyDate(iso: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function roleLabel(role: string): string {
  return TIMELINE_ROLE_LABELS[role as TimelineRole] ?? role;
}

function categoryLabel(category?: OrderCategory): string | null {
  return category ? ORDER_CATEGORY_LABELS[category] : null;
}

function advanceModeLabel(mode?: string | null): string | null {
  if (!mode) return null;
  return ADVANCE_MODE_LABELS[mode as AdvanceMode] ?? mode;
}

interface OrderDetailDialogProps {
  /** The list row to open — used for instant render before events load. */
  order: CustomOrder | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Full order view — reference image, every booked field, the production
 * stepper and the event history (fetched via GET /timelines/orders/:id).
 * Renders the list row immediately and enriches it with events once loaded.
 */
export function OrderDetailDialog({
  order,
  open,
  onOpenChange,
}: OrderDetailDialogProps) {
  const { data: detail, isLoading } = useOrderDetail(
    open ? (order?.id ?? null) : null,
  );
  const role = useSession((s) => s.role);
  const advanceStage = useAdvanceOrderStage();
  const [stageSel, setStageSel] = useState("");
  const [stageNote, setStageNote] = useState("");
  const [deliveredTo, setDeliveredTo] = useState("");

  // Reset the stage form whenever a different order opens. Adjusted during
  // render (React's documented "state derived from props" pattern) rather than
  // in an effect — an effect would paint the previous order's half-filled
  // cancellation reason for a frame before clearing it.
  const formKey = `${order?.id ?? ""}:${open}`;
  const [lastFormKey, setLastFormKey] = useState(formKey);
  if (lastFormKey !== formKey) {
    setLastFormKey(formKey);
    setStageSel("");
    setStageNote("");
    setDeliveredTo("");
  }

  if (!order) return null;

  // Prefer freshly fetched detail; fall back to the list row for instant paint.
  const o = detail ?? order;
  const events = detail?.events ?? [];
  const isStock = o.kind === "stock";
  const src = assetUrl(o.imageUrl);
  const receiptSrc = assetUrl(o.advanceReceiptUrl);
  const advMode = advanceModeLabel(o.advanceMode);
  const cat = categoryLabel(o.category);
  const hasMoney = o.estimation !== undefined || o.advanceReceived !== undefined;
  const balance =
    o.estimation !== undefined
      ? Math.max(o.estimation - (o.advanceReceived ?? 0), 0)
      : undefined;

  // The server's production state machine decides where an order may go next.
  // Offering the whole remaining enum (as this used to) surfaces moves the API
  // rejects — skipping QC, or dropping a `ready` piece back to `designing` —
  // which reads to the user as a broken button rather than a rule.
  const currentStage =
    (detail?.stage as OrderStatus | undefined) ??
    (events[events.length - 1]?.stage as OrderStatus) ??
    null;
  const isTerminal = currentStage
    ? TERMINAL_ORDER_STATUSES.includes(currentStage)
    : false;
  // Fall back to the linear path only while the detail fetch is in flight.
  const allowed =
    detail?.allowedNextStages ??
    (currentStage && !isTerminal
      ? ORDER_STATUS_SEQUENCE.slice(
          ORDER_STATUS_SEQUENCE.indexOf(currentStage) + 1,
          ORDER_STATUS_SEQUENCE.indexOf(currentStage) + 2,
        ).map((s) => ({ stage: s, label: ORDER_STATUS_LABELS[s] }))
      : []);
  // store_manager and above manage production. The area-manager tier has been
  // folded into store_manager (2026-08), so both see these controls; the server
  // enforces every rule and returns a message naming the required role, which the
  // error toast surfaces verbatim.
  const showAdvance =
    ROLE_RANK[role] >= ROLE_RANK.store_manager &&
    !!currentStage &&
    !isTerminal &&
    allowed.length > 0;

  const needsReason = stageSel === "cancelled";
  const needsRecipient = stageSel === "delivered";
  const canSubmit =
    !!stageSel &&
    (!needsReason || !!stageNote.trim()) &&
    (!needsRecipient || !!deliveredTo.trim());

  function submitStage() {
    if (!stageSel) {
      toast.error("Select a stage to move to.");
      return;
    }
    if (needsReason && !stageNote.trim()) {
      toast.error("A reason is required to cancel an order.");
      return;
    }
    if (needsRecipient && !deliveredTo.trim()) {
      toast.error("Record who collected the piece.");
      return;
    }
    advanceStage.mutate(
      {
        id: o.id,
        stage: stageSel as OrderStatus,
        note: stageNote.trim() || undefined,
        deliveredTo: deliveredTo.trim() || undefined,
      },
      {
        onSuccess: () => {
          toast.success(
            stageSel === "cancelled"
              ? `Order ${o.ref} cancelled`
              : `Order moved to ${ORDER_STATUS_LABELS[stageSel as OrderStatus]}`,
          );
          setStageSel("");
          setStageNote("");
          setDeliveredTo("");
        },
        onError: (err: unknown) =>
          toast.error(apiErrorMessage(err, "Could not move the order stage.")),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {o.ref} · {o.item || "Order"}
            <Badge variant={isStock ? "secondary" : "gold"}>
              {isStock ? (
                <>
                  <Package className="mr-1 h-3 w-3" /> Stock
                </>
              ) : (
                <>
                  <Sparkles className="mr-1 h-3 w-3" /> Custom
                </>
              )}
            </Badge>
          </DialogTitle>
          <DialogDescription>
            {o.customer} · {o.storeName}
            {cat ? ` · ${cat}` : ""}
          </DialogDescription>
        </DialogHeader>

        {/* Reference image */}
        <div className="flex aspect-[16/9] items-center justify-center overflow-hidden rounded-lg bg-muted">
          {src ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={src}
              alt={`Reference for ${o.item || o.ref}`}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex flex-col items-center gap-1 text-muted-foreground/40">
              <Gem className="h-10 w-10" />
              <span className="text-xs">No reference image</span>
            </div>
          )}
        </div>

        {/* Status + stepper */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm text-muted-foreground">
            Stage:{" "}
            {o.stageLabel ?? ORDER_STAGES[o.currentStageIndex] ?? "Cancelled"}
            {o.daysInStage != null ? (
              <span className="num"> · {o.daysInStage}d in stage</span>
            ) : null}
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            {/* Stage overrun is separate from ETA delay: a piece can be inside
                its promised date and still be stuck at one bench, which is the
                point at which stepping in still changes the outcome. */}
            {o.stageOverdue ? (
              <Badge variant="warning">
                Stuck in stage{o.stageSlaDays ? ` (>${o.stageSlaDays}d)` : ""}
              </Badge>
            ) : null}
            {o.delayed ? (
              <Badge variant="destructive">Delayed</Badge>
            ) : isTerminal ? (
              <Badge variant="secondary">
                {currentStage === "cancelled" ? "Cancelled" : "Delivered"}
              </Badge>
            ) : (
              <Badge variant="success">On track</Badge>
            )}
          </div>
        </div>
        {o.cancelReason ? (
          <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs">
            <span className="font-medium">Cancelled:</span> {o.cancelReason}
          </p>
        ) : null}
        {o.deliveredTo ? (
          <p className="rounded-lg border bg-muted/30 p-2 text-xs">
            <span className="font-medium">Collected by:</span> {o.deliveredTo}
            {o.deliveredAt ? ` · ${prettyDate(o.deliveredAt)}` : ""}
          </p>
        ) : null}
        <OrderStepper
          currentStageIndex={o.currentStageIndex}
          delayed={o.delayed}
        />

        <Separator />

        {/* Fields */}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          {cat ? <Field label="Category">{cat}</Field> : null}
          <Field label="Quantity">
            <span className="num">{o.qty ?? 1}</span>
          </Field>
          <Field label="Order placed">
            <span className="num">{prettyDate(o.bookedOn)}</span>
          </Field>
          <Field label="Estimated delivery">
            <span
              className={
                o.delayed ? "num font-medium text-destructive" : "num"
              }
            >
              {prettyDate(o.eta)}
            </span>
            {isStock ? (
              <Badge variant="outline" className="ml-1.5 text-[10px]">
                {STOCK_ORDER_SLA_DAYS}-day SLA
              </Badge>
            ) : null}
          </Field>
          {o.deliveryDate ? (
            <Field label="Promised delivery">
              <span className="num">{prettyDate(o.deliveryDate)}</span>
            </Field>
          ) : null}
          {o.ringSize ? (
            <Field label="Ring size">
              <span className="num">{o.ringSize}</span>
            </Field>
          ) : null}
          {o.bangleSize ? (
            <Field label="Bangle size">
              <span className="num">{o.bangleSize}</span>
            </Field>
          ) : null}
          {o.metalColor ? (
            <Field label="Metal colour">{o.metalColor}</Field>
          ) : null}
          {hasMoney ? (
            <>
              <Field label="Estimate / quote">
                <span className="num">
                  {o.estimation !== undefined ? formatINR(o.estimation) : "—"}
                </span>
              </Field>
              <Field label="Advance received">
                <span className="num">
                  {o.advanceReceived !== undefined
                    ? formatINR(o.advanceReceived)
                    : "—"}
                </span>
                {advMode ? (
                  <Badge variant="outline" className="ml-1.5 text-[10px]">
                    {advMode}
                  </Badge>
                ) : null}
              </Field>
              {balance !== undefined ? (
                <Field label="Balance due">
                  <span className="num font-medium">{formatINR(balance)}</span>
                </Field>
              ) : null}
            </>
          ) : null}
          <Field label="Currently held by">
            {o.ownerName || roleLabel(o.ownerRole)}
          </Field>
        </dl>

        {receiptSrc ? (
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">
              Advance receipt
            </p>
            <a
              href={receiptSrc}
              target="_blank"
              rel="noreferrer"
              className="block overflow-hidden rounded-lg border bg-muted/30"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={receiptSrc}
                alt={`Advance receipt for ${o.ref}`}
                className="max-h-56 w-full object-contain"
              />
            </a>
          </div>
        ) : null}

        {o.details ? (
          <div className="rounded-lg border bg-muted/30 p-3">
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              Details
            </p>
            <p className="text-sm">{o.details}</p>
          </div>
        ) : null}

        {/* Advance stage — store_manager+ moves the order to the next stage */}
        {showAdvance ? (
          <div className="rounded-lg border bg-muted/20 p-3">
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              Move stage
            </p>
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="advance-stage">Move to stage</Label>
                <Select value={stageSel} onValueChange={setStageSel}>
                  <SelectTrigger id="advance-stage">
                    <SelectValue placeholder="Select the next stage" />
                  </SelectTrigger>
                  <SelectContent>
                    {allowed.map((s) => (
                      <SelectItem key={s.stage} value={s.stage}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Only the moves that follow{" "}
                  {currentStage ? ORDER_STATUS_LABELS[currentStage] : "this stage"}{" "}
                  on the shop floor are offered.
                </p>
              </div>
              {needsRecipient ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="delivered-to">Collected by</Label>
                  <Input
                    id="delivered-to"
                    placeholder="Name of whoever took the piece"
                    value={deliveredTo}
                    onChange={(e) => setDeliveredTo(e.target.value)}
                  />
                  {balance !== undefined && balance > 0 ? (
                    <p className="text-xs text-warning">
                      {formatINR(balance)} is still outstanding on this order.
                    </p>
                  ) : null}
                </div>
              ) : null}
              <div className="grid gap-1.5">
                <Label htmlFor="advance-note">
                  {needsReason ? "Reason for cancelling" : "Note (optional)"}
                </Label>
                <Textarea
                  id="advance-note"
                  placeholder={
                    needsReason
                      ? "e.g. Customer changed their mind — advance refunded via UPI"
                      : "e.g. Casting complete, moved to setting bench 3"
                  }
                  value={stageNote}
                  onChange={(e) => setStageNote(e.target.value)}
                />
              </div>
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant={needsReason ? "destructive" : "default"}
                  onClick={submitStage}
                  disabled={!canSubmit || advanceStage.isPending}
                >
                  {advanceStage.isPending
                    ? "Updating…"
                    : needsReason
                      ? "Cancel order"
                      : "Move stage"}
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        {/* Event history */}
        <div>
          <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <CalendarClock className="h-3.5 w-3.5" />
            Production timeline
          </p>
          {isLoading && events.length === 0 ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : events.length === 0 ? (
            <p className="rounded-lg border border-dashed py-4 text-center text-xs text-muted-foreground">
              No stage updates recorded yet.
            </p>
          ) : (
            <ol className="space-y-3">
              {events.map((ev) => (
                <li key={ev.id} className="flex gap-3">
                  <div className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                      <span className="text-sm font-medium">
                        {ev.stageLabel ?? ev.stage}
                      </span>
                      <span className="num text-xs text-muted-foreground">
                        {prettyDate(ev.at)}
                        {/* Time spent AT this stage — what turns the history
                            into something that shows where the piece stalls. */}
                        {ev.durationDays != null
                          ? ` · ${ev.durationDays}d${ev.isCurrent ? " so far" : ""}`
                          : ""}
                      </span>
                    </div>
                    {ev.note ? (
                      <p className="text-xs text-muted-foreground">{ev.note}</p>
                    ) : null}
                    <p className="text-[11px] text-muted-foreground">
                      {ev.byName || roleLabel(ev.byRole)}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}
