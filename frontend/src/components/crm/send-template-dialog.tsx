"use client";

import { useMemo, useState } from "react";
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
  TemplatePicker,
  type PickedTemplate,
} from "@/components/campaigns/template-picker";
import type { TemplateVariableDefault } from "@/lib/queries/meta-admin";
import { isTemplateSendable, useMessageTemplates } from "@/lib/queries/meta-admin";
import { useSendTemplateReply } from "@/lib/queries/crm";
import { apiErrorMessage } from "@/lib/utils";

/** Collapsed the way the server collapses it: Meta refuses a newline in a value. */
function flatten(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * What each `{{n}}` should start out holding, for THIS customer.
 *
 * The same four sources the broadcast wizard and `resolveVariables` use, read
 * off the template's own recorded defaults, with this thread's customer and
 * branch as the subject. A slot the template's author never described comes
 * back empty, which is the honest state: nobody has said what belongs there,
 * and the person sending is the one who can.
 *
 * These are STARTING values, not the final ones — see the dialog's own note on
 * why a one-off send resolves to literals the sender can read and edit, where a
 * broadcast sends mappings for the server to resolve per recipient.
 */
export function templateVariableFills(
  defaults: TemplateVariableDefault[] | undefined,
  slots: number,
  subject: { customerName?: string | null; branchName?: string | null },
): string[] {
  const bySlot = new Map((defaults ?? []).map((d) => [d.slot, d]));
  const name = flatten(subject.customerName);
  const branch = flatten(subject.branchName);
  return Array.from({ length: slots }, (_unused, i) => {
    const d = bySlot.get(i + 1);
    if (!d) return "";
    const value =
      d.source === "fixed"
        ? flatten(d.text)
        : d.source === "customer_first_name"
          ? (name.split(" ")[0] ?? "")
          : d.source === "customer_name"
            ? name
            : branch;
    return value || flatten(d.fallback);
  });
}

/**
 * The approved wording with this send's values dropped into it.
 *
 * Shown because a template send is irreversible and its words are not the
 * sender's: reading the exact sentence the customer will receive, with the
 * actual name in it, is the only check available before it goes. A slot still
 * empty keeps its `{{n}}` on screen rather than collapsing to nothing, so a
 * gap looks like a gap.
 */
export function fillTemplateBody(source: string, values: string[]): string {
  return source.replace(/\{\{\s*(\d+)\s*\}\}/g, (whole, slot: string) => {
    const value = values[Number(slot) - 1];
    return value?.trim() ? value : whole;
  });
}

/**
 * Send ONE approved template to the customer whose thread is open.
 *
 * ## The fault this replaces (client, 23 Nov)
 *
 * "when i click on send a template it takes me to broadcasts page. it should
 * rather show a list of templates from which i can select and send."
 *
 * The notice above the shut composer offered a button reading "Send a template"
 * that linked to `/campaigns`. A broadcast is a mass send to an audience — the
 * wrong object entirely for "reach this one customer, now" — and it also asks
 * for an audience, a schedule and an approval before anything leaves. Nothing
 * regressed: that link has pointed at `/campaigns` since the notice was first
 * written (6757654, "disable the composer once WhatsApp's 24-hour window
 * closes"). What was once there, and still is, is the quick-reply chip row
 * directly above — which sends a template in one tap but only offers the ones a
 * manager has saved as chips, so on a tenant with none it renders nothing at
 * all and this button was the only thing left to press.
 *
 * ## Why a dialog of its own rather than StartWhatsAppDialog pre-filled
 *
 * That dialog is a FIRST CONTACT door. It asks for a mobile number, a name, a
 * branch and tags — four facts this thread already holds — and its own words
 * are "They have not written in", which is false here: they wrote, more than
 * 24 hours ago. Pre-filling it would also route the send through
 * `POST /omnichannel/messages`, which re-derives the thread from a phone number
 * when we are holding the thread's id, and which fixes `purpose` at 'service'
 * so a marketing template would be sent as service and walk past recorded
 * consent. What is worth reusing from it is the picker, and the picker is
 * already a component for exactly this reason.
 *
 * ## Why the values are resolved here
 *
 * A broadcast sends the server a MAPPING and the server resolves it per
 * recipient, because it has thousands of recipients and the words are different
 * for each. This has exactly one recipient, known before the send, so there is
 * nothing to resolve later and every reason to show the sender the finished
 * sentence: the one check available on an irreversible send whose wording is
 * Meta's rather than hers. The starting values come from the template's own
 * recorded defaults, through the same four sources the server uses.
 */
export function SendTemplateDialog({
  open,
  onOpenChange,
  conversationId,
  customerName,
  branchName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  customerName: string | null;
  /** The branch that owns the thread, for a `branch_name` variable. */
  branchName: string | null;
}) {
  const send = useSendTemplateReply(conversationId);
  const [picked, setPicked] = useState<PickedTemplate | null>(null);
  /** Null until she edits a slot; otherwise the template's own defaults stand. */
  const [edited, setEdited] = useState<string[] | null>(null);

  /*
   * The same request the picker makes, from the same cache, because the picker
   * answers with a name and a language and the send needs two facts it does not
   * carry: the registered template's id, and Meta's category for it. Reading
   * them here rather than widening PickedTemplate keeps the broadcast wizard's
   * contract untouched, and costs no extra call.
   */
  const templates = useMessageTemplates();
  const row = useMemo(() => {
    if (!picked) return undefined;
    return (templates.data ?? [])
      .filter(isTemplateSendable)
      .find(
        (t) =>
          (t.name ?? t.externalId) === picked.name &&
          t.metadata.languageCode === picked.languageCode,
      );
  }, [picked, templates.data]);

  const defaults = useMemo(
    () =>
      picked
        ? templateVariableFills(picked.variableDefaults, picked.variableCount, {
            customerName,
            branchName,
          })
        : [],
    [picked, customerName, branchName],
  );
  const values = edited ?? defaults;

  // Meta refuses a message with a blank value in it, so a slot nobody filled
  // is a send that fails at the provider rather than one that reads oddly.
  const incomplete = values.some((v) => !v.trim());
  const canSend = !!picked && !!row && !incomplete && !send.isPending;

  function reset() {
    setPicked(null);
    setEdited(null);
  }

  function onSend() {
    if (!picked || !row) return;
    send.mutate(
      {
        templateAssetId: row.id,
        /*
         * Meta's own category, never what the thread is being used for. An
         * offer template pressed inside a support conversation is still a
         * marketing message, and sending it as 'service' would walk it past
         * recorded consent — the same rule QuickRepliesService.send states.
         */
        purpose: row.metadata.category === "marketing" ? "marketing" : "service",
        values: values.map((v) => flatten(v)),
      },
      {
        onSuccess: () => {
          onOpenChange(false);
          reset();
          toast.success("Queued. It appears in the thread as the provider confirms it.");
        },
        // The server's own sentence: a withdrawn consent, a stale approval and a
        // closed channel are three different things to do next about.
        onError: (e) => toast.error(apiErrorMessage(e, "Could not send that template.")),
      },
    );
  }

  /*
   * The wording with its `{{n}}` still in it, which is the only version worth
   * substituting into. `preview` has the TEMPLATE'S OWN SAMPLE values already
   * baked in, so filling it would show a sentence greeting this customer by
   * the name in Meta's example. Absent on anything recorded before body source
   * was stored — the picker's own preview above is then the honest answer, and
   * this block simply does not appear.
   */
  const source = picked?.source?.trim() ?? "";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {customerName ? `Send a template to ${customerName}` : "Send a template"}
          </DialogTitle>
          <DialogDescription>
            It is over 24 hours since they last wrote, so WhatsApp allows only an
            approved template. Pick one and it goes straight into this
            conversation.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[55vh] space-y-4 overflow-y-auto">
          <TemplatePicker
            value={
              picked ? { name: picked.name, languageCode: picked.languageCode } : null
            }
            onChange={(next) => {
              setPicked(next);
              // A different template has different slots; last one's words must
              // not survive into them.
              setEdited(null);
            }}
          />

          {picked && picked.variableCount > 0 ? (
            <div className="space-y-2">
              <Label className="text-xs">What goes in this message</Label>
              {values.map((value, i) => (
                <div key={i} className="space-y-1">
                  <Label htmlFor={`tpl-var-${i}`} className="text-[11px] font-normal text-muted-foreground">
                    {`{{${i + 1}}}`}
                  </Label>
                  <Input
                    id={`tpl-var-${i}`}
                    value={value}
                    onChange={(e) => {
                      const next = [...values];
                      next[i] = e.target.value;
                      setEdited(next);
                    }}
                  />
                </div>
              ))}
              {incomplete ? (
                <p className="text-[11px] text-amber-700 dark:text-amber-400">
                  Every blank has to be filled — WhatsApp refuses a message with
                  an empty value in it.
                </p>
              ) : null}
            </div>
          ) : null}

          {source ? (
            <div className="space-y-1.5">
              <Label className="text-xs">What they will read</Label>
              <p className="whitespace-pre-wrap rounded-lg rounded-tl-sm bg-[#d9fdd3] p-2.5 text-[13px] leading-relaxed text-[#111b21] dark:bg-[#005c4b] dark:text-[#e9edef]">
                {fillTemplateBody(source, values)}
              </p>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onSend} disabled={!canSend}>
            <MessageCircle className="h-4 w-4" />
            {send.isPending ? "Sending…" : "Send"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
