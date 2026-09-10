"use client";

import { useState } from "react";
import { AlertTriangle, ArrowRight, Check, History } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { Skeleton } from "@/components/ui/skeleton";
import {
  useResolveRoutingConflict,
  useRoutingConflicts,
  type RoutingConflict,
  type RoutingSide,
} from "@/lib/queries/crm";
import { useAuditLog } from "@/lib/queries/audit";
import { useStoresAdmin } from "@/lib/queries/stores";
import { useStaff } from "@/lib/queries/users";
import { ROLE_RANK } from "@/lib/types";
import { useSession } from "@/store/use-session";
import { apiErrorMessage } from "@/lib/utils";

/**
 * Routing conflicts on one conversation.
 *
 * ## What a conflict is
 *
 * A campaign rule wanted to send this thread somewhere other than where it
 * already is. The thread deliberately did NOT move — first ownership wins — and
 * this asks a person to decide. Nothing here reroutes anything on its own.
 *
 * ## Three decisions, and only three
 *
 * They are exactly what the server implements: keep what the thread has, take
 * what the rule proposed, or set it by hand. Every one of them goes through the
 * same `assign()` the reassign dialog uses, so the destination is scope-checked
 * and the owner is membership-checked once, in one place, whichever button was
 * pressed.
 *
 * ## Resolved conflicts stay
 *
 * They are the record of a decision somebody made about a customer. They are
 * listed as history and never deleted — the server has no endpoint that could.
 */
const NONE = "__none__";

const DECISION_LABEL: Record<NonNullable<RoutingConflict["resolution"]>, string> = {
  kept_original: "Kept the original routing",
  accepted_proposed: "Accepted the proposed routing",
  manual: "Set by hand",
};

