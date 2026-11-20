"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Archive } from "lucide-react";
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
import { useArchiveParty } from "@/lib/queries/parties";
import { ROLE_RANK } from "@/lib/types";
import { apiErrorMessage } from "@/lib/utils";
import { useSession } from "@/store/use-session";

/**
 * Take a contact out of the working lists — the meeting's "remove blocked
 * contacts". Archive, not delete: the history stays, the contact stops being
 * messaged and stops appearing in lists, and Customers → Archived can restore it.
 *
 * Store manager and above; the API refuses anyone else, so the button is not
 * shown to them.
 */
export function ArchiveContactButton({ partyId, name }: { partyId: string; name: string }) {
  const role = useSession((s) => s.role);
  const router = useRouter();
  const archive = useArchiveParty();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  if (ROLE_RANK[role] < ROLE_RANK.store_manager) return null;

  const submit = () =>
    archive.mutate(
      { id: partyId, reason: reason.trim() },
      {
        onSuccess: () => {
          toast.success(`${name} archived`, { description: "Restore it any time from Customers → Archived." });
          setOpen(false);
          router.push("/customers");
        },
        onError: (e) => toast.error(apiErrorMessage(e, "Could not archive this contact.")),
      },
    );

  return (
    <>
      <Button size="sm" variant="outline" className="h-8 gap-1.5 text-destructive" onClick={() => setOpen(true)}>
        <Archive className="h-3.5 w-3.5" />
        Archive contact
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Archive {name}?</DialogTitle>
            <DialogDescription>
              They stop appearing in lists and stop receiving messages. Their history is kept and
              they can be restored from Customers → Archived.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="archive-reason">
              Reason <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="archive-reason"
              rows={2}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Blocked our number / asked us to stop messaging"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={!reason.trim() || archive.isPending} onClick={submit}>
              {archive.isPending ? "Archiving…" : "Archive"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
