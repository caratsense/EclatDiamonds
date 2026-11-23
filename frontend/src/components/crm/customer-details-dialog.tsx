"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
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
import { useLinkContact } from "@/lib/queries/crm";
import { useRenameParty } from "@/lib/queries/parties";
import { ROLE_RANK } from "@/lib/types";
import { useSession } from "@/store/use-session";
import { apiErrorMessage } from "@/lib/utils";

/**
 * The detail this customer is actually reached on, for display beside the edit
 * that writes it.
 *
 * Three sources, in this order and for this reason:
 *
 *  1. a contact point somebody marked PRIMARY — the most recent deliberate
 *     statement of "this is their number", and the thing `CustomerDetailsDialog`
 *     writes. Without this first, a corrected number would be saved and the
 *     panel would carry on showing the old one, which is a worse bug than the
 *     dead Edit link it replaced;
 *  2. the `Party` snapshot, which is what the directory, exports and every
 *     other screen show — so it outranks a contact point nobody chose;
 *  3. any contact point of the right kind, as the last honest answer.
 *
 * Null when there is genuinely nothing on file. Render that as "Not provided":
 * the panel used to print `name.toLowerCase() + "@gmail.com"` for the email and
 * a literal `+91 91900000101` for the phone, which read as fact and were
 * nobody's address.
 */
export function primaryContactValue(
  contactPoints: { kind: string; value: string; isPrimary: boolean }[] | undefined,
  kinds: string[],
  fallback: string | null,
): string | null {
  const points = (contactPoints ?? []).filter((c) => kinds.includes(c.kind));
  const chosen = kinds
    .map((kind) => points.find((c) => c.kind === kind && c.isPrimary))
    .find(Boolean);
  if (chosen) return chosen.value;
  if (fallback?.trim()) return fallback;
  return points[0]?.value ?? null;
}

/**
 * What `POST /crm/customers/:id/contacts` answers.
 *
 * `conflict` comes back 200, not as an error, and it is the one outcome that
 * must never be reported as a save: the number belongs to somebody else, so
 * NOTHING was changed and a merge review was raised for a person to decide.
 */
interface LinkContactResult {
  status: "linked" | "already_linked" | "conflict";
  message?: string;
}

/**
 * Change a person's details from the conversation they are in.
 *
 * ## What used to be here
 *
 * An "Edit" link pointing at `/customers/<id>`, which is a read-only profile —
 * it has no edit form of any kind. So the affordance was real, the destination
 * was real, and there was still no way to correct a name anywhere along the
 * path. The client's report ("no working way to change a person's information
 * from here") was exactly accurate.
 *
 * ## Three fields, two endpoints, and why
 *
 * The name goes through `PATCH /parties/:id` — the rename the customer
 * directory already uses, not a new endpoint. It is `@Roles('store_manager')`,
 * because the name is what every colleague's list, export and campaign will
 * show rather than a private note, so the field is disabled below that rank
 * instead of being offered and refused.
 *
 * The number and the email go through `POST /crm/customers/:id/contacts`, which
 * records a contact detail against the customer and makes it their primary one.
 * The previous value STAYS ON FILE as a non-primary way to reach them, and that
 * is deliberate rather than a shortcut: the WhatsApp thread you are reading is
 * threaded on the old number, so deleting it would orphan the conversation.
 * The dialog says so rather than implying the old one is gone.
 */
