"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MessageCircle } from "lucide-react";
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
import { TemplatePicker, type PickedTemplate } from "@/components/campaigns/template-picker";
import { CustomerRecognition } from "@/components/crm/customer-recognition";
import { TagsPicker } from "@/components/crm/lead-tags-field";
import {
  ThreadStartError,
  useCustomerLookup,
  useStartWhatsAppThread,
  type AppliedTags,
  type ResolvedCustomer,
} from "@/lib/queries/crm";
import { apiErrorMessage, normalizeCustomerPhone } from "@/lib/utils";
import { useSession } from "@/store/use-session";

/**
 * The value the branch picker carries for "no branch at all".
 *
 * A sentinel rather than "" because Radix refuses an empty option value, and a
 * sentinel rather than simply leaving the field unset because NO BRANCH IS A
 * REAL ANSWER here: a customer nobody has claimed sits in the head-office
 * queue, and head office picking their own branch would be the wrong record.
 * Never collides with a store id, which is a cuid.
 */
const NO_BRANCH = "none";

export interface BranchChoice {
  id: string;
  name: string;
}

/**
 * The branches this person may file a customer at, and the one to open on.
 *
 * INTERSECTS the caller's scope, never substitutes for it: the options are the
 * branches `/auth/me` gave them, which is the same set `assertStore` checks on
 * the server, so a salesperson cannot file a customer at a branch they cannot
 * see. The synthetic "All Stores" row is dropped — it is a way of LOOKING at
 * every branch, not a place a customer lives, and the server refuses it.
 *
 * The default is the branch in the top bar because that is almost always the
 * right one. On "All Stores" there is no such branch, so it opens on no branch
 * — which for head office is exactly where an unclaimed customer belongs.
 */
export function branchChoices(
  stores: { id: string; name: string; isAggregate?: boolean }[],
  currentStore: { id: string; isAggregate?: boolean },
): { options: BranchChoice[]; initial: string } {
  const options = stores
    .filter((s) => !s.isAggregate)
    .map((s) => ({ id: s.id, name: s.name }));
  const inScope = options.some((o) => o.id === currentStore.id);
  return {
    options,
    initial: !currentStore.isAggregate && inScope ? currentStore.id : NO_BRANCH,
  };
}

/**
 * What to say about the customer record after the message is away.
 *
 * Said out loud because it is the one outcome somebody who just typed a name
 * and chose a branch would otherwise misread: the number was already on file,
 * so the details THEY entered were not written and the thread is headed by
 * what a colleague recorded. "We opened their thread" and "we created this
 * customer" need to read differently.
 */
export function sendOutcomeNote(
  customer: ResolvedCustomer | undefined,
  tags: AppliedTags | undefined,
): string | undefined {
  const parts: string[] = [];
  if (customer?.outcome === "matched") {
    parts.push(
      "That number is already a customer — their thread was opened and their record left as it is.",
    );
  } else if (customer?.outcome === "created") {
    parts.push("Saved as a new customer.");
  } else if (customer?.outcome === "unresolved" && customer.reason) {
    parts.push(customer.reason);
  }
  if (tags?.failed) {
    parts.push(`The tags were not applied — ${tags.failed}`);
  } else if (tags?.added.length) {
    parts.push(`Tagged ${tags.added.join(", ")}.`);
  }
  return parts.length ? parts.join(" ") : undefined;
}

/**
 * Message a customer who has never written in.
 *
 * ## Why a template, and not a text box
 *
 * Every other send door in this product replies INTO a thread somebody else
 * started, which is why they can offer a plain message box: a customer who
 * just wrote has an open 24-hour customer-care window, and free text is
 * allowed inside it. A number that has never messaged has no window, so the
 * first thing out is an approved template or it is refused — the server
 * answers a bare body with "An approved WhatsApp template is required outside
 * the 24-hour customer-care window."
 *
 * The composer is built so nobody reaches that sentence: there is no free-text
 * field to type into and no send button until a template is picked. Letting
 * someone write a paragraph and rejecting it afterwards is the version of this
 * that wastes their time and teaches them the feature is broken.
 *
 * ## Reusing the picker
 *
 * `TemplatePicker` already offers only what `isTemplateSendable` allows — the
 * server's own rule, shared rather than copied — and already explains an empty
 * list, which has two very different causes (nothing written yet, or written
 * and not approved). A second picker here would be a second place for that
 * rule to drift.
 *
 * ## A number is not a person (client, 21 Nov, again 23 Nov)
 *
 * Without the three fields below (client: "no add a name field in add
 * conversation, also no selector for which store they are of, or any field to
 * add a tag to that particular customer") this door produced a thread headed
 * by a bare number, belonging to no branch and labelled with nothing, because
 * `POST /omnichannel/messages` leaves a number it does not recognise anonymous
 * rather than inventing a customer for it.
 *
 * All three obey ONE rule: they describe a customer this send is CREATING.
 * A number already on file keeps the name, the branch and the tags colleagues
 * recorded for it — the same way `resolveInbound` lets a branch record outrank
 * a WhatsApp profile name that says "Jewellery Lover". Tags are the exception
 * that proves it: they are ADDED to what a matched customer already has and
 * never replace it (`mergeTagIds`). The dialog says which case it is in before
 * the send and again after it, because "we opened their thread" and "we created
 * this customer" are different events.
 *
 * The branch is not decoration. A storeless customer is refused by the send
 * itself (`assertPartyAccess` admits one only for head office) and a storeless
 * thread is hidden from everybody but head office (`visibility()`), so naming
 * a new customer without a branch was a dead end for every store manager.
 */
