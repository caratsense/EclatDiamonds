"use client";

import { useState } from "react";
import { Bot, Check, FileText, X } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useAiDrafts, useReviewAiDraft, type AiDraft } from "@/lib/queries/crm-ai";
import { apiErrorMessage } from "@/lib/utils";

/**
 * Review of assistant drafts, shown on the conversation it belongs to.
 *
 * WHAT THIS SCREEN REFUSES TO DO:
 *
 *  - It never presents a draft as a sent message. Approving says "queued", which
 *    is the truth: nothing in this system can hand a message to WhatsApp yet.
 *  - It never hides what the draft was based on. The documents are named, and a
 *    source that has since been deleted is labelled as deleted rather than
 *    quietly dropped — a draft written from a document nobody can now read is
 *    exactly the one a reviewer should be suspicious of.
 *  - It never rounds confidence up. The number the model gave is shown as it is,
 *    next to the provider and model that produced it, so "the AI said so" is
 *    always answerable with "which AI, and how sure was it?".
 */
export function AiDraftPanel({ conversationId }: { conversationId: string }) {
  const { data, isLoading, isError, error, refetch } = useAiDrafts({
    conversationId,
    state: "all",
  });

  if (isLoading) return <Skeleton className="h-28 w-full" />;

  if (isError) {
    return (
      <Card>
        <CardContent className="flex items-center justify-between gap-3 pt-6">
          <p className="text-sm text-destructive">
            {apiErrorMessage(error, "Could not load assistant drafts.")}
          </p>
          <Button size="sm" variant="outline" onClick={() => refetch()}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  const drafts = data ?? [];
  if (!drafts.length) return null;

  const pending = drafts.filter((d) => d.review === "pending");
  const reviewed = drafts.filter((d) => d.review !== "pending");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Bot className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          Assistant {pending.length ? "draft awaiting review" : "drafts"}
          {pending.length > 0 && <Badge variant="secondary">{pending.length}</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {pending.map((d) => (
          <PendingDraft key={d.id} draft={d} conversationId={conversationId} />
        ))}

        {reviewed.length > 0 && (
          <div className="space-y-2 border-t pt-3">
            <p className="text-xs font-medium text-muted-foreground">Already reviewed</p>
            {reviewed.map((d) => (
              <ReviewedDraft key={d.id} draft={d} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Provenance({ draft }: { draft: AiDraft }) {
  const confidence = Number(draft.confidence);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
      <Badge variant="outline">{draft.provider}/{draft.model}</Badge>
      <Badge variant="outline">
        confidence {Number.isFinite(confidence) ? confidence.toFixed(2) : "unknown"}
      </Badge>
      {draft.latencyMs !== null && <Badge variant="outline">{draft.latencyMs} ms</Badge>}
      <Badge variant="outline">policy {draft.policyVersion}</Badge>
      {draft.sources.map((s) => (
        <Badge
          key={s.id}
          variant="outline"
          className={`gap-1 ${s.deleted ? "text-amber-600" : ""}`}
        >
          <FileText className="h-3 w-3" aria-hidden="true" />
          {s.title ?? "source deleted"}
        </Badge>
      ))}
    </div>
  );
}

function PendingDraft({ draft, conversationId }: { draft: AiDraft; conversationId: string }) {
  const [text, setText] = useState(draft.message.body ?? "");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const review = useReviewAiDraft(conversationId);

  const edited = text.trim() !== (draft.message.body ?? "").trim();

  const act = async (decision: "approve" | "reject") => {
    // The button is disabled while in flight; this catches a fast double-press
    // that lands between renders.
    if (review.isPending) return;
    setError(null);
    try {
      const res = await review.mutateAsync({
        draftId: draft.id,
        decision,
        // Only send the body when it actually changed — the server uses that to
        // distinguish "approved as written" from "a person had to rewrite it".
        ...(decision === "approve" && edited ? { body: text } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      toast.success(
        decision === "reject" ? "Draft rejected" : edited ? "Edited and queued" : "Queued",
        { description: (res as { delivery?: { note?: string } })?.delivery?.note },
      );
    } catch (e) {
      setError(apiErrorMessage(e, "Could not record that decision."));
    }
  };

  return (
    <div className="rounded-md border border-amber-300/60 bg-amber-50/40 p-3 dark:bg-amber-950/10">
      <p className="text-xs text-muted-foreground">
        The assistant proposed this reply. Nothing has been sent.
      </p>

      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        className="mt-2 bg-background"
        aria-label="Draft reply"
      />
      {edited && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          Edited — this will be recorded as a rewrite, not an approval.
        </p>
      )}

      <Provenance draft={draft} />

      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Note (optional)"
        maxLength={500}
        className="mt-2 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
      />

      {error && (
        <p role="alert" className="mt-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => act("approve")} disabled={review.isPending || !text.trim()}>
          <Check className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          {review.isPending ? "Saving…" : edited ? "Save and queue" : "Approve and queue"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => act("reject")} disabled={review.isPending}>
          <X className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          Reject
        </Button>
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Approving queues the reply. It reaches the customer once a messaging integration is
        connected — it is not sent yet.
      </p>
    </div>
  );
}

const LABEL: Record<AiDraft["review"], string> = {
  pending: "Awaiting review",
  approved: "Approved as written",
  edited: "Edited by a person",
  rejected: "Rejected",
};

function ReviewedDraft({ draft }: { draft: AiDraft }) {
  return (
    <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{LABEL[draft.review]}</span>
        {draft.reviewedBy && <span className="text-muted-foreground">by {draft.reviewedBy.name}</span>}
        {draft.reviewedAt && (
          <span className="text-muted-foreground">
            · {new Date(draft.reviewedAt).toLocaleString()}
          </span>
        )}
        {/* The delivery state, verbatim. 'rejected' is not 'failed'. */}
        <Badge variant="outline" className="text-[10px]">{draft.message.status}</Badge>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{draft.message.body}</p>
      {draft.reviewNote && <p className="mt-1 italic">“{draft.reviewNote}”</p>}
      <Provenance draft={draft} />
    </div>
  );
}
