"use client";

import { useState } from "react";
import { ArrowUpCircle, Check, MessageSquare, X } from "lucide-react";
import { toast } from "sonner";

import {
  RequestPriorityBadge,
  RequestStatusBadge,
} from "@/components/requests/request-badges";
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
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { formatINR } from "@/lib/format";
import {
  useAddRequestMessage,
  useCancelSpecialRequest,
  useDecideSpecialRequest,
  useEscalateSpecialRequest,
  useSpecialRequest,
} from "@/lib/queries/special-requests";
import { apiErrorMessage } from "@/lib/utils";

function prettyDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * A request in full: what was asked, where it sits, the conversation, and the
 * actions available to THIS viewer.
 *
 * Which buttons show is driven by the server's `canDecide` / `canEscalate` /
 * `canCancel` flags rather than a client-side reimplementation of the ladder —
 * so the UI and the API can never disagree about who may act.
 */
export function RequestDetailDialog({
  id,
  open,
  onOpenChange,
}: {
  id: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: r, isLoading } = useSpecialRequest(open ? id : null);
  const decide = useDecideSpecialRequest();
  const escalate = useEscalateSpecialRequest();
  const cancel = useCancelSpecialRequest();
  const addMessage = useAddRequestMessage();

  const [note, setNote] = useState("");
  const [approvedRate, setApprovedRate] = useState("");
  const [message, setMessage] = useState("");

  // Reset the action form when a different request opens (React's documented
  // "state derived from props" adjustment, not an effect).
  const [lastId, setLastId] = useState(id);
  if (lastId !== id) {
    setLastId(id);
    setNote("");
    setApprovedRate("");
    setMessage("");
  }

  const busy = decide.isPending || escalate.isPending || cancel.isPending;

  function submitDecision(status: "approved" | "rejected") {
    if (!r) return;
    decide.mutate(
      {
        id: r.id,
        status,
        note: note.trim() || undefined,
        approvedRatePerCarat:
          status === "approved" && r.kind === "diamond_rate" && approvedRate
            ? Number(approvedRate)
            : undefined,
      },
      {
        onSuccess: (updated) => {
          toast.success(
            `${updated.ref} ${status}`,
            status === "approved" && updated.kind === "diamond_rate"
              ? {
                  description: `${updated.diamondSpec} now ${formatINR(
                    updated.requestedRatePerCarat ?? 0,
                  )}/carat at ${updated.storeName}.`,
                }
              : undefined,
          );
          setNote("");
          setApprovedRate("");
          onOpenChange(false);
        },
        onError: (err: unknown) =>
          toast.error(apiErrorMessage(err, "Could not record the decision.")),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-lg">
        {isLoading || !r ? (
          <div className="space-y-3 py-4">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex flex-wrap items-center gap-2">
                {r.ref}
                <Badge variant="outline">{r.kindLabel}</Badge>
                <RequestStatusBadge status={r.status} />
                <RequestPriorityBadge priority={r.priority} />
                {r.overdue ? <Badge variant="destructive">Overdue</Badge> : null}
              </DialogTitle>
              <DialogDescription>
                {r.requestedByName} · {r.storeName} · {prettyDateTime(r.createdAt)}
              </DialogDescription>
            </DialogHeader>

            <div>
              <p className="text-sm font-medium">{r.title}</p>
              {r.details ? (
                <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                  {r.details}
                </p>
              ) : null}
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              {r.kind === "diamond_rate" ? (
                <>
                  <Field label="Diamond spec">{r.diamondSpec ?? "—"}</Field>
                  <Field label="Rate requested">
                    <span className="num">
                      {r.requestedRatePerCarat != null
                        ? `${formatINR(r.requestedRatePerCarat)}/ct`
                        : "—"}
                    </span>
                  </Field>
                  <Field label="Current rate">
                    <span className="num">
                      {r.currentRatePerCarat != null
                        ? `${formatINR(r.currentRatePerCarat)}/ct`
                        : "Not set"}
                    </span>
                  </Field>
                </>
              ) : null}
              {r.amount != null ? (
                <Field label="Value">
                  <span className="num">{formatINR(r.amount)}</span>
                </Field>
              ) : null}
              {r.neededBy ? (
                <Field label="Needed by">
                  <span className={r.overdue ? "num text-destructive" : "num"}>
                    {r.neededBy}
                  </span>
                </Field>
              ) : null}
              <Field label={r.decidedAt ? "Decided by" : "Waiting on"}>
                {r.decidedAt ? (r.decidedBy ?? "—") : r.requiredRoleLabel}
              </Field>
            </dl>

            {r.decisionNote ? (
              <p className="rounded-lg border bg-muted/30 p-2.5 text-xs">
                <span className="font-medium">Decision note:</span> {r.decisionNote}
              </p>
            ) : null}

            {/* --- Actions available to THIS viewer --------------------- */}
            {r.canDecide ? (
              <>
                <Separator />
                <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
                  <p className="text-xs font-medium text-muted-foreground">
                    Your decision
                  </p>

                  {r.kind === "diamond_rate" ? (
                    <div className="grid gap-1.5">
                      <Label htmlFor="approved-rate">
                        Approve at (₹/carat)
                      </Label>
                      <Input
                        id="approved-rate"
                        type="number"
                        min={0}
                        placeholder={
                          r.requestedRatePerCarat != null
                            ? `${r.requestedRatePerCarat} (as requested)`
                            : "Rate per carat"
                        }
                        value={approvedRate}
                        onChange={(e) => setApprovedRate(e.target.value)}
                      />
                      <p className="text-[11px] text-muted-foreground">
                        Leave blank to approve exactly what was asked for. Setting
                        a number here publishes that rate for {r.storeName}.
                      </p>
                    </div>
                  ) : null}

                  <div className="grid gap-1.5">
                    <Label htmlFor="decision-note">Note</Label>
                    <Textarea
                      id="decision-note"
                      rows={2}
                      placeholder="Explain the decision — the branch sees this."
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                    />
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="gold"
                      size="sm"
                      disabled={busy}
                      onClick={() => submitDecision("approved")}
                    >
                      <Check className="h-4 w-4" />
                      Approve
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={busy}
                      onClick={() => submitDecision("rejected")}
                    >
                      <X className="h-4 w-4" />
                      Reject
                    </Button>
                    {r.canEscalate ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        // For the approver who CAN decide but shouldn't — without
                        // this the only options are yes, no, or leave it sitting.
                        onClick={() =>
                          escalate.mutate(
                            { id: r.id, note: note.trim() || undefined },
                            {
                              onSuccess: (u) =>
                                toast.success(
                                  `Escalated to ${u.requiredRoleLabel}`,
                                ),
                              onError: (err: unknown) =>
                                toast.error(
                                  apiErrorMessage(err, "Could not escalate."),
                                ),
                            },
                          )
                        }
                      >
                        <ArrowUpCircle className="h-4 w-4" />
                        Escalate
                      </Button>
                    ) : null}
                  </div>
                </div>
              </>
            ) : null}

            {r.canCancel ? (
              <Button
                variant="outline"
                size="sm"
                className="w-fit"
                disabled={busy}
                onClick={() =>
                  cancel.mutate(
                    { id: r.id },
                    {
                      onSuccess: () => {
                        toast.success("Request withdrawn");
                        onOpenChange(false);
                      },
                      onError: (err: unknown) =>
                        toast.error(apiErrorMessage(err, "Could not withdraw.")),
                    },
                  )
                }
              >
                Withdraw request
              </Button>
            ) : null}

            {/* --- Thread ---------------------------------------------- */}
            <Separator />
            <div>
              <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <MessageSquare className="h-3.5 w-3.5" />
                Conversation
              </p>
              {r.messages.length === 0 ? (
                <p className="rounded-lg border border-dashed py-4 text-center text-xs text-muted-foreground">
                  No messages yet. Ask a question if you need more before deciding.
                </p>
              ) : (
                <ol className="space-y-2.5">
                  {r.messages.map((m) => (
                    <li key={m.id} className="rounded-lg border bg-card p-2.5">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-xs font-medium">{m.authorName}</span>
                        <span className="num text-[11px] text-muted-foreground">
                          {prettyDateTime(m.createdAt)}
                        </span>
                      </div>
                      <p className="mt-0.5 whitespace-pre-wrap text-sm">{m.body}</p>
                    </li>
                  ))}
                </ol>
              )}

              <div className="mt-3 flex gap-2">
                <Input
                  placeholder="Write a message…"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && message.trim()) {
                      e.preventDefault();
                      addMessage.mutate(
                        { id: r.id, body: message.trim() },
                        { onSuccess: () => setMessage("") },
                      );
                    }
                  }}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!message.trim() || addMessage.isPending}
                  onClick={() =>
                    addMessage.mutate(
                      { id: r.id, body: message.trim() },
                      { onSuccess: () => setMessage("") },
                    )
                  }
                >
                  Send
                </Button>
              </div>
            </div>
          </>
        )}
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