export function RoutingConflictPanel({ conversationId }: { conversationId: string }) {
  const role = useSession((s) => s.role);
  // The server is the authority: it requires store_manager+ to resolve. This
  // only decides whether to render buttons that would 403 — it is not the check.
  const canResolve = ROLE_RANK[role] >= ROLE_RANK.store_manager;

  const { data, isLoading, isError, error, refetch } = useRoutingConflicts({
    state: "all",
    conversationId,
  });

  if (isLoading) return <Skeleton className="h-24 w-full" />;

  if (isError) {
    return (
      <Card>
        <CardContent className="flex items-center justify-between gap-3 pt-6">
          <p className="text-sm text-destructive">
            {apiErrorMessage(error, "Could not load routing history.")}
          </p>
          <Button size="sm" variant="outline" onClick={() => refetch()}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  const conflicts = data ?? [];
  if (conflicts.length === 0) return null;

  const open = conflicts.filter((c) => !c.resolution);
  const resolved = conflicts.filter((c) => c.resolution);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {open.length > 0 ? (
            <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden="true" />
          ) : (
            <History className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          )}
          Routing {open.length > 0 ? "needs a decision" : "history"}
          {open.length > 0 && <Badge variant="secondary">{open.length}</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {open.map((c) => (
          <OpenConflict
            key={c.id}
            conflict={c}
            conversationId={conversationId}
            canResolve={canResolve}
          />
        ))}

        {resolved.length > 0 && (
          <div className="space-y-2 border-t pt-3">
            <p className="text-xs font-medium text-muted-foreground">Past decisions</p>
            {resolved.map((c) => (
              <ResolvedConflict key={c.id} conflict={c} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** One unresolved conflict: what it has, what was proposed, and the decision. */
function OpenConflict({
  conflict,
  conversationId,
  canResolve,
}: {
  conflict: RoutingConflict;
  conversationId: string;
  canResolve: boolean;
}) {
  const [confirming, setConfirming] = useState<"kept_original" | "accepted_proposed" | null>(null);
  const [manual, setManual] = useState(false);

  return (
    <div className="rounded-md border border-amber-300/60 bg-amber-50/40 p-3 dark:bg-amber-950/10">
      <p className="text-sm">
        A campaign rule pointed this conversation at a different location. It has not
        moved.
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Noticed {new Date(conflict.detectedAt).toLocaleString()}
        {conflict.sourceAdId ? ` · from ad ${conflict.sourceAdId}` : ""}
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto_1fr]">
        <SideBlock title="Now" side={conflict.original} handling={conflict.originalHandling} />
        <div className="hidden items-center justify-center sm:flex">
          <ArrowRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        </div>
        <SideBlock
          title="Proposed"
          side={conflict.proposed}
          handling={conflict.proposedHandling}
        />
      </div>

      {canResolve ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setConfirming("kept_original")}>
            Keep as is
          </Button>
          <Button size="sm" onClick={() => setConfirming("accepted_proposed")}>
            Accept proposed
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setManual(true)}>
            Set by hand…
          </Button>
        </div>
      ) : (
        // Stated, not silently hidden: the person looking at this needs to know
        // why they cannot act, and who can.
        <p className="mt-3 text-xs text-muted-foreground">
          A manager has to decide this one.
        </p>
      )}

      {confirming && (
        <ConfirmDecision
          conflict={conflict}
          conversationId={conversationId}
          decision={confirming}
          onDone={() => setConfirming(null)}
        />
      )}
      {manual && (
        <ManualRouting
          conflict={conflict}
          conversationId={conversationId}
          onDone={() => setManual(false)}
        />
      )}
    </div>
  );
}

function SideBlock({
  title,
  side,
  handling,
}: {
  title: string;
  side: RoutingSide;
  handling: string | null;
}) {
  return (
    <div className="rounded-md border bg-background p-2 text-xs">
      <p className="font-medium text-muted-foreground">{title}</p>
      {/* A missing name means the record was removed, and says so — it is never
          filled in with the raw id or a guess. */}
      <p className="mt-1">
        <span className="text-muted-foreground">Location: </span>
        {side.storeName ?? (side.storeId ? "(removed)" : "none")}
      </p>
      <p>
        <span className="text-muted-foreground">Owner: </span>
        {side.assignedUserName ?? (side.assignedUserId ? "(removed)" : "nobody")}
      </p>
      <p>
        <span className="text-muted-foreground">Answered by: </span>
        {handling ?? "—"}
      </p>
      {side.ruleName && (
        <p>
          <span className="text-muted-foreground">Rule: </span>
          {side.ruleName}
        </p>
      )}
    </div>
  );
}

/**
 * Confirmation before a state-changing decision.
 *
 * "Accept proposed" moves a live conversation, and its owner's work, to another
 * branch. That is not something a mis-aimed click should be able to do.
 */
function ConfirmDecision({
  conflict,
  conversationId,
  decision,
  onDone,
}: {
  conflict: RoutingConflict;
  conversationId: string;
  decision: "kept_original" | "accepted_proposed";
  onDone: () => void;
}) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const resolve = useResolveRoutingConflict(conversationId);

  const submit = async () => {
    if (resolve.isPending) return;
    setError(null);
    try {
      await resolve.mutateAsync({ conflictId: conflict.id, decision, note: note.trim() || undefined });
      toast.success(DECISION_LABEL[decision]);
      onDone();
    } catch (e) {
      setError(apiErrorMessage(e, "Could not record that decision."));
    }
  };

  const moving = decision === "accepted_proposed";

  return (
    <Dialog open onOpenChange={(v) => !v && !resolve.isPending && onDone()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{moving ? "Accept the proposed routing?" : "Keep the current routing?"}</DialogTitle>
          <DialogDescription>
            {moving
              ? `This conversation moves to ${
                  conflict.proposed.storeName ?? "the proposed location"
                }${
                  conflict.proposed.assignedUserName
                    ? ` and is owned by ${conflict.proposed.assignedUserName}`
                    : ""
                }.`
              : "Nothing about the conversation changes. The conflict is recorded as decided."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor="conflict-note">Note (optional)</Label>
          <Input
            id="conflict-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why?"
            maxLength={500}
          />
        </div>

        {error && (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onDone} disabled={resolve.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={resolve.isPending}>
            {resolve.isPending ? "Saving…" : moving ? "Move it" : "Keep it"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The third decision: neither side, a destination chosen by a person.
 *
 * Sends both fields explicitly. An omitted field means "leave it alone" to the
 * server, so a form that quietly skipped one would look like it had cleared it.
 */
function ManualRouting({
  conflict,
  conversationId,
  onDone,
}: {
  conflict: RoutingConflict;
  conversationId: string;
  onDone: () => void;
}) {
  const [storeId, setStoreId] = useState(conflict.conversation.storeId ?? NONE);
  const [assigneeId, setAssigneeId] = useState(conflict.conversation.assignedUserId ?? NONE);
  const [handling, setHandling] = useState(conflict.conversation.handling);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const stores = useStoresAdmin();
  const destination = storeId === NONE ? null : storeId;
  const staff = useStaff(destination ?? undefined, { enabled: !!destination });
  const people = destination ? (staff.data ?? []).filter((u) => u.isActive) : [];

  const resolve = useResolveRoutingConflict(conversationId);

  const submit = async () => {
    if (resolve.isPending) return;
    setError(null);
    try {
      await resolve.mutateAsync({
        conflictId: conflict.id,
        decision: "manual",
        storeId: destination,
        assignedUserId: assigneeId === NONE ? null : assigneeId,
        handling,
        note: note.trim() || undefined,
      });
      toast.success("Routing set");
      onDone();
    } catch (e) {
      setError(apiErrorMessage(e, "Could not set the routing."));
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && !resolve.isPending && onDone()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Set the routing by hand</DialogTitle>
          <DialogDescription>
            Neither the current nor the proposed routing. An owner has to work at the
            destination.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="manual-store">Location</Label>
            <Select
              value={storeId}
              onValueChange={(v) => {
                setStoreId(v);
                if (v !== storeId) setAssigneeId(NONE);
                setError(null);
              }}
            >
              <SelectTrigger id="manual-store">
                <SelectValue placeholder="Choose a location" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>No location (central queue)</SelectItem>
                {(stores.data ?? [])
                  .filter((s) => !s.isAggregate)
                  .map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="manual-owner">Owner</Label>
            <Select value={assigneeId} onValueChange={setAssigneeId} disabled={!destination}>
              <SelectTrigger id="manual-owner">
                <SelectValue
                  placeholder={destination ? "Choose a team member" : "Pick a location first"}
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Nobody</SelectItem>
                {people.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="manual-handling">Who answers</Label>
            <Select value={handling} onValueChange={setHandling}>
              <SelectTrigger id="manual-handling">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="human">A team member replies</SelectItem>
                <SelectItem value="ai">The assistant replies</SelectItem>
                <SelectItem value="unassigned">Nobody yet</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="manual-note">Note (optional)</Label>
            <Input
              id="manual-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why?"
              maxLength={500}
            />
          </div>

          {error && (
            <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onDone} disabled={resolve.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={resolve.isPending}>
            {resolve.isPending ? "Saving…" : "Set routing"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Who moved this conversation, when, and why — straight from the audit log.
 *
 * Reads the existing `/audit` endpoint rather than inventing a second history:
 * `assign()` and `resolveRoutingConflict()` already write `conversation.assigned`
 * and `conversation.routing_conflict_resolved` rows against this conversation id.
 *
 * Those rows used to carry no location, and audit reads only surface
 * location-less rows to head office — so the manager whose branch a thread had
 * just left or joined could not see the move at all. They are stamped with the
 * branch now, which is what makes this panel worth rendering for anyone below
 * head office.
 *
 * `useAuditLog` disables itself below store manager and the server refuses it
 * too, so this simply renders nothing for a salesperson.
 */
export function RoutingAuditTrail({ conversationId }: { conversationId: string }) {
  const role = useSession((s) => s.role);
  const canView = ROLE_RANK[role] >= ROLE_RANK.store_manager;
  const { data, isLoading, isError } = useAuditLog({
    entityType: "Conversation",
    entityId: conversationId,
    pageSize: 10,
  });

  if (!canView || isLoading) return null;
  // A failed audit read is not worth a red banner on a working screen — the
  // conversation itself is unaffected, and the panel simply does not appear.
  if (isError || !data?.items.length) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          Routing history
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {data.items.map((e) => (
          <div key={e.id} className="rounded-md border bg-muted/20 px-3 py-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{e.actorName}</span>
              <span className="text-muted-foreground">{new Date(e.createdAt).toLocaleString()}</span>
              {e.storeName && <Badge variant="outline" className="text-[10px]">{e.storeName}</Badge>}
            </div>
            <p className="mt-1 text-muted-foreground">{e.summary}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/** A decision already made. Read-only, and it stays here permanently. */
function ResolvedConflict({ conflict }: { conflict: RoutingConflict }) {
  return (
    <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Check className="h-3 w-3 text-emerald-600" aria-hidden="true" />
        <span className="font-medium">{DECISION_LABEL[conflict.resolution!]}</span>
        {conflict.resolvedBy && (
          <span className="text-muted-foreground">by {conflict.resolvedBy.name}</span>
        )}
        {conflict.resolvedAt && (
          <span className="text-muted-foreground">
            · {new Date(conflict.resolvedAt).toLocaleString()}
          </span>
        )}
      </div>
      <p className="mt-1 text-muted-foreground">
        {conflict.original.storeName ?? "no location"} →{" "}
        {conflict.proposed.storeName ?? "no location"}
        {conflict.sourceAdId ? ` · ad ${conflict.sourceAdId}` : ""}
      </p>
      {conflict.resolutionNote && <p className="mt-1 italic">“{conflict.resolutionNote}”</p>}
    </div>
  );
}