export function StartWhatsAppDialog({
  open,
  onOpenChange,
  /** Prefilled when opened from a lead or a customer who already has a number. */
  phone,
  name,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  phone?: string | null;
  name?: string | null;
}) {
  const router = useRouter();
  const start = useStartWhatsAppThread();
  const { stores, currentStore } = useSession();
  const branches = branchChoices(stores, currentStore);
  const [to, setTo] = useState(phone ?? "");
  const [who, setWho] = useState(name ?? "");
  const [branch, setBranch] = useState(branches.initial);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [picked, setPicked] = useState<PickedTemplate | null>(null);

  // Reopening for a different lead must not carry the last one's number.
  const [lastPhone, setLastPhone] = useState(phone ?? "");
  if ((phone ?? "") !== lastPhone) {
    setLastPhone(phone ?? "");
    setTo(phone ?? "");
    setWho(name ?? "");
    setBranch(branches.initial);
    setTagIds([]);
    setPicked(null);
  }

  /*
   * Asked with kind 'whatsapp' because that is what the send resolves with, so
   * the answer on screen is the answer the send will act on. Same query key as
   * <CustomerRecognition /> below, so the two share one request rather than
   * asking the same question twice.
   */
  const known = useCustomerLookup(normalizeCustomerPhone(to), { kind: "whatsapp" });
  const alreadyACustomer = known.data?.found === true;

  /*
   * A tag has to go ON somebody. For a number nobody has met, the name is what
   * creates the customer record the tags attach to — `IdentityService.resolve`
   * refuses to create a record it would have to call "9876543210". Blocking the
   * send here is better than sending and then reporting that the tags went
   * nowhere, which is the version of this that reads as a bug.
   */
  const tagsNeedAName = tagIds.length > 0 && !alreadyACustomer && !who.trim();

  const canSend =
    to.trim().length >= 6 && picked !== null && !tagsNeedAName && !start.isPending;

  function send() {
    if (!picked) return;
    start.mutate(
      {
        to: to.trim(),
        name: who.trim() || undefined,
        ...(branch !== NO_BRANCH ? { storeId: branch } : {}),
        ...(tagIds.length ? { tagIds } : {}),
        templateName: picked.name,
        languageCode: picked.languageCode,
      },
      {
        onSuccess: (res) => {
          onOpenChange(false);
          setPicked(null);
          // The dialog stays mounted, so anything left in these boxes would be
          // offered again next time — against whatever number is typed then.
          setWho("");
          setTagIds([]);
          setBranch(branches.initial);
          toast.success(
            res.deduplicated
              ? "That message was already queued for this number."
              : "Queued. It appears in the thread as the provider confirms it.",
            { description: sendOutcomeNote(res.customer, res.tags) },
          );
          // Straight into the thread it just created, rather than leaving
          // somebody to find it in a list of several hundred. `thread` is the
          // parameter the inbox actually reads — this said `id`, which the page
          // ignores, so it landed on the list with nothing open.
          router.push(`/conversations?thread=${res.conversationId}`);
        },
        onError: (err) =>
          toast.error(
            // Already the server's own words plus what the identity step did,
            // so re-deriving it here would throw the second half away.
            err instanceof ThreadStartError
              ? err.message
              : apiErrorMessage(err, "Could not start that conversation."),
          ),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {name ? `Message ${name} on WhatsApp` : "Message someone on WhatsApp"}
          </DialogTitle>
          <DialogDescription>
            They have not written in, so this opens with one of your approved templates.
            Once they reply you can answer in your own words for 24 hours.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="wa-to">Mobile number</Label>
            <Input
              id="wa-to"
              value={to}
              inputMode="tel"
              autoComplete="tel"
              placeholder="e.g. 9876543210"
              onChange={(e) => setTo(e.target.value)}
            />
            {/* Who this number turns out to be, before anything is written —
                the same read-only recognition the showroom counter uses. */}
            <CustomerRecognition phone={to} kind="whatsapp" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="wa-name">Their name</Label>
            <Input
              id="wa-name"
              value={who}
              autoComplete="name"
              disabled={alreadyACustomer}
              placeholder="e.g. Priya Shah"
              onChange={(e) => setWho(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">
              {alreadyACustomer
                ? "This number is already a customer — their thread opens under the name on their record."
                : "Optional — but without it the thread is headed by the number."}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="wa-branch">Their branch</Label>
            <Select
              value={branch}
              disabled={alreadyACustomer}
              onValueChange={setBranch}
            >
              <SelectTrigger id="wa-branch">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {branches.options.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
                <SelectItem value={NO_BRANCH}>No branch — head office queue</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              {alreadyACustomer
                ? "Already set on their record. Move them from their customer page if it is wrong."
                : "Where this customer belongs. Without one, only head office can see the thread."}
            </p>
          </div>

          <div className="space-y-1.5">
            {/* No <Label> of its own: TagsField draws its own "Tags" heading,
                and two of them side by side reads as two fields. */}
            <TagsPicker value={tagIds} onChange={setTagIds} disabled={start.isPending} />
            <p className="text-[11px] text-muted-foreground">
              {tagsNeedAName
                ? "Add their name too — a tag has to go on a customer, and the name is what creates one."
                : alreadyACustomer
                  ? "Added to the tags they already carry — nothing a colleague recorded is removed."
                  : "The same tags the customer list filters on."}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label>Template</Label>
            <TemplatePicker
              value={picked ? { name: picked.name, languageCode: picked.languageCode } : null}
              onChange={setPicked}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={send} disabled={!canSend}>
            <MessageCircle className="h-4 w-4" />
            {start.isPending ? "Sending…" : "Send"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