export function CustomerDetailsDialog({
  open,
  onOpenChange,
  partyId,
  name,
  phone,
  email,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  partyId: string;
  name: string;
  phone: string | null;
  email: string | null;
}) {
  const qc = useQueryClient();
  const rename = useRenameParty();
  const link = useLinkContact(partyId);
  const role = useSession((s) => s.role);
  const canRename = ROLE_RANK[role] >= ROLE_RANK.store_manager;

  const [nextName, setNextName] = useState(name);
  const [nextPhone, setNextPhone] = useState(phone ?? "");
  const [nextEmail, setNextEmail] = useState(email ?? "");

  // Reopening on another customer must not carry the last one's details. Keyed
  // on the id rather than on `open` so a re-render while the dialog is up does
  // not throw away what is being typed.
  const [shownFor, setShownFor] = useState(partyId);
  if (partyId !== shownFor) {
    setShownFor(partyId);
    setNextName(name);
    setNextPhone(phone ?? "");
    setNextEmail(email ?? "");
  }

  const trimmedName = nextName.trim();
  const trimmedPhone = nextPhone.trim();
  const trimmedEmail = nextEmail.trim();

  const nameChanged = canRename && trimmedName !== name && trimmedName.length > 0;
  const phoneChanged = trimmedPhone !== (phone ?? "") && trimmedPhone.length > 0;
  const emailChanged = trimmedEmail !== (email ?? "") && trimmedEmail.length > 0;
  const pending = rename.isPending || link.isPending;

  /**
   * Everything this customer's name appears on, once it has changed.
   *
   * `useRenameParty` already refreshes the directory, search and Customer 360 —
   * it was written for the customers screen and knows nothing about the inbox.
   * The conversation list and the open thread are headed by the same name, so
   * without this the panel updates and the two panes beside it keep showing
   * what the person was called a second ago.
   */
  const refreshEverywhere = () => {
    void qc.invalidateQueries({ queryKey: ["crm", "conversations"] });
    void qc.invalidateQueries({ queryKey: ["crm", "conversation"] });
    void qc.invalidateQueries({ queryKey: ["crm", "customer360", partyId] });
  };

  async function save() {
    /*
     * Applied one at a time, and reported one at a time. The three fields are
     * three different server calls with three different ways of refusing — a
     * name the server rejects as unreadable, a number that belongs to another
     * customer — so a single "Saved" over the top of them would be a claim
     * about work that may not all have happened.
     */
    const done: string[] = [];
    try {
      if (nameChanged) {
        await rename.mutateAsync({ id: partyId, name: trimmedName });
        done.push("name");
      }
      if (phoneChanged) {
        const res: LinkContactResult = await link.mutateAsync({
          kind: "phone",
          value: trimmedPhone,
          isPrimary: true,
        });
        if (res.status === "conflict") {
          toast.error(res.message ?? "That number already belongs to another customer.");
        } else {
          done.push("number");
        }
      }
      if (emailChanged) {
        const res: LinkContactResult = await link.mutateAsync({
          kind: "email",
          value: trimmedEmail,
          isPrimary: true,
        });
        if (res.status === "conflict") {
          toast.error(res.message ?? "That email already belongs to another customer.");
        } else {
          done.push("email");
        }
      }
    } catch (e) {
      toast.error(apiErrorMessage(e, "Could not save those details."));
      // Whatever landed before the failure is still real, so the screen is
      // refreshed to show it rather than left disagreeing with the server.
      if (done.length) refreshEverywhere();
      return;
    }

    // Nothing accepted means every change asked for was a conflict, which has
    // already said so in its own words — the dialog stays open so the number
    // can be corrected rather than closing on a failure.
    if (!done.length) return;
    refreshEverywhere();
    toast.success(`Saved their ${done.join(" and ")}.`);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">Edit {name}</DialogTitle>
          <DialogDescription className="text-xs">
            These are the customer&apos;s own details, so every colleague&apos;s list,
            export and campaign will show them.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="cust-name" className="text-xs">
              Name
            </Label>
            <Input
              id="cust-name"
              value={nextName}
              disabled={!canRename}
              onChange={(e) => setNextName(e.target.value)}
              placeholder="e.g. Priya Shah"
            />
            {canRename ? (
              /* The server applies the same guard the add-customer form does, so
                 a "name" of "9825012345" or "..." is refused. Said here rather
                 than discovered after pressing Save. */
              <p className="text-[11px] text-muted-foreground">
                A readable name — a phone number or punctuation is refused.
              </p>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                Renaming a customer is a manager&apos;s change, so this is read-only
                for you. The number and email below are not.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cust-phone" className="text-xs">
              Phone number
            </Label>
            <Input
              id="cust-phone"
              value={nextPhone}
              inputMode="tel"
              autoComplete="tel"
              onChange={(e) => setNextPhone(e.target.value)}
              placeholder="e.g. 9876543210"
            />
            <p className="text-[11px] text-muted-foreground">
              Becomes the number this customer is reached on. The old one stays on
              file — this WhatsApp conversation still runs on it.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cust-email" className="text-xs">
              Email
            </Label>
            <Input
              id="cust-email"
              value={nextEmail}
              type="email"
              autoComplete="email"
              onChange={(e) => setNextEmail(e.target.value)}
              placeholder="e.g. priya@example.com"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={save}
            disabled={pending || !(nameChanged || phoneChanged || emailChanged)}
          >
            {pending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
