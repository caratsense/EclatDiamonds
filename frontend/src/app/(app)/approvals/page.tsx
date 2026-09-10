"use client";

import * as React from "react";
import {
  CalendarClock,
  Check,
  ClipboardCheck,
  Fingerprint,
  type LucideIcon,
  Percent,
  RotateCcw,
  X,
} from "lucide-react";
import { toast } from "sonner";

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
import { formatINR, formatPercent } from "@/lib/format";
import { getNavItem } from "@/lib/navigation";
import { ROLE_LABELS } from "@/lib/types";
import {
  CHOSEN_OPTION_LABELS,
  RETURN_TYPE_LABELS,
  type ReturnRecord,
} from "@/lib/mock/returns";
import {
  useApproveDiscount,
  useDiscounts,
  useRejectDiscount,
} from "@/lib/queries/discounts";
import {
  useApproveReturn,
  useRejectReturn,
  useReturns,
} from "@/lib/queries/returns";
import {
  useDecideLeave,
  useDecideRegularization,
  useLeaveRequests,
  useRegularizations,
} from "@/lib/queries/hrms";
import { apiErrorMessage } from "@/lib/utils";

/** Prefer the server-computed value; fall back to the legacy creditValue. */
function optionValue(
  r: ReturnRecord,
  which: "exchange" | "buyback",
): number | null {
  if (which === "exchange") {
    return r.exchangeValue ?? (r.settlement === "exchange" ? r.creditValue : null);
  }
  return r.buybackValue ?? (r.settlement !== "exchange" ? r.creditValue : null);
}

