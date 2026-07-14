"use client";

import * as React from "react";
import { Check, Gem, Hammer, Lock, Percent, ShieldCheck, X } from "lucide-react";
import { toast } from "sonner";

import { DiscountRequestDialog } from "@/components/discounts/discount-request-dialog";
import { SectionHeader } from "@/components/section/section-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatINR, formatPercent } from "@/lib/format";
import { getNavItem } from "@/lib/navigation";
import { ROLE_LABELS, ROLE_RANK } from "@/lib/types";
import {
  DISCOUNT_STATUS_LABELS,
  type DiscountRecord,
  type DiscountStatus,
} from "@/lib/mock/discounts";
import {
  useApproveDiscount,
  useDiscountLimits,
  useDiscounts,
  useRejectDiscount,
} from "@/lib/queries/discounts";
import { useSession } from "@/store/use-session";

const STATUS_VARIANT: Record<
  DiscountStatus,
  "default" | "secondary" | "destructive" | "success" | "outline" | "warning"
> = {
  approved: "success",
  pending: "secondary",
  escalated: "warning",
  rejected: "destructive",
};

export default function DiscountsPage() {
  const nav = getNavItem("discounts");
  const { role, currentStore } = useSession();

  // CRITICAL (M15): cost price + margin are visible to area/HO ONLY. This gate
  // is on the viewer's ROLE — never on whether the field is present — so a stray
  // costPrice in a store-manager payload can never render.
  const isApprover = role === "area_manager" || role === "head_office";
  const canSeeCost = isApprover;

  const [addOpen, setAddOpen] = React.useState(false);

  const { data: rows = [], isLoading, isError, refetch } = useDiscounts();
  const approve = useApproveDiscount();
  const reject = useRejectDiscount();

  // Source the banner's store-manager caps from the real limits endpoint so the
  // helper text can never drift from the server. The limits query is only
  // enabled for approvers (area/HO); lower roles fall back to neutral phrasing.
  const { data: limits = [] } = useDiscountLimits();
  const smCap = limits.find((l) => l.role === "store_manager");
  const diamondCap = smCap?.diamondPercent ?? null;
  const makingCap = smCap?.makingPercent ?? null;

  /** May the current viewer action this row? Role rank must satisfy requiredRole. */
  function canActOn(row: DiscountRecord): boolean {
    return (
      isApprover &&
      ROLE_RANK[role] >= ROLE_RANK[row.requiredRole] &&
      (row.status === "pending" || row.status === "escalated")
    );
  }

  function decide(id: string, action: "approve" | "reject") {
    const m = action === "approve" ? approve : reject;
    m.mutate(id, {
      onSuccess: () =>
        toast.success(
          action === "approve" ? "Discount approved" : "Discount rejected",
        ),
      onError: () => toast.error(`Could not ${action} this request.`),
    });
  }

  // base cols: request · customer · item · diamond · making · selling · status · required
  const colCount = 8 + (canSeeCost ? 2 : 0) + (isApprover ? 1 : 0);

  return (
    <>
      <SectionHeader
        title={nav?.title ?? "Discounts"}
        purpose={nav?.purpose ?? ""}
        primaryAction={nav?.primaryAction ?? "Request Discount"}
        onPrimaryAction={() => setAddOpen(true)}
      />

      {/* Rules banner — same for every role. */}
      <Card className="mb-4">
        <CardContent className="flex flex-col gap-2 py-4 text-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <span>
              <strong>Gold carries no discount.</strong>{" "}
              {diamondCap != null && makingCap != null ? (
                <>
                  Diamond &amp; making within store-manager caps (Diamond ≤{" "}
                  {formatPercent(diamondCap)} / Making ≤{" "}
                  {formatPercent(makingCap)}) auto-approve; higher escalates to
                  Area Manager, then Head Office.
                </>
              ) : (
                <>
                  Diamond &amp; making within the store-manager caps auto-approve;
                  higher amounts escalate to Area Manager, then Head Office.
                </>
              )}
            </span>
          </div>
          <Badge variant="outline" className="w-fit shrink-0">
            {ROLE_LABELS[role]} view
          </Badge>
        </CardContent>
      </Card>

      {/* Requests list */}
      <Card>
        <CardHeader>
          <CardTitle>Discount requests</CardTitle>
          <CardDescription>
            {isApprover
              ? `Approve or reject requests routed to you for ${currentStore.name}.`
              : `Your requests for ${currentStore.name} and their approval status.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ref</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Item</TableHead>
                <TableHead className="text-right">
                  <span className="inline-flex items-center gap-1">
                    <Gem className="h-3.5 w-3.5" /> Diamond
                  </span>
                </TableHead>
                <TableHead className="text-right">
                  <span className="inline-flex items-center gap-1">
                    <Hammer className="h-3.5 w-3.5" /> Making
                  </span>
                </TableHead>
                <TableHead className="text-right">Selling</TableHead>
                {canSeeCost ? (
                  <>
                    <TableHead className="text-right">Cost</TableHead>
                    <TableHead className="text-right">Margin</TableHead>
                  </>
                ) : null}
                <TableHead>Status</TableHead>
                <TableHead>Required</TableHead>
                {isApprover ? (
                  <TableHead className="text-right">Action</TableHead>
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={colCount} className="py-6">
                    <Skeleton className="h-24 w-full" />
                  </TableCell>
                </TableRow>
              ) : isError ? (
                <TableRow>
                  <TableCell colSpan={colCount} className="py-10 text-center">
                    <div className="mx-auto max-w-sm rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
                      <p>Couldn&apos;t load discount requests.</p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-3"
                        onClick={() => refetch()}
                      >
                        Retry
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={colCount} className="py-6">
                    <EmptyState
                      icon={Percent}
                      title="No discount requests yet"
                      description="Raise a discount on diamond or making; within store-manager caps it auto-approves, higher amounts escalate for approval."
                      actionLabel="Request Discount"
                      onAction={() => setAddOpen(true)}
                    />
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((d) => {
                  const margin = d.marginImpact ?? d.margin;
                  const actionable = canActOn(d);
                  return (
                    <TableRow key={d.id}>
                      <TableCell className="font-medium">
                        <span className="num">{d.ref ?? d.id}</span>
                      </TableCell>
                      <TableCell>
                        <div>{d.customerName}</div>
                        {d.decisionNote &&
                        (d.status === "approved" ||
                          d.status === "rejected") ? (
                          <p className="mt-0.5 max-w-[220px] text-xs text-muted-foreground">
                            Note from approver: {d.decisionNote}
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell className="max-w-[200px] truncate">
                        {d.item || "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <span className="num">
                          {formatPercent(d.diamondPercent)}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        <span className="num">
                          {formatPercent(d.makingPercent)}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        {d.sellingPrice != null ? (
                          <span className="num">
                            {formatINR(d.sellingPrice)}
                          </span>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      {canSeeCost ? (
                        <>
                          <TableCell className="text-right">
                            {d.costPrice != null ? (
                              <span className="num text-muted-foreground">
                                {formatINR(d.costPrice)}
                              </span>
                            ) : (
                              "—"
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            {margin != null ? (
                              <span
                                className={
                                  margin < 0
                                    ? "num font-medium text-destructive"
                                    : "num font-medium text-success"
                                }
                              >
                                {formatINR(margin)}
                              </span>
                            ) : (
                              "—"
                            )}
                          </TableCell>
                        </>
                      ) : null}
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[d.status]}>
                          {d.status === "approved" ? (
                            <Check className="mr-1 h-3 w-3" />
                          ) : d.status === "rejected" ? (
                            <X className="mr-1 h-3 w-3" />
                          ) : null}
                          {DISCOUNT_STATUS_LABELS[d.status]}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <span className="text-xs text-muted-foreground">
                          {ROLE_LABELS[d.requiredRole]}
                        </span>
                      </TableCell>
                      {isApprover ? (
                        <TableCell className="text-right">
                          {actionable ? (
                            <div className="flex justify-end gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={
                                  approve.isPending && approve.variables === d.id
                                }
                                onClick={() => decide(d.id, "approve")}
                              >
                                <Check className="h-3.5 w-3.5" />
                                Approve
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-destructive hover:text-destructive"
                                disabled={
                                  reject.isPending && reject.variables === d.id
                                }
                                onClick={() => decide(d.id, "reject")}
                              >
                                <X className="h-3.5 w-3.5" />
                                Reject
                              </Button>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              —
                            </span>
                          )}
                        </TableCell>
                      ) : null}
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Approval limits — area / head office only. */}
      {isApprover ? <DiscountLimitsCard /> : null}

      <DiscountRequestDialog open={addOpen} onOpenChange={setAddOpen} />
    </>
  );
}

/** Per-role diamond / making caps from GET /discounts/limits (area/HO only). */
function DiscountLimitsCard() {
  const { data: limits = [], isLoading, isError } = useDiscountLimits();

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Lock className="h-4 w-4 text-muted-foreground" />
          Approval limits
        </CardTitle>
        <CardDescription>
          Diamond &amp; making caps each role can self-approve. Above a role&apos;s
          cap, the request escalates to the next tier.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : isError ? (
          <p className="text-sm text-muted-foreground">
            Couldn&apos;t load the limits table.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Role</TableHead>
                <TableHead className="text-right">Diamond cap</TableHead>
                <TableHead className="text-right">Making cap</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {limits.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={3}
                    className="py-8 text-center text-muted-foreground"
                  >
                    No limits configured.
                  </TableCell>
                </TableRow>
              ) : (
                limits.map((l) => (
                  <TableRow key={l.role}>
                    <TableCell className="font-medium">
                      {ROLE_LABELS[l.role]}
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="num">
                        {formatPercent(l.diamondPercent)}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="num">
                        {formatPercent(l.makingPercent)}
                      </span>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
