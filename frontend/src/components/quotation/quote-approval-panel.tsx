"use client";

import { useState } from "react";
import { CheckCircle2, Clock, ShieldAlert, XCircle } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Quote } from "@/lib/mock/quotation";
import {
  approvalReasonLabel,
  useDecideQuote,
  useQuoteApproval,
  useRequestQuoteApproval,
  type QuoteApprovalReason,
} from "@/lib/queries/quotes";
import { ROLE_LABELS, ROLE_RANK } from "@/lib/types";
import { apiErrorMessage } from "@/lib/utils";
import { useSession } from "@/store/use-session";

/**
 * "The final amount will be approved by a manager" — from the 11 Sep meeting.
 *
 * Everything here reads the server's own gate (`GET /quotes/:id/approval`), the
 * same check `POST /quotes/:id/share` refuses on. The panel never decides for
 * itself whether a quote may go out; it shows what the server will allow and
 * offers the one next step that moves it forward.
 *
 * Renders nothing when the tenant has no approval rule, or the quote is under
 * the threshold — a panel that says "no approval needed" on every quote is noise.
 */
export function QuoteApprovalPanel({ quote }: { quote: Quote }) {
  const role = useSession((s) => s.role);
  const isManager = ROLE_RANK[role] >= ROLE_RANK.store_manager;
  const gate = useQuoteApproval(quote.id);
  const request = useRequestQuoteApproval();
  const decide = useDecideQuote();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  if (!gate.data || !gate.data.required) return null;
  // A discount beyond this manager's own authority escalates past them.
  const needs = gate.data.reasons.find((r) => r.requiredRole)?.requiredRole;
  const tooJunior = !!needs && ROLE_RANK[role] < ROLE_RANK[needs];

  const busy = request.isPending || decide.isPending;
  const onRequest = () =>
    request.mutate(quote.id, {
      onSuccess: () => toast.success(`Approval requested for ${quote.ref}`),
      onError: (e) => toast.error(apiErrorMessage(e, "Could not request approval.")),
    });
  // The revision the manager is looking at goes with the decision, so an edit
  // that lands in between is refused instead of approved unseen.
  const onDecide = (approve: boolean) =>
    decide.mutate(
      {
        id: quote.id,
        approve,
        reason: approve ? undefined : reason.trim(),
        revision: gate.data?.revision,
      },
      {
        onSuccess: () => {
          toast.success(approve ? `${quote.ref} approved` : `${quote.ref} rejected`);
          setRejecting(false);
          setReason("");
        },
        onError: (e) => toast.error(apiErrorMessage(e, "Could not record the decision.")),
      },
    );

  if (gate.data.cleared) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2.5 text-xs text-emerald-700 dark:text-emerald-300">
        <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
        Approved by a manager at this amount. It can be sent to the customer.
      </div>
    );
  }

  if (quote.status === "pending_approval") {
    return (
      <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs">
        <p className="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-300">
          <Clock className="h-4 w-4 shrink-0" aria-hidden="true" />
          Waiting for a manager to approve this quote.
        </p>
        <Reasons reasons={gate.data.reasons} />
        {isManager ? (
          rejecting ? (
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id={`reject-reason-${quote.id}`}
                autoFocus
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Reason for rejecting (required)"
                className="h-8 min-w-0 flex-1"
              />
              <Button
                size="sm"
                variant="destructive"
                className="h-8"
                disabled={busy || !reason.trim()}
                onClick={() => onDecide(false)}
              >
                Reject
              </Button>
              <Button size="sm" variant="ghost" className="h-8" onClick={() => setRejecting(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                className="h-8"
                disabled={busy || tooJunior}
                title={tooJunior && needs ? `Needs ${ROLE_LABELS[needs]} approval` : undefined}
                onClick={() => onDecide(true)}
              >
                {tooJunior && needs ? `Needs ${ROLE_LABELS[needs]}` : "Approve"}
              </Button>
              <Button size="sm" variant="outline" className="h-8" disabled={busy} onClick={() => setRejecting(true)}>
                Reject
              </Button>
            </div>
          )
        ) : null}
      </div>
    );
  }

  // Needs approval and has not got it: never asked, rejected, or the amount
  // changed after approval. The server's sentence says which.
  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/40 p-2.5 text-xs">
      <p className="flex items-center gap-2 font-medium">
        {quote.status === "rejected" ? (
          <XCircle className="h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
        ) : (
          <ShieldAlert className="h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
        )}
        {gate.data.reason ?? "This quote needs a manager’s approval before it can be sent."}
      </p>
      <Reasons reasons={gate.data.reasons} />
      <Button size="sm" variant="outline" className="h-8" disabled={busy} onClick={onRequest}>
        {quote.status === "rejected" ? "Ask for approval again" : "Request manager approval"}
      </Button>
    </div>
  );
}

/** Why a decision is needed: "Discount 8% over 5% cap", with the full sentence on hover. */
function Reasons({ reasons }: { reasons: QuoteApprovalReason[] }) {
  if (!reasons?.length) return null;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {reasons.map((r) => (
        <li
          key={r.code}
          title={r.message}
          className="rounded-full border border-amber-500/30 bg-background px-2 py-0.5 text-[11px] font-medium"
        >
          {approvalReasonLabel(r)}
        </li>
      ))}
    </ul>
  );
}
