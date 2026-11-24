"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2, Pencil, Plus, Send, Settings2 } from "lucide-react";
import { toast } from "sonner";

import { QuickReplyEditorDialog } from "@/components/crm/quick-reply-editor-dialog";
import { useQuickReplyChips, useSendQuickReply } from "@/lib/queries/quick-replies";
import { apiErrorMessage } from "@/lib/utils";

/**
 * The quick-reply chips above the message box.
 *
 * ## What this replaces
 *
 * Three buttons written into `conversations/page.tsx`, wording and all — down
 * to "0.50 ct solitaire ring" and "IGI laser-inscribed". They rendered only
 * while WhatsApp's 24-hour window was open, so the one moment a shortcut is
 * worth most — somebody's message was missed yesterday and only an approved
 * template can reach them — was the one moment with no shortcuts at all. That
 * is exactly what the client asked about. The three are now rows in the
 * database, seeded with their current words so nothing was lost, and she can
 * reword, reorder, scope or delete them on Settings › Quick replies.
 *
 * ## Why the server decides which chips exist
 *
 * The composer's own `windowOpen` is computed in the page and that is right for
 * enabling a text box. WHICH chips exist is a different question — stored rows,
 * branch scope, and whether Meta still approves the template behind each one —
 * and all three live on the server. So this renders what it is handed: every
 * chip returned can be used right now, which is why none of them is ever
 * disabled here.
 *
 * ## Wording drafts, a template sends
 *
 * A wording chip fills the box, so a salesperson can add a line before sending.
 * A template chip sends immediately, and says so: its wording is fixed at Meta,
 * so there is nothing to edit, and letting somebody change a word would quietly
 * turn an approved template into free text that the 24-hour rule may refuse.
 * The send icon and the green edge are the affordance for that difference.
 *
 * ## Why add and edit are here as well as on Settings
 *
 * Because the client asked twice, and the second time in so many words: "I told
 * you to add an edit button onto it... I wanted an option to create a quick
 * reply and then that gets saved." The first cut sent her to Settings for both.
 * That is the wrong place for the add: the moment an answer is worth keeping is
 * the moment it has just been typed, and a link that navigates away takes the
 * typing with it. So the new-chip dialog opens here, with the composer's words
 * already in it.
 *
 * Ordering and deleting stay on Settings, behind Manage — both need the whole
 * list in view, and neither is something to do mid-conversation.
 */
export function QuickReplyBar({
  conversationId,
  draft,
  onPickWording,
}: {
  conversationId: string;
  /** What is in the composer, offered as the starting words for a new chip. */
  draft?: string;
  /** Put these words in the composer. The salesperson still presses send. */
  onPickWording: (text: string) => void;
}) {
  const data = useQuickReplyChips(conversationId);
  const send = useSendQuickReply(conversationId);
  /** `null` while adding; a chip id while rewording that one. */
  const [editor, setEditor] = useState<{ id: string | null } | null>(null);

  const canManage = data.data?.canManage ?? false;
  const chips = data.data?.chips ?? [];
  // Nothing to offer AND nothing this person could add: say nothing. Inside
  // the window the composer is right there; outside it, the notice beside this
  // already explains the rule and offers the broadcast screen. A manager still
  // gets the add control, because an empty bar is exactly when it is wanted.
  if (!chips.length && !canManage) return null;

  const windowOpen = data.data?.windowOpen ?? true;

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
      <span className="whitespace-nowrap pl-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {windowOpen ? "Quick replies:" : "Can still be sent:"}
      </span>
      {chips.map((chip) => {
        /*
         * The pencil sits INSIDE the chip's group rather than on the chip, and
         * only for somebody who may change it. On the chip it would be a second
         * target under the thumb of a salesperson reaching for the words, and
         * tapping the wrong one mid-conversation sends nothing and opens a
         * form — the most annoying possible failure.
         */
        const edit = canManage ? (
          <button
            key={`${chip.id}-edit`}
            type="button"
            aria-label={`Edit "${chip.label}"`}
            title={`Edit "${chip.label}"`}
            onClick={() => setEditor({ id: chip.id })}
            className="-ml-1 inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
          >
            <Pencil className="size-2.5" aria-hidden />
          </button>
        ) : null;
        const body = chip.sends ? (
          <button
            key={chip.id}
            type="button"
            // The whole message, so somebody can read what a tap will send
            // before they tap it. A chip is a label, not a sentence.
            title={chip.text}
            disabled={send.isPending}
            onClick={() =>
              send.mutate(chip.id, {
                onSuccess: (result) => toast.success(`Sent — ${result.label}`),
                onError: (e) => toast.error(apiErrorMessage(e, "Could not send that.")),
              })
            }
            className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-[#25D366]/50 bg-[#25D366]/10 px-2.5 py-0.5 text-[11px] text-foreground transition-colors hover:bg-[#25D366]/20 disabled:opacity-60"
          >
            {send.isPending && send.variables === chip.id ? (
              <Loader2 className="size-3 animate-spin" aria-hidden />
            ) : (
              <Send className="size-3" aria-hidden />
            )}
            {chip.label}
          </button>
        ) : (
          <button
            key={chip.id}
            type="button"
            title={chip.text}
            onClick={() => onPickWording(chip.text)}
            className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-border/80 bg-muted/50 px-2.5 py-0.5 text-[11px] text-foreground transition-colors hover:border-[#25D366]/40 hover:bg-muted"
          >
            {chip.label}
          </button>
        );
        return (
          <span key={chip.id} className="inline-flex items-center gap-0.5">
            {body}
            {edit}
          </span>
        );
      })}
      {/* Save what is in the box. Disabled-looking it is not: a chip can be
          written from scratch here too, and often is the first time. */}
      {canManage ? (
        <button
          type="button"
          onClick={() => setEditor({ id: null })}
          title="Save a new quick reply"
          className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-dashed border-border px-2.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-[#25D366]/40 hover:text-foreground"
        >
          <Plus className="size-3" aria-hidden />
          New
        </button>
      ) : null}
      {/* The way in to changing them, for whoever may. Here rather than only in
          a settings menu because this is where somebody is standing when they
          think "that answer needs rewording". */}
      {data.data?.canManage ? (
        <Link
          href="/settings/quick-replies"
          className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-dashed border-border px-2.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <Settings2 className="size-3" aria-hidden />
          Manage
        </Link>
      ) : null}
      {editor ? (
        <QuickReplyEditorDialog
          open
          onOpenChange={(next) => {
            if (!next) setEditor(null);
          }}
          editingId={editor.id}
          draft={draft}
        />
      ) : null}
    </div>
  );
}
