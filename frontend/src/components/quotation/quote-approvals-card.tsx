"use client";

import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatINR } from "@/lib/format";
import {
  useDecideQuote,
  usePendingQuoteApprovals,
  useQuoteApprovalSettings,
  useSaveQuoteApprovalSettings,
  type PendingQuoteApproval,
} from "@/lib/queries/quotes";
import { ROLE_RANK } from "@/lib/types";
import { apiErrorMessage } from "@/lib/utils";
import { useSession } from "@/store/use-session";

/**
 * The manager's side of quote approval: what is waiting, and (head office only)
 * the rule that decides which quotes wait at all.
 *
 * Hidden from salespeople — they meet approval inside the quote itself. Hidden
 * from managers too when the rule is off and nothing is waiting, so a tenant
 * that does not use approval never sees an empty box for it.
 */
export function QuoteApprovalsCard() {
  const role = useSession((s) => s.role);
  const isManager = ROLE_RANK[role] >= ROLE_RANK.store_manager;
  const isHeadOffice = role === "head_office";
  const pending = usePendingQuoteApprovals(isManager);
  const settings = useQuoteApprovalSettings(isManager);

  if (!isManager) return null;
  const rows = pending.data ?? [];
  const ruleOff = settings.data ? settings.data.valueThreshold == null : true;
  if (!isHeadOffice && ruleOff && rows.length === 0) return null;

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" />
          Quote approvals
          {rows.length > 0 && (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-semibold tabular-nums text-amber-700 dark:text-amber-300">
              {rows.length} waiting
            </span>
          )}
        </CardTitle>
        {settings.data && (
          <p className="text-xs text-muted-foreground">
            {settings.data.valueThreshold == null
              ? "Approval is off — quotes can be sent without a manager."
              : settings.data.valueThreshold === 0
                ? "Every quote needs a manager to approve the final amount."
                : `Quotes of ${formatINR(settings.data.valueThreshold)} or more need a manager.`}
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {pending.isLoading ? null : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing waiting for a decision.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {rows.map((r) => (
              <PendingRow key={r.id} row={r} />
            ))}
          </ul>
        )}
        {isHeadOffice && settings.data && <ApprovalRule current={settings.data.valueThreshold} />}
      </CardContent>
    </Card>
  );
}

function PendingRow({ row }: { row: PendingQuoteApproval }) {
  const decide = useDecideQuote();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  const act = (approve: boolean) =>
    decide.mutate(
      { id: row.id, approve, reason: approve ? undefined : reason.trim() },
      {
        onSuccess: () => toast.success(`${row.ref} ${approve ? "approved" : "rejected"}`),
        onError: (e) => toast.error(apiErrorMessage(e, "Could not record the decision.")),
      },
    );

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
      <div className="min-w-0">
        <p className="font-medium">
          {row.ref} · {row.customerName}
        </p>
        <p className="text-xs text-muted-foreground">
          <span className="font-semibold tabular-nums text-foreground">{formatINR(row.amount)}</span>
          {row.requestedByName ? ` · asked by ${row.requestedByName}` : ""}
          {row.storeName ? ` · ${row.storeName}` : ""}
        </p>
      </div>
      {rejecting ? (
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <Input
            id={`reject-${row.id}`}
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (required)"
            className="h-8 min-w-0 flex-1 sm:w-56"
          />
          <Button
            size="sm"
            variant="destructive"
            className="h-8"
            disabled={decide.isPending || !reason.trim()}
            onClick={() => act(false)}
          >
            Reject
          </Button>
          <Button size="sm" variant="ghost" className="h-8" onClick={() => setRejecting(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button size="sm" className="h-8" disabled={decide.isPending} onClick={() => act(true)}>
            Approve
          </Button>
          <Button size="sm" variant="outline" className="h-8" disabled={decide.isPending} onClick={() => setRejecting(true)}>
            Reject
          </Button>
        </div>
      )}
    </li>
  );
}

/** Head office sets which quotes need a manager: every quote, above an amount, or none. */
function ApprovalRule({ current }: { current: number | null }) {
  const save = useSaveQuoteApprovalSettings();
  const [amount, setAmount] = useState(current && current > 0 ? String(current) : "");

  const apply = (valueThreshold: number | null, done: string) =>
    save.mutate(
      { valueThreshold },
      {
        onSuccess: () => toast.success(done),
        onError: (e) => toast.error(apiErrorMessage(e, "Could not save the approval rule.")),
      },
    );

  return (
    <div className="flex flex-wrap items-end gap-2 border-t pt-3">
      <Button
        size="sm"
        variant={current === 0 ? "default" : "outline"}
        disabled={save.isPending}
        onClick={() => apply(0, "Every quote now needs a manager’s approval")}
      >
        Every quote
      </Button>
      <div className="grid gap-1">
        <Label htmlFor="approval-threshold" className="text-xs text-muted-foreground">
          Or only quotes from (₹)
        </Label>
        <div className="flex gap-2">
          <Input
            id="approval-threshold"
            inputMode="numeric"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ""))}
            placeholder="e.g. 200000"
            className="h-9 w-32"
          />
          <Button
            size="sm"
            variant={current != null && current > 0 ? "default" : "outline"}
            disabled={save.isPending || !amount}
            onClick={() => apply(Number(amount), `Quotes of ₹${Number(amount).toLocaleString("en-IN")} or more now need approval`)}
          >
            Set amount
          </Button>
        </div>
      </div>
      <Button
        size="sm"
        variant={current == null ? "secondary" : "ghost"}
        disabled={save.isPending}
        onClick={() => apply(null, "Quote approval turned off")}
      >
        Off
      </Button>
    </div>
  );
}
