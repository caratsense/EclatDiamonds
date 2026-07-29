"use client";

import { useMemo, useState } from "react";
import {
  CalendarClock,
  Factory,
  Gem,
  Package,
  Plus,
  Sparkles,
  Truck,
} from "lucide-react";

import { OrderBookingDialog } from "@/components/timelines/order-booking-dialog";
import { OrderDetailDialog } from "@/components/timelines/order-detail-dialog";
import { OrderStepper } from "@/components/timelines/order-stepper";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { assetUrl } from "@/lib/api";
import { formatGrams, formatINR } from "@/lib/format";
import {
  ORDER_CATEGORY_LABELS,
  ORDER_STAGES,
  TIMELINE_ROLE_LABELS,
  type CustomOrder,
  type OrderCategory,
  type ReplenishmentStatus,
  type TimelineRole,
} from "@/lib/mock/timelines";
import {
  useOrders,
  useReplenishment,
  type OrderKindFilter,
} from "@/lib/queries/timelines";

function formatDay(iso: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
  });
}

/** Backend ownerRole may fall outside the known label set — render gracefully. */
function roleLabel(role: string): string {
  return TIMELINE_ROLE_LABELS[role as TimelineRole] ?? role;
}

function categoryLabel(category?: OrderCategory): string | null {
  return category ? ORDER_CATEGORY_LABELS[category] : null;
}

const REPLEN_VARIANT: Record<
  ReplenishmentStatus,
  "secondary" | "default" | "success" | "outline"
> = {
  Requested: "outline",
  Dispatched: "secondary",
  "In transit": "default",
  Received: "success",
};

/** Custom vs stock badge used across the card and table. */
function KindBadge({ kind }: { kind: CustomOrder["kind"] }) {
  return kind === "stock" ? (
    <Badge variant="secondary">
      <Package className="mr-1 h-3 w-3" /> Stock
    </Badge>
  ) : (
    <Badge variant="gold">
      <Sparkles className="mr-1 h-3 w-3" /> Custom
    </Badge>
  );
}

/** Small reference-image thumbnail with a gem-glyph fallback. */
function OrderThumb({ order }: { order: CustomOrder }) {
  const src = assetUrl(order.imageUrl);
  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={order.item || order.ref}
          className="h-full w-full object-cover"
        />
      ) : (
        <Gem className="h-4 w-4 text-muted-foreground" />
      )}
    </div>
  );
}

const KIND_TABS: { value: OrderKindFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "custom", label: "Custom" },
  { value: "stock", label: "Stock" },
];

/**
 * The custom-order + replenishment timeline, extracted from the Timelines page
 * so it can be embedded as the "Orders" tab of the merged Quotation & Orders
 * screen (round-2: quotation + timeline are one module) as well as rendered on
 * its own /timelines route. Owns its Book Order action + dialogs.
 */
