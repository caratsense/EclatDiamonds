"use client";

import { useState } from "react";
import { Check, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatINR } from "@/lib/format";
import {
  approvalReasonLabel,
  useDecideQuote,
  usePendingQuoteApprovals,
  useQuoteApprovalSettings,
  useSaveQuoteApprovalSettings,
  type PendingQuoteApproval,
} from "@/lib/queries/quotes";
import { ROLE_LABELS, ROLE_RANK } from "@/lib/types";
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
            Now:{" "}
            <span className="font-medium text-foreground">
              {settings.data.valueThreshold == null
                ? "no quote needs approval"
                : settings.data.valueThreshold === 0
                  ? "every quote needs a manager"
                  : `${formatINR(settings.data.valueThreshold)} and above needs a manager`}
            </span>
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          A quote that needs a manager&apos;s yes waits here until someone
          approves or rejects it, and until then it cannot be sent to the
          customer. Below, you choose when that happens.{" "}
          <span className="font-medium text-foreground">
            A discount above a salesperson&apos;s own limit always needs approval,
            whatever you choose here.
          </span>
        </p>
        {pending.isLoading ? null : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing is waiting for a decision right now.</p>
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
  const role = useSession((s) => s.role);
  const decide = useDecideQuote();
  // A discount over this manager's own authority escalates past them. Say so
  // here instead of offering an Approve that the server will refuse.
  const needs = row.reasons?.find((r) => r.requiredRole)?.requiredRole;
  const tooJunior = !!needs && ROLE_RANK[role] < ROLE_RANK[needs];
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  const act = (approve: boolean) =>
    decide.mutate(
      { id: row.id, approve, reason: approve ? undefined : reason.trim(), revision: row.revision },
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
          {row.discountPercent > 0 ? (
            <span className="tabular-nums">
              {` · ${row.discountPercent}% discount (${formatINR(row.discountAmount)})`}
            </span>
          ) : null}
          {row.requestedByName ? ` · asked by ${row.requestedByName}` : ""}
          {row.storeName ? ` · ${row.storeName}` : ""}
        </p>
        {row.reasons?.length ? (
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {row.reasons.map((r) => (
              <li
                key={r.code}
                title={r.message}
                className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300"
              >
                {approvalReasonLabel(r)}
              </li>
            ))}
          </ul>
        ) : null}
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
          <Button
            size="sm"
            className="h-8"
            disabled={decide.isPending || tooJunior}
            title={tooJunior && needs ? `Needs ${ROLE_LABELS[needs]} approval` : undefined}
            onClick={() => act(true)}
          >
            {tooJunior && needs ? `Needs ${ROLE_LABELS[needs]}` : "Approve"}
          </Button>
          <Button size="sm" variant="outline" className="h-8" disabled={decide.isPending} onClick={() => setRejecting(true)}>
            Reject
          </Button>
        </div>
      )}
    </li>
  );
}

/**
 * Head office chooses when a quote needs a manager: every quote, only from an
 * amount upwards, or never. The three are mutually exclusive and the active one
 * is named in words, because "Off" on its own read as a switch nobody could
 * place.
 */
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

  const chosen = current === 0 ? "every" : current == null ? "never" : "amount";

  return (
    <div className="space-y-2 border-t pt-3">
      <p className="text-xs font-medium">When does a quote need a manager?</p>
      <div className="grid gap-2 sm:grid-cols-3">
        <Button
          size="sm"
          className="justify-start"
          variant={chosen === "every" ? "default" : "outline"}
          disabled={save.isPending}
          onClick={() => apply(0, "Every quote now needs a manager’s approval")}
        >
          {chosen === "every" ? <Check className="h-4 w-4" /> : null} Every quote
        </Button>
        <div className="flex gap-2">
          <Input
            id="approval-threshold"
            aria-label="Amount from which a quote needs a manager"
            inputMode="numeric"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ""))}
            placeholder="e.g. 200000"
            className="h-9 min-w-0 flex-1"
          />
          <Button
            size="sm"
            variant={chosen === "amount" ? "default" : "outline"}
            disabled={save.isPending || !amount}
            onClick={() =>
              apply(
                Number(amount),
                `Quotes of ₹${Number(amount).toLocaleString("en-IN")} or more now need approval`,
              )
            }
          >
            {chosen === "amount" ? <Check className="h-4 w-4" /> : null} From this amount
          </Button>
        </div>
        <Button
          size="sm"
          className="justify-start"
          variant={chosen === "never" ? "default" : "outline"}
          disabled={save.isPending}
          onClick={() => apply(null, "Quotes no longer need approval")}
        >
          {chosen === "never" ? <Check className="h-4 w-4" /> : null} Never
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {chosen === "every"
          ? "Every quote waits for a manager before it can be sent."
          : chosen === "amount"
            ? `Quotes of ${formatINR(current ?? 0)} and above wait for a manager; smaller ones go straight out.`
            : "Quotes go straight out. Only a discount above the salesperson’s limit still needs a manager."}
      </p>
    </div>
  );
}
