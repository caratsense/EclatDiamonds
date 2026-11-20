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
import { TemplatePicker, type PickedTemplate } from "@/components/campaigns/template-picker";
import { useStartWhatsAppThread } from "@/lib/queries/crm";
import { apiErrorMessage } from "@/lib/utils";

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
  const [to, setTo] = useState(phone ?? "");
  const [picked, setPicked] = useState<PickedTemplate | null>(null);

  // Reopening for a different lead must not carry the last one's number.
  const [lastPhone, setLastPhone] = useState(phone ?? "");
  if ((phone ?? "") !== lastPhone) {
    setLastPhone(phone ?? "");
    setTo(phone ?? "");
    setPicked(null);
  }

  const canSend = to.trim().length >= 6 && picked !== null && !start.isPending;

  function send() {
    if (!picked) return;
    start.mutate(
      { to: to.trim(), templateName: picked.name, languageCode: picked.languageCode },
      {
        onSuccess: (res) => {
          onOpenChange(false);
          setPicked(null);
          toast.success(
            res.deduplicated
              ? "That message was already queued for this number."
              : "Queued. It appears in the thread as the provider confirms it.",
          );
          // Straight into the thread it just created, rather than leaving
          // somebody to find it in a list of several hundred.
          router.push(`/conversations?id=${res.conversationId}`);
        },
        onError: (err) =>
          toast.error(apiErrorMessage(err, "Could not start that conversation.")),
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