export default function ApprovalsPage() {
  const nav = getNavItem("approvals");

  // ---- Sources (all store-scoped via their own hooks) ----------------------
  const discountsQ = useDiscounts();
  const returnsQ = useReturns();
  const leaveQ = useLeaveRequests();
  const regularQ = useRegularizations();

  const approveDiscount = useApproveDiscount();
  const rejectDiscount = useRejectDiscount();
  const approveReturn = useApproveReturn();
  const rejectReturn = useRejectReturn();
  const decideLeave = useDecideLeave();
  const decideRegular = useDecideRegularization();

  // ---- Pending-only projections -------------------------------------------
  const pendingDiscounts = (discountsQ.data ?? []).filter(
    (d) => d.status === "pending" || d.status === "escalated",
  );
  const pendingReturns = (returnsQ.data ?? []).filter(
    (r) => r.status === "pending_approval",
  );
  const pendingLeave = (leaveQ.data ?? []).filter((l) => l.status === "pending");
  const pendingRegular = (regularQ.data ?? []).filter(
    (r) => r.status === "pending",
  );

  const total =
    pendingDiscounts.length +
    pendingReturns.length +
    pendingLeave.length +
    pendingRegular.length;

  const anyLoading =
    discountsQ.isLoading ||
    returnsQ.isLoading ||
    leaveQ.isLoading ||
    regularQ.isLoading;
  const anyError =
    discountsQ.isError ||
    returnsQ.isError ||
    leaveQ.isError ||
    regularQ.isError;
  const allClear = !anyLoading && !anyError && total === 0;

  // Reject-with-reason dialog target: which kind of request + its id.
  const [rejectTarget, setRejectTarget] = React.useState<{
    kind: "discount" | "return";
    id: string;
  } | null>(null);
  const [rejectNote, setRejectNote] = React.useState("");

  const rejectPending =
    (rejectTarget?.kind === "discount" && rejectDiscount.isPending) ||
    (rejectTarget?.kind === "return" && rejectReturn.isPending);

  function openReject(kind: "discount" | "return", id: string) {
    setRejectNote("");
    setRejectTarget({ kind, id });
  }

  function closeReject() {
    setRejectTarget(null);
    setRejectNote("");
  }

  function confirmReject() {
    if (!rejectTarget) return;
    const note = rejectNote.trim() || undefined;
    const label = rejectTarget.kind === "discount" ? "Discount" : "Return";
    const m = rejectTarget.kind === "discount" ? rejectDiscount : rejectReturn;
    m.mutate(
      { id: rejectTarget.id, note },
      {
        onSuccess: () => {
          toast.success(`${label} rejected`);
          closeReject();
        },
        onError: () =>
          toast.error(`Could not reject this ${label.toLowerCase()}.`),
      },
    );
  }

  // ---- Decisions -----------------------------------------------------------
  function approveDiscountReq(id: string) {
    approveDiscount.mutate(id, {
      onSuccess: () => toast.success("Discount approved"),
      onError: (err) => toast.error(apiErrorMessage(err, "Could not approve this discount.")),
    });
  }

  function approveReturnReq(id: string) {
    approveReturn.mutate(id, {
      onSuccess: () => toast.success("Return approved"),
      onError: (err) => toast.error(apiErrorMessage(err, "Could not approve the return.")),
    });
  }

  function decideLeaveReq(id: string, action: "approve" | "reject") {
    decideLeave.mutate(
      { id, status: action === "approve" ? "approved" : "rejected" },
      {
        onSuccess: () =>
          toast.success(
            action === "approve" ? "Leave approved" : "Leave rejected",
          ),
        onError: () => toast.error(`Could not ${action} this leave request.`),
      },
    );
  }

  function decideRegularReq(id: string, action: "approve" | "reject") {
    decideRegular.mutate(
      { id, status: action === "approve" ? "approved" : "rejected" },
      {
        onSuccess: () =>
          toast.success(
            action === "approve"
              ? "Attendance fix approved"
              : "Attendance fix rejected",
          ),
        onError: () =>
          toast.error(`Could not ${action} this attendance fix.`),
      },
    );
  }

  return (
    <>
      <SectionHeader
        title={nav?.title ?? "Approvals"}
        purpose={
          nav?.purpose ??
          "Discount, return and leave requests awaiting your approval."
        }
      />

      {anyLoading ? (
        <LoadingState />
      ) : allClear ? (
        <EmptyState
          icon={ClipboardCheck}
          title="No pending approvals"
          description="Nothing is awaiting your approval."
        />
      ) : (
        <>
          {/* Summary: total + per-type counts */}
          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <SummaryTile
              icon={ClipboardCheck}
              label="Total pending"
              value={total}
              highlight
            />
            <SummaryTile
              icon={Percent}
              label="Discounts"
              value={pendingDiscounts.length}
            />
            <SummaryTile
              icon={RotateCcw}
              label="Returns"
              value={pendingReturns.length}
            />
            <SummaryTile
              icon={CalendarClock}
              label="Leave"
              value={pendingLeave.length}
            />
            <SummaryTile
              icon={Fingerprint}
              label="Attendance fixes"
              value={pendingRegular.length}
            />
          </div>

          <div className="space-y-4">
            {/* -------- Discounts -------- */}
            <ApprovalSection
              icon={Percent}
              title="Discounts"
              description="Diamond / making discount requests routed to you for sign-off."
              count={pendingDiscounts.length}
              isError={discountsQ.isError}
              onRetry={() => discountsQ.refetch()}
            >
              {pendingDiscounts.map((d) => {
                const approving =
                  approveDiscount.isPending && approveDiscount.variables === d.id;
                const rejecting =
                  rejectDiscount.isPending &&
                  rejectDiscount.variables?.id === d.id;
                return (
                  <ApprovalRow
                    key={d.id}
                    actions={
                      <DecisionButtons
                        approving={approving}
                        rejecting={rejecting}
                        onApprove={() => approveDiscountReq(d.id)}
                        onReject={() => openReject("discount", d.id)}
                      />
                    }
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      {d.ref ? (
                        <span className="num text-xs text-muted-foreground">
                          {d.ref}
                        </span>
                      ) : null}
                      <span className="font-medium text-foreground">
                        {d.customerName || "—"}
                      </span>
                      {d.status === "escalated" ? (
                        <Badge variant="warning">Escalated</Badge>
                      ) : (
                        <Badge variant="secondary">Pending</Badge>
                      )}
                      <span className="text-xs text-muted-foreground">
                        needs {ROLE_LABELS[d.requiredRole]}
                      </span>
                    </div>
                    <div className="text-sm text-muted-foreground">
                      {d.item || "Discount request"} · Diamond{" "}
                      <span className="num font-medium text-foreground">
                        {formatPercent(d.diamondPercent)}
                      </span>{" "}
                      · Making{" "}
                      <span className="num font-medium text-foreground">
                        {formatPercent(d.makingPercent)}
                      </span>
                      {d.sellingPrice != null ? (
                        <>
                          {" "}
                          ·{" "}
                          <span className="num font-medium text-foreground">
                            {formatINR(d.sellingPrice)}
                          </span>
                        </>
                      ) : null}
                    </div>
                    {d.reason ? (
                      <p className="text-xs text-muted-foreground">
                        &ldquo;{d.reason}&rdquo;
                      </p>
                    ) : null}
                  </ApprovalRow>
                );
              })}
            </ApprovalSection>

            {/* -------- Returns -------- */}
            <ApprovalSection
              icon={RotateCcw}
              title="Returns"
              description="Returns, exchanges and buybacks awaiting approval."
              count={pendingReturns.length}
              isError={returnsQ.isError}
              onRetry={() => returnsQ.refetch()}
            >
              {pendingReturns.map((r) => {
                const approving =
                  approveReturn.isPending && approveReturn.variables === r.id;
                const rejecting =
                  rejectReturn.isPending && rejectReturn.variables?.id === r.id;
                const exVal = optionValue(r, "exchange");
                const bbVal = optionValue(r, "buyback");
                return (
                  <ApprovalRow
                    key={r.id}
                    actions={
                      <DecisionButtons
                        approving={approving}
                        rejecting={rejecting}
                        onApprove={() => approveReturnReq(r.id)}
                        onReject={() => openReject("return", r.id)}
                      />
                    }
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="num text-xs text-muted-foreground">
                        {r.ref}
                      </span>
                      <span className="font-medium text-foreground">
                        {r.customer}
                      </span>
                      <Badge variant="outline">
                        {RETURN_TYPE_LABELS[r.type]}
                      </Badge>
                      {r.chosenOption ? (
                        <Badge
                          variant={
                            r.chosenOption === "exchange" ? "gold" : "secondary"
                          }
                        >
                          {CHOSEN_OPTION_LABELS[r.chosenOption]}
                        </Badge>
                      ) : null}
                    </div>
                    <div className="text-sm text-muted-foreground">{r.item}</div>
                    <div className="text-sm text-muted-foreground">
                      Exchange{" "}
                      <span className="num font-medium text-foreground">
                        {exVal != null ? formatINR(exVal) : "—"}
                      </span>{" "}
                      · Buyback{" "}
                      <span className="num font-medium text-foreground">
                        {bbVal != null ? formatINR(bbVal) : "—"}
                      </span>
                    </div>
                  </ApprovalRow>
                );
              })}
            </ApprovalSection>

            {/* -------- Leave -------- */}
            <ApprovalSection
              icon={CalendarClock}
              title="Leave"
              description="Staff leave requests pending your decision."
              count={pendingLeave.length}
              isError={leaveQ.isError}
              onRetry={() => leaveQ.refetch()}
            >
              {pendingLeave.map((lr) => {
                const approving =
                  decideLeave.isPending &&
                  decideLeave.variables?.id === lr.id &&
                  decideLeave.variables?.status === "approved";
                const rejecting =
                  decideLeave.isPending &&
                  decideLeave.variables?.id === lr.id &&
                  decideLeave.variables?.status === "rejected";
                return (
                  <ApprovalRow
                    key={lr.id}
                    actions={
                      <DecisionButtons
                        approving={approving}
                        rejecting={rejecting}
                        onApprove={() => decideLeaveReq(lr.id, "approve")}
                        onReject={() => decideLeaveReq(lr.id, "reject")}
                      />
                    }
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">
                        {lr.name}
                      </span>
                      <Badge variant="outline">{lr.type}</Badge>
                    </div>
                    <div className="text-sm text-muted-foreground">
                      {lr.from} – {lr.to} ·{" "}
                      <span className="num font-medium text-foreground">
                        {lr.days}
                      </span>{" "}
                      day{lr.days === 1 ? "" : "s"}
                      {lr.halfDay ? " · half-day" : ""}
                    </div>
                    {lr.reason ? (
                      <p className="text-xs text-muted-foreground">
                        &ldquo;{lr.reason}&rdquo;
                      </p>
                    ) : null}
                  </ApprovalRow>
                );
              })}
            </ApprovalSection>

            {/* -------- Attendance fixes (regularizations) -------- */}
            <ApprovalSection
              icon={Fingerprint}
              title="Attendance fixes"
              description="Missed / wrong-punch corrections awaiting your decision."
              count={pendingRegular.length}
              isError={regularQ.isError}
              onRetry={() => regularQ.refetch()}
            >
              {pendingRegular.map((rg) => {
                const approving =
                  decideRegular.isPending &&
                  decideRegular.variables?.id === rg.id &&
                  decideRegular.variables?.status === "approved";
                const rejecting =
                  decideRegular.isPending &&
                  decideRegular.variables?.id === rg.id &&
                  decideRegular.variables?.status === "rejected";
                return (
                  <ApprovalRow
                    key={rg.id}
                    actions={
                      <DecisionButtons
                        approving={approving}
                        rejecting={rejecting}
                        onApprove={() => decideRegularReq(rg.id, "approve")}
                        onReject={() => decideRegularReq(rg.id, "reject")}
                      />
                    }
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">
                        {rg.name}
                      </span>
                      <Badge variant="outline">{rg.date}</Badge>
                    </div>
                    <div className="text-sm text-muted-foreground">
                      {rg.requestedCheckIn ? (
                        <>
                          In{" "}
                          <span className="num font-medium text-foreground">
                            {new Date(rg.requestedCheckIn).toLocaleTimeString(
                              "en-IN",
                              { hour: "2-digit", minute: "2-digit" },
                            )}
                          </span>
                        </>
                      ) : null}
                      {rg.requestedCheckOut ? (
                        <>
                          {rg.requestedCheckIn ? " · " : ""}Out{" "}
                          <span className="num font-medium text-foreground">
                            {new Date(rg.requestedCheckOut).toLocaleTimeString(
                              "en-IN",
                              { hour: "2-digit", minute: "2-digit" },
                            )}
                          </span>
                        </>
                      ) : null}
                    </div>
                    {rg.reason ? (
                      <p className="text-xs text-muted-foreground">
                        &ldquo;{rg.reason}&rdquo;
                      </p>
                    ) : null}
                  </ApprovalRow>
                );
              })}
            </ApprovalSection>
          </div>
        </>
      )}

      <Dialog
        open={rejectTarget != null}
        onOpenChange={(o) => {
          if (!o) closeReject();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Reject {rejectTarget?.kind === "return" ? "return" : "discount"}
            </DialogTitle>
            <DialogDescription>
              Add an optional reason. It is shared with the requester as a note
              from the approver.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="approval-reject-note">Reason for rejection</Label>
            <Textarea
              id="approval-reject-note"
              placeholder="Explain why this request can't be approved."
              value={rejectNote}
              onChange={(e) => setRejectNote(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeReject}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmReject}
              disabled={rejectPending}
            >
              {rejectPending ? "Rejecting…" : "Reject request"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Presentational helpers                                                     */
/* -------------------------------------------------------------------------- */

function SummaryTile({
  icon: Icon,
  label,
  value,
  highlight = false,
}: {
  icon: LucideIcon;
  label: string;
  value: number;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border p-4 shadow-xs ${
        highlight ? "bg-accent" : "bg-card"
      }`}
    >
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className="num mt-1 text-2xl font-semibold text-foreground">
        {value}
      </div>
    </div>
  );
}

function ApprovalSection({
  icon: Icon,
  title,
  description,
  count,
  isError = false,
  onRetry,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  count: number;
  isError?: boolean;
  onRetry?: () => void;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground" />
          {title}
          {count > 0 ? (
            <Badge variant="secondary" className="ml-1">
              <span className="num">{count}</span>
            </Badge>
          ) : null}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {isError ? (
          <div className="flex flex-col gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <span>Couldn&apos;t load {title.toLowerCase()}.</span>
            {onRetry ? (
              <Button
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={onRetry}
              >
                Retry
              </Button>
            ) : null}
          </div>
        ) : count === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing pending.</p>
        ) : (
          <div className="space-y-2">{children}</div>
        )}
      </CardContent>
    </Card>
  );
}

function ApprovalRow({
  children,
  actions,
}: {
  children: React.ReactNode;
  actions: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1">{children}</div>
      {actions}
    </div>
  );
}

function DecisionButtons({
  onApprove,
  onReject,
  approving,
  rejecting,
}: {
  onApprove: () => void;
  onReject: () => void;
  approving: boolean;
  rejecting: boolean;
}) {
  const busy = approving || rejecting;
  return (
    <div className="flex shrink-0 gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={onApprove}
      >
        <Check className="h-3.5 w-3.5" />
        Approve
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="text-destructive hover:text-destructive"
        disabled={busy}
        onClick={onReject}
      >
        <X className="h-3.5 w-3.5" />
        Reject
      </Button>
    </div>
  );
}

function LoadingState() {
  return (
    <>
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[76px] w-full rounded-xl" />
        ))}
      </div>
      <div className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-40 w-full rounded-xl" />
        ))}
      </div>
    </>
  );
}
