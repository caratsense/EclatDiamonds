"use client";

import { useState } from "react";
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
import { useSendQuotePdf, type SendQuotePdfResult } from "@/lib/queries/quotes";
import { apiErrorMessage, customerPhoneInputValue, normalizeCustomerPhone } from "@/lib/utils";

/** The quote being sent: enough to address it and to name it in the toast. */
export interface SendQuoteTarget {
  id: string;
  ref: string;
  /** The quote's own customer number, prefilled into the box. */
  phone: string;
}

/**
 * What the person is told about a send, taken only from what the server said.
 *
 * Pure, and separate from the dialog, because this is the sentence that has to
 * be right: a "Sent!" over a message that never left is how a rep comes to tell
 * a customer standing at the counter that the price is on its way. The outcomes
 * are distinct on purpose — QUEUED (handed to WhatsApp, which still decides),
 * and NOT CONNECTED (the job exists and will fail). Neither one says "sent" or
 * "delivered", because neither is known from here. A refusal is not in this
 * function at all: it arrives as an error and is repeated verbatim.
 */
export function sendOutcome(
  result: SendQuotePdfResult,
  to: string,
): { tone: "success" | "warning"; title: string; description: string } {
  if (result.dryRun) {
    return {
      tone: "warning",
      title: "WhatsApp is not connected — the PDF will not be delivered.",
      description:
        "It is in the outbox and will show as failed. Download the PDF and share it another way for now.",
    };
  }
  return {
    tone: "success",
    title: `Quote ${result.ref} PDF queued for WhatsApp`,
    // The server's own status word, not a word of ours standing in for it.
    description: `To ${to.trim()} · status ${result.status}. Delivery shows in the outbox.`,
  };
}

interface SendQuoteDialogProps {
  /** Null closes the dialog; a target opens it, seeding the recipient box. */
  target: SendQuoteTarget | null;
  /** Called when the dialog is finished with — dismissed, or queued. */
  onClose: () => void;
}

/**
 * Offer the send: the detailed quotation PDF, on WhatsApp, to a number that is
 * prefilled from the quote and editable before it goes.
 *
 * One dialog for both moments the offer is made (client, 7 Oct meeting 2, and
 * 14 Oct): straight after Save in the New-quote modal, where it answers "do you
 * want this to reach them now?", and from the quote view afterwards, so a quote
 * raised yesterday can still be sent today by whoever has it open. The same box
 * in both places means the recipient rule — the quote's number, changeable —
 * does not drift between them.
 *
 * Nobody's permission is involved: if you can open the quote you can send it.
 *
 * What the toast claims is only what the server actually said. "Queued" is the
 * most it can promise — consent, the 24-hour window and Meta still decide —
 * and a refusal is repeated in the server's own words, because a reason
 * paraphrased into "could not send" is a reason nobody can act on.
 */
export function SendQuoteDialog({ target, onClose }: SendQuoteDialogProps) {
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(o: boolean) => {
        if (!o) onClose();
      }}
    >
      {/* Keyed on the quote, and mounted only while open: the recipient box
          therefore seeds from THIS quote's number every time. Whatever was
          typed for the last quote cannot become the next one's recipient. */}
      {target ? (
        <SendQuoteDialogBody key={target.id} target={target} onClose={onClose} />
      ) : null}
    </Dialog>
  );
}

/** The dialog's own contents, so the recipient box can seed from props. */
function SendQuoteDialogBody({
  target,
  onClose,
}: {
  target: SendQuoteTarget;
  onClose: () => void;
}) {
  const sendPdf = useSendQuotePdf();
  const [to, setTo] = useState(() => target.phone.trim());

  const send = () => {
    sendPdf.mutate(
      { id: target.id, to },
      {
        onSuccess: (data) => {
          const outcome = sendOutcome(data, to);
          const show = outcome.tone === "warning" ? toast.warning : toast.success;
          show(outcome.title, {
            description: outcome.description,
            // The not-connected warning is the one nobody must scroll past.
            ...(outcome.tone === "warning" ? { duration: 8000 } : {}),
          });
          onClose();
        },
        // The server's refusal, verbatim — the window, the consent or the
        // number. The dialog stays open so the number can be corrected.
        onError: (e) => toast.error(apiErrorMessage(e, "Could not send the quote PDF.")),
      },
    );
  };

  return (
    <>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Send quote {target.ref} on WhatsApp</DialogTitle>
          <DialogDescription>
            The detailed quotation PDF goes out from this branch&rsquo;s own
            number. Change the recipient if it should reach a different phone.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="sq-send-to">Recipient mobile</Label>
          <Input
            id="sq-send-to"
            className="h-11"
            type="tel"
            inputMode="tel"
            maxLength={16}
            value={to}
            disabled={sendPdf.isPending}
            onChange={(e) => setTo(customerPhoneInputValue(e.target.value))}
            placeholder="10-digit mobile or +country number"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={sendPdf.isPending} onClick={onClose}>
            Not now
          </Button>
          <Button disabled={sendPdf.isPending || !normalizeCustomerPhone(to)} onClick={send}>
            {sendPdf.isPending ? "Sending…" : "Send PDF on WhatsApp"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </>
  );
}