export function OrdersTimelineView() {
  const [kindFilter, setKindFilter] = useState<OrderKindFilter>("all");
  const {
    data: orders = [],
    isLoading: ordersLoading,
    isError: ordersError,
    refetch: refetchOrders,
  } = useOrders({ kind: kindFilter, scope: "ongoing" });
  const {
    data: replenishments = [],
    isLoading: replenLoading,
    isError: replenError,
    refetch: refetchReplen,
  } = useReplenishment();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [bookingOpen, setBookingOpen] = useState(false);
  const [detailOrder, setDetailOrder] = useState<CustomOrder | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const active = useMemo(
    () => orders.find((o) => o.id === activeId) ?? orders[0] ?? null,
    [orders, activeId],
  );

  function openDetail(order: CustomOrder) {
    setDetailOrder(order);
    setDetailOpen(true);
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        {/* Open point: customer-facing timeline deferred (see DECISIONS.md). */}
        <div className="flex items-center gap-2 rounded-md border border-dashed bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <Badge variant="outline">Internal view</Badge>
          Custom orders booked from a quote land here and move through production.
        </div>
        <Button size="sm" onClick={() => setBookingOpen(true)}>
          <Plus className="h-4 w-4" /> Book Order
        </Button>
      </div>

      <Tabs defaultValue="orders">
        <TabsList>
          <TabsTrigger value="orders">Orders</TabsTrigger>
          <TabsTrigger value="replenishment">Stock in transit</TabsTrigger>
        </TabsList>

        <TabsContent value="orders" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Tabs
              value={kindFilter}
              onValueChange={(v) => setKindFilter(v as OrderKindFilter)}
            >
              <TabsList>
                {KIND_TABS.map((t) => (
                  <TabsTrigger key={t.value} value={t.value}>
                    {t.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <p className="text-xs text-muted-foreground">
              Showing ongoing orders in production.
            </p>
          </div>

          {ordersLoading ? (
            <>
              <Skeleton className="h-48 rounded-xl" />
              <Skeleton className="h-64 rounded-xl" />
            </>
          ) : ordersError ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 py-12 text-center text-sm text-muted-foreground">
                <p>Couldn&apos;t load orders.</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => refetchOrders()}
                >
                  Retry
                </Button>
              </CardContent>
            </Card>
          ) : !active ? (
            <EmptyState
              icon={Package}
              title="No ongoing orders"
              description="Book a custom or stock order, or convert a quote."
              actionLabel="Book Order"
              onAction={() => setBookingOpen(true)}
            />
          ) : (
            <>
              <Card>
                <CardHeader className="pb-2">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex gap-3">
                      <OrderThumb order={active} />
                      <div>
                        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                          {active.ref} · {active.item || "Order"}
                          <KindBadge kind={active.kind} />
                        </CardTitle>
                        <CardDescription>
                          {active.customer} · {active.storeName}
                          {categoryLabel(active.category)
                            ? ` · ${categoryLabel(active.category)}`
                            : ""}
                          {" · "}
                          <span className="num">×{active.qty ?? 1}</span>
                          {active.grams ? (
                            <>
                              {" · "}
                              <span className="num">
                                {formatGrams(active.grams, 1)}
                              </span>
                            </>
                          ) : null}
                        </CardDescription>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">
                        Owner: {roleLabel(active.ownerRole)}
                      </Badge>
                      {active.delayed ? (
                        <Badge variant="destructive">Delayed</Badge>
                      ) : (
                        <Badge variant="success">On track</Badge>
                      )}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 pt-2">
                  <OrderStepper
                    currentStageIndex={active.currentStageIndex}
                    delayed={active.delayed}
                  />
                  <Separator />
                  <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5">
                      <Factory className="h-3.5 w-3.5" />
                      Held by {active.ownerName || roleLabel(active.ownerRole)}
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <CalendarClock className="h-3.5 w-3.5" />
                      Booked{" "}
                      <span className="num">{formatDay(active.bookedOn)}</span> ·
                      ETA{" "}
                      <span
                        className={
                          active.delayed
                            ? "num font-medium text-destructive"
                            : "num font-medium text-foreground"
                        }
                      >
                        {formatDay(active.eta)}
                      </span>
                    </span>
                    {active.estimation !== undefined ? (
                      <span>
                        Advance{" "}
                        <span className="num font-medium text-foreground">
                          {formatINR(active.advanceReceived ?? 0)}
                        </span>{" "}
                        of{" "}
                        <span className="num font-medium text-foreground">
                          {formatINR(active.estimation)}
                        </span>
                      </span>
                    ) : null}
                    <span>Stage: {ORDER_STAGES[active.currentStageIndex]}</span>
                  </div>
                  {active.details ? (
                    <p className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                      {active.details}
                    </p>
                  ) : null}
                  <div className="flex justify-end">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openDetail(active)}
                    >
                      View full details
                    </Button>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Ongoing orders</CardTitle>
                  <CardDescription>
                    Select a row to preview its stage progression above, or open
                    full details.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-12" />
                        <TableHead>Order</TableHead>
                        <TableHead>Customer</TableHead>
                        <TableHead>Category · Qty</TableHead>
                        <TableHead>Current stage</TableHead>
                        <TableHead className="text-right">Advance / Est</TableHead>
                        <TableHead className="text-right">ETA</TableHead>
                        <TableHead className="text-right">Status</TableHead>
                        <TableHead className="text-right">Details</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {orders.map((o) => (
                        <TableRow
                          key={o.id}
                          onClick={() => setActiveId(o.id)}
                          className="cursor-pointer"
                          data-state={
                            o.id === active.id ? "selected" : undefined
                          }
                        >
                          <TableCell>
                            <OrderThumb order={o} />
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2 font-medium">
                              {o.ref}
                              <KindBadge kind={o.kind} />
                            </div>
                            {o.item ? (
                              <div className="text-xs text-muted-foreground">
                                {o.item}
                              </div>
                            ) : null}
                          </TableCell>
                          <TableCell>{o.customer}</TableCell>
                          <TableCell className="text-muted-foreground">
                            {categoryLabel(o.category) ?? "—"}
                            {" · "}
                            <span className="num">×{o.qty ?? 1}</span>
                          </TableCell>
                          <TableCell>
                            {ORDER_STAGES[o.currentStageIndex]}
                          </TableCell>
                          <TableCell className="text-right">
                            {o.estimation !== undefined ? (
                              <span className="num">
                                {formatINR(o.advanceReceived ?? 0)}
                                <span className="text-muted-foreground">
                                  {" / "}
                                  {formatINR(o.estimation)}
                                </span>
                              </span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell
                            className={
                              o.delayed
                                ? "text-right text-destructive"
                                : "text-right"
                            }
                          >
                            <span className="num">{formatDay(o.eta)}</span>
                          </TableCell>
                          <TableCell className="text-right">
                            {o.delayed ? (
                              <Badge variant="destructive">Delayed</Badge>
                            ) : (
                              <Badge variant="success">On track</Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                openDetail(o);
                              }}
                            >
                              View
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>

        <TabsContent value="replenishment">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Truck className="h-4 w-4" />
                Stock in transit
              </CardTitle>
              <CardDescription>
                Raw material and finished stock moving from factory/warehouse to
                the storefront (replenishment).
              </CardDescription>
            </CardHeader>
            <CardContent>
              {replenLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-11 w-full" />
                  ))}
                </div>
              ) : replenError ? (
                <div className="rounded-lg border bg-muted/40 p-6 text-center text-sm text-muted-foreground">
                  <p>Couldn&apos;t load stock in transit.</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={() => refetchReplen()}
                  >
                    Retry
                  </Button>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Material</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead>Destination</TableHead>
                      <TableHead className="text-right">Weight</TableHead>
                      <TableHead className="text-right">ETA</TableHead>
                      <TableHead className="text-right">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {replenishments.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="max-w-[16rem] font-medium">
                          {r.material}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {r.source}
                        </TableCell>
                        <TableCell>{r.destStoreName}</TableCell>
                        <TableCell className="text-right">
                          <span className="num">
                            {r.grams > 0 ? formatGrams(r.grams, 1) : "—"}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          <span className="num">{formatDay(r.eta)}</span>
                        </TableCell>
                        <TableCell className="text-right">
                          <Badge variant={REPLEN_VARIANT[r.status] ?? "outline"}>
                            {r.status}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                    {replenishments.length === 0 ? (
                      <TableRow>
                        <TableCell
                          colSpan={6}
                          className="py-10 text-center text-muted-foreground"
                        >
                          No replenishment movements in transit yet.
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <OrderBookingDialog open={bookingOpen} onOpenChange={setBookingOpen} />
      <OrderDetailDialog
        order={detailOrder}
        open={detailOpen}
        onOpenChange={setDetailOpen}
      />
    </>
  );
}
