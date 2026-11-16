"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useRequestPartyDeletion } from "@/lib/queries/parties";
import { ROLE_RANK } from "@/lib/types";
import { apiErrorMessage } from "@/lib/utils";
import { useSession } from "@/store/use-session";

/**
 * Ask for a customer to be removed (client, 16 Nov).
 *
 * Shown to EVERY role, unlike Archive beside it, which is manager-and-above.
 * That is the point of the client's ask: the person who knows the record is
 * wrong is usually the one who cannot act on it, so the floor raises it and
 * somebody above them decides. A salesperson's goes to their manager, a
 * manager's to head office.
 *
 * The dialog does not promise deletion, because the server may not be able to
 * deliver it: a customer with any history is archived instead, and the reply
 * says which happened. Promising "delete" and archiving would be the kind of
 * half-truth that makes people stop trusting the button.
 */
export function RequestDeletionButton({
  partyId,
  name,
}: {
  partyId: string;
  name: string;
}) {
  const role = useSession((s) => s.role);
  const request = useRequestPartyDeletion();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  // Head office can already remove a customer outright, so for them this would
  // be a slower route to the same place.
  if (ROLE_RANK[role] >= ROLE_RANK.head_office) return null;

  const approver =
    ROLE_RANK[role] >= ROLE_RANK.store_manager ? "head office" : "your store manager";

  const submit = () =>
    request.mutate(
      { id: partyId, reason: reason.trim() },
      {
        onSuccess: (r) => {
          toast.success(`Sent to ${approver}`, {
            description:
              `${r.request.ref} — if approved, ${name} will be ` +
              (r.outcome === "delete"
                ? "deleted."
                : `archived${r.held ? ` (they have ${r.held})` : ""}.`),
          });
          setOpen(false);
          setReason("");
        },
        onError: (e) =>
          toast.error(apiErrorMessage(e, "Could not send that request.")),
      },
    );

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="h-8 gap-1.5 text-destructive"
        onClick={() => setOpen(true)}
      >
        <Trash2 className="h-3.5 w-3.5" />
        Request deletion
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Ask to remove {name}?</DialogTitle>
            <DialogDescription>
              This goes to {approver} for approval — nothing happens until they
              agree. A customer with any history is archived rather than
              deleted, so their sales and payments stay true.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="deletion-reason">
              Why should they be removed? <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="deletion-reason"
              rows={2}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Duplicate of another record / entered by mistake"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={reason.trim().length < 3 || request.isPending}
              onClick={submit}
            >
              {request.isPending ? "Sending…" : `Send to ${approver}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
