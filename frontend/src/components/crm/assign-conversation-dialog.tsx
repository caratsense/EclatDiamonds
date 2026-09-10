"use client";

import { useState } from "react";
import { UserCog } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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
import { useAssignConversation } from "@/lib/queries/crm";
import { useStoresAdmin } from "@/lib/queries/stores";
import { useStaff } from "@/lib/queries/users";
import { apiErrorMessage } from "@/lib/utils";

/**
 * Route one conversation: destination location, owner and handling.
 *
 * ## Why all three in one dialog
 *
 * They are one decision, and the server treats them as one command. Letting a
 * user change the owner on one screen and the location on another is how a
 * thread ends up owned by somebody who does not work at the branch it sits in —
 * the exact state the server now refuses.
 *
 * ## The owner list is not filtered on the client
 *
 * It is FETCHED per destination (`/users?storeId=…`), so the list only ever
 * contains people who actually work there. If the destination changes, the
 * previously chosen owner is dropped rather than carried over into a branch
 * they do not belong to. The server validates this again regardless; this just
 * stops the UI offering a choice it knows will be refused.
 *
 * ## Radix `Select` cannot hold an empty value
 *
 * `SelectItem value=""` throws, so "no location" and "nobody" are carried as an
 * explicit NONE sentinel and mapped back to `null` on submit — `null` being what
 * the API means by "clear this", as distinct from an omitted field meaning
 * "leave it alone".
 */
const NONE = "__none__";

const HANDLING = [
  { value: "human", label: "A team member replies" },
  { value: "ai", label: "The assistant replies" },
  { value: "unassigned", label: "Nobody yet" },
] as const;

export function AssignConversationDialog({
  conversationId,
  current,
  trigger,
}: {
  conversationId: string;
  current: {
    storeId: string | null;
    assignedUserId: string | null;
    handling: string;
  };
  /** Rendered as the opener. Omit for the default button. */
  trigger?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <span onClick={() => setOpen(true)} role="presentation">
        {trigger ?? (
          <Button size="sm" variant="outline">
            <UserCog className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            Reassign
          </Button>
        )}
      </span>
      {/* Mounted only while open so the form starts from the CURRENT values
          every time, instead of whatever was typed and abandoned last time. */}
      {open && (
        <AssignForm
          conversationId={conversationId}
          current={current}
          onDone={() => setOpen(false)}
        />
      )}
    </>
  );
}

function AssignForm({
  conversationId,
  current,
  onDone,
}: {
  conversationId: string;
  current: { storeId: string | null; assignedUserId: string | null; handling: string };
  onDone: () => void;
}) {
  const [storeId, setStoreId] = useState(current.storeId ?? NONE);
  const [assigneeId, setAssigneeId] = useState(current.assignedUserId ?? NONE);
  const [handling, setHandling] = useState(current.handling);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const stores = useStoresAdmin();
  // Only real trading branches can own a conversation; the synthetic "All
  // Stores" aggregate is not a place anybody works.
  const options = (stores.data ?? []).filter((s) => !s.isAggregate);

  const destination = storeId === NONE ? null : storeId;
  // Disabled until a destination exists — asking the server for "staff at
  // nowhere" would return the caller's whole roster, which is precisely the
  // list we must not offer.
  const staff = useStaff(destination ?? undefined, { enabled: !!destination });
  const people = destination ? (staff.data ?? []).filter((u) => u.isActive) : [];

  const assign = useAssignConversation(conversationId);

  const onStoreChange = (next: string) => {
    setStoreId(next);
    // The chosen owner may not work at the new destination. Clearing is the only
    // honest default: silently keeping them would submit an assignment the
    // server is going to reject.
    if (next !== storeId) setAssigneeId(NONE);
    setError(null);
  };

  const submit = async () => {
    // Belt and braces against a double submit: the button is disabled while the
    // mutation is in flight, and this returns early if it fires anyway (a fast
    // double-press, an Enter key landing between renders).
    if (assign.isPending) return;
    setError(null);
    try {
      await assign.mutateAsync({
        storeId: destination,
        assignedUserId: assigneeId === NONE ? null : assigneeId,
        handling,
        reason: reason.trim() || undefined,
      });
      toast.success("Conversation reassigned");
      onDone();
    } catch (e) {
      // Shown IN the dialog, not only as a toast: the message is usually a
      // correction ("that person does not work at the destination location")
      // and the user needs it next to the field they have to change.
      setError(apiErrorMessage(e, "Could not reassign this conversation."));
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && !assign.isPending && onDone()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reassign conversation</DialogTitle>
          <DialogDescription>
            Location, owner and handling change together. An owner has to work at the
            destination.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="assign-store">Location</Label>
            <Select value={storeId} onValueChange={onStoreChange}>
              <SelectTrigger id="assign-store">
                <SelectValue placeholder="Choose a location" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>No location (central queue)</SelectItem>
                {options.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {stores.isError && (
              <p className="text-xs text-destructive">
                Could not load locations.{" "}
                <button type="button" className="underline" onClick={() => stores.refetch()}>
                  Retry
                </button>
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="assign-owner">Owner</Label>
            <Select
              value={assigneeId}
              onValueChange={(v) => {
                setAssigneeId(v);
                setError(null);
              }}
              disabled={!destination}
            >
              <SelectTrigger id="assign-owner">
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
            {destination && staff.isError && (
              <p className="text-xs text-destructive">
                Could not load team members for this location.{" "}
                <button type="button" className="underline" onClick={() => staff.refetch()}>
                  Retry
                </button>
              </p>
            )}
            {/* An empty roster is stated rather than left as a silent empty
                dropdown the user keeps reopening. */}
            {destination && !staff.isLoading && !staff.isError && people.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Nobody is assigned to this location yet.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="assign-handling">Who answers</Label>
            <Select value={handling} onValueChange={setHandling}>
              <SelectTrigger id="assign-handling">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HANDLING.map((h) => (
                  <SelectItem key={h.value} value={h.value}>
                    {h.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="assign-reason">Reason (optional)</Label>
            <Input
              id="assign-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this moving?"
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
          <Button variant="ghost" onClick={onDone} disabled={assign.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={assign.isPending}>
            {assign.isPending ? "Saving…" : "Reassign"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
