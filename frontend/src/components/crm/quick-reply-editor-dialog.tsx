"use client";

import { useMemo } from "react";
import { toast } from "sonner";

import { QuickReplyForm } from "@/components/settings/quick-reply-form";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { isTemplateSendable, useMessageTemplates } from "@/lib/queries/meta-admin";
import {
  useCreateQuickReply,
  useQuickReplies,
  useUpdateQuickReply,
} from "@/lib/queries/quick-replies";
import { apiErrorMessage } from "@/lib/utils";
import { useSession } from "@/store/use-session";

/**
 * Add or reword a quick reply without leaving the conversation.
 *
 * ## Why this exists next to a settings screen that already does it
 *
 * It was on Settings only, reached by the Manage link on the chip bar, on the
 * argument that arranging chips is a quiet job and using one is not. The client
 * disagreed, twice, and the second time plainly: "I told you to add an edit
 * button onto it. Quick reply — I wanted an option to create a quick reply and
 * then that gets saved." She is describing where the thought actually happens.
 * Somebody types an answer for the fourth time this week and realises it should
 * be a chip; a link that navigates away from the thread, losing what they have
 * typed, is where that realisation goes to die.
 *
 * So the words already in the composer come with it. Adding from the bar
 * arrives with the draft filled in and a name to give it, and that is the whole
 * interaction.
 *
 * ## What stayed on the settings screen
 *
 * Order, deletion and the full list with its warnings. Reordering needs every
 * chip in view, and deleting one changes what a team says with no thread in
 * front of you to judge it by. The Manage link is still there for both.
 *
 * ## One form, two places
 *
 * The fields are `QuickReplyForm`, the same component Settings renders inline.
 * Two forms would eventually disagree about what is valid, and the one that
 * disagreed would be the one nobody tested.
 */
export function QuickReplyEditorDialog({
  open,
  onOpenChange,
  /** The row being reworded, or null to add a new one. */
  editingId,
  /** What is in the composer right now; the starting words for a new chip. */
  draft,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingId: string | null;
  draft?: string;
}) {
  const stores = useSession((s) => s.stores);
  const list = useQuickReplies();
  const templates = useMessageTemplates();
  const create = useCreateQuickReply();
  const update = useUpdateQuickReply();

  const branches = useMemo(() => stores.filter((s) => !s.isAggregate), [stores]);
  /*
   * Only templates that can actually be sent, exactly as the settings screen
   * filters them: `isTemplateSendable` is the server's own send-time verdict.
   * Offering the rest builds a chip that looks finished and reaches nobody.
   */
  const sendable = useMemo(
    () => (templates.data ?? []).filter((t) => isTemplateSendable(t) && !t.metadata.isCarousel),
    [templates.data],
  );

  const row = editingId ? list.data?.rows.find((r) => r.id === editingId) : undefined;
  const loading = list.isLoading || (Boolean(editingId) && !row);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{editingId ? "Edit quick reply" : "New quick reply"}</DialogTitle>
          <DialogDescription>
            {editingId
              ? "Everyone who uses this chip will send the new wording from now on."
              : "Save what you just typed as a chip, and your team sends it with one tap."}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-9 w-2/3" />
          </div>
        ) : (
          /*
           * Keyed, so opening the dialog on a different chip rebuilds the
           * fields rather than leaving the previous one's words in them — the
           * form holds its own state, as it must to be typed into.
           */
          <QuickReplyForm
            key={editingId ?? "new"}
            chrome="bare"
            title=""
            row={row}
            initialBody={editingId ? undefined : draft}
            branches={branches}
            canWriteEveryBranch={list.data?.canWriteEveryBranch ?? false}
            placeholders={list.data?.placeholders ?? []}
            templates={sendable}
            busy={create.isPending || update.isPending}
            onCancel={() => onOpenChange(false)}
            onSave={(input) => {
              if (editingId) {
                update.mutate(
                  { id: editingId, ...input },
                  {
                    onSuccess: () => {
                      onOpenChange(false);
                      toast.success("Saved.");
                    },
                    onError: (e) => toast.error(apiErrorMessage(e, "Could not save that.")),
                  },
                );
                return;
              }
              create.mutate(input, {
                onSuccess: () => {
                  onOpenChange(false);
                  toast.success(`"${input.label}" added.`);
                },
                onError: (e) =>
                  toast.error(apiErrorMessage(e, "Could not add that quick reply.")),
              });
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
