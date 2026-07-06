"use client";

import { CalendarClock, Gem, Package, Sparkles } from "lucide-react";

import { OrderStepper } from "@/components/timelines/order-stepper";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { assetUrl } from "@/lib/api";
import { formatINR } from "@/lib/format";
import {
  ORDER_CATEGORY_LABELS,
  ORDER_STAGES,
  STOCK_ORDER_SLA_DAYS,
  TIMELINE_ROLE_LABELS,
  type CustomOrder,
  type OrderCategory,
  type TimelineRole,
} from "@/lib/mock/timelines";
import { useOrderDetail } from "@/lib/queries/timelines";

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

  if (!order) return null;

  // Prefer freshly fetched detail; fall back to the list row for instant paint.
  const o = detail ?? order;
  const events = detail?.events ?? [];
  const isStock = o.kind === "stock";
  const src = assetUrl(o.imageUrl);
  const cat = categoryLabel(o.category);
  const hasMoney = o.estimation !== undefined || o.advanceReceived !== undefined;
  const balance =
    o.estimation !== undefined
      ? Math.max(o.estimation - (o.advanceReceived ?? 0), 0)
      : undefined;

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
        <div className="flex aspect-[16/9] items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br from-amber-50 to-amber-100 dark:from-amber-950/40 dark:to-amber-900/20">
          {src ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={src}
              alt={`Reference for ${o.item || o.ref}`}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex flex-col items-center gap-1 text-amber-400/70">
              <Gem className="h-10 w-10" />
              <span className="text-xs">No reference image</span>
            </div>
          )}
        </div>

        {/* Status + stepper */}
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">
            Stage: {ORDER_STAGES[o.currentStageIndex]}
          </span>
          {o.delayed ? (
            <Badge variant="destructive">Delayed</Badge>
          ) : (
            <Badge variant="success">On track</Badge>
          )}
        </div>
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

        {o.details ? (
          <div className="rounded-lg border bg-muted/30 p-3">
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              Details
            </p>
            <p className="text-sm">{o.details}</p>
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
                      <span className="text-sm font-medium">{ev.stage}</span>
                      <span className="num text-xs text-muted-foreground">
                        {prettyDate(ev.at)}
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
