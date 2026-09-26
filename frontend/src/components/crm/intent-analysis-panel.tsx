"use client";

import { useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  HelpCircle,
  Lightbulb,
  PencilLine,
  RefreshCw,
  Sparkles,
  TrendingUp,
  TriangleAlert,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { StatusPill, type PillTone } from "@/components/ui/status-pill";
import {
  useAssessConversation,
  useAssessLead,
  useLatestQualification,
  useScoreByHand,
} from "@/lib/queries/crm-ai";
import { ROLE_RANK } from "@/lib/types";
import { apiErrorMessage } from "@/lib/utils";
import { useSession } from "@/store/use-session";

/**
 * What the qualification engine actually concluded about this conversation.
 *
 * EVERY FIGURE ON THIS PANEL COMES FROM THE SERVER OR IS NOT SHOWN.
 *
 * The version this replaces defaulted to `score ?? 65`, `band ?? "warm"` and
 * `confidence ?? 0.82` — so a conversation nobody had ever assessed rendered a
 * green dial reading 65, a "Moderate Intent" badge and "Confidence: 82%". Three
 * confident numbers, none of them measured, on the screen a salesperson reads
 * before deciding how hard to chase somebody. It also printed a fixed paragraph
 * about bridal sets and wedding timelines as "AI Reasoning", two suggested
 * actions written into the file, and a footer crediting "Explainable Rule Model
 * v2.4" — a version string that exists nowhere in this system.
 *
 * The contract deliberately distinguishes three states, and so does this panel:
 *
 *   - `null`            nobody has assessed this yet. Not a score of zero;
 *                       zero means COLD, which is a claim.
 *   - `available:false` an assessment ran and could not produce a score.
 *                       `unavailableReason` says why, in the server's words.
 *   - available         a real score, with the signals that produced it.
 *
 * The suggested action is the band's `recommendedAction` from the tenant's own
 * qualification policy — their sentence, not one composed here.
 */

interface IntentAnalysisPanelProps {
  conversationId?: string;
  leadId?: string;
  partyId?: string;
  onClose?: () => void;
  onApplyAction?: (actionText: string) => void;
}

/** Band colouring by score, matching the bands elsewhere in the product. */
function toneForScore(score: number): PillTone {
  if (score >= 70) return "good";
  if (score >= 40) return "wait";
  return "bad";
}

export function IntentAnalysisPanel({
  conversationId,
  leadId,
  partyId,
  onClose,
  onApplyAction,
}: IntentAnalysisPanelProps) {
  const { data, isLoading, isError, error, refetch } = useLatestQualification({
    partyId,
    leadId,
    conversationId,
  });
  const assessConversation = useAssessConversation();
  const assessLead = useAssessLead();
  const scoreByHand = useScoreByHand();
  const isAssessing = assessConversation.isPending || assessLead.isPending;
  const canAssess = Boolean(conversationId || leadId);

  const role = useSession((s) => s.role);
  /*
   * Store manager and above, mirroring the server's own gate. This hides a
   * control the caller would only be refused — it is NOT the security boundary,
   * which lives on the endpoint.
   */
  const canScoreByHand = canAssess && ROLE_RANK[role] >= ROLE_RANK.store_manager;
  const [editing, setEditing] = useState(false);

  const handleAssess = async () => {
    try {
      if (conversationId) await assessConversation.mutateAsync(conversationId);
      else if (leadId) await assessLead.mutateAsync(leadId);
      await refetch();
    } catch (e) {
      toast.error(apiErrorMessage(e, "Could not run the assessment."));
    }
  };

  const handleScoreByHand = async (score: number, reason: string) => {
    try {
      await scoreByHand.mutateAsync({ conversationId, leadId, score, reason });
      await refetch();
      setEditing(false);
      toast.success("Your score was recorded");
    } catch (e) {
      toast.error(apiErrorMessage(e, "Could not record your score."));
    }
  };

  return (
    <div className="space-y-4 rounded-xl border border-border/80 bg-card p-4 text-sm shadow-sm">
      <header className="flex items-center justify-between gap-2 border-b border-border pb-3">
        <div className="flex min-w-0 items-center gap-2 font-semibold">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted">
            <TrendingUp className="h-4 w-4" aria-hidden />
          </span>
          <span className="truncate">Intent</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {canAssess ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              disabled={isAssessing}
              onClick={handleAssess}
              title="Assess this conversation again"
              aria-label="Assess this conversation again"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isAssessing ? "animate-spin" : ""}`} />
            </Button>
          ) : null}
          {onClose ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
              onClick={onClose}
              aria-label="Close the intent panel"
            >
              <X className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
      </header>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : isError ? (
        <p className="text-sm text-muted-foreground">
          {apiErrorMessage(error, "Could not read the assessment.")}
        </p>
      ) : editing ? (
        <ManualScoreForm
          initialScore={data?.score ?? null}
          busy={scoreByHand.isPending}
          onCancel={() => setEditing(false)}
          onSave={handleScoreByHand}
        />
      ) : !data ? (
        <NotAssessed
          onAssess={canAssess ? handleAssess : undefined}
          onScoreByHand={canScoreByHand ? () => setEditing(true) : undefined}
          busy={isAssessing}
        />
      ) : !data.available || data.score === null ? (
        <Unavailable
          reason={data.unavailableReason}
          considered={data.messagesConsidered}
          onAssess={canAssess ? handleAssess : undefined}
          onScoreByHand={canScoreByHand ? () => setEditing(true) : undefined}
          busy={isAssessing}
        />
      ) : (
        <Assessed
          data={data}
          onApplyAction={onApplyAction}
          onScoreByHand={canScoreByHand ? () => setEditing(true) : undefined}
        />
      )}
    </div>
  );
}

/* --------------------------------------------------------- scoring by hand */

/**
 * A person's own score.
 *
 * The reason is required by the server and required here, so the refusal is
 * explained before the request is made rather than after. A score somebody
 * cannot justify is one nobody can review later — including the person who set
 * it, three months on.
 */
function ManualScoreForm({
  initialScore,
  busy,
  onCancel,
  onSave,
}: {
  initialScore: number | null;
  busy: boolean;
  onCancel: () => void;
  onSave: (score: number, reason: string) => void;
}) {
  const [score, setScore] = useState(String(initialScore ?? 50));
  const [reason, setReason] = useState("");

  const parsed = Number(score);
  const scoreValid = Number.isInteger(parsed) && parsed >= 0 && parsed <= 100;
  const reasonValid = reason.trim().length >= 3;

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (scoreValid && reasonValid) onSave(parsed, reason.trim());
      }}
    >
      <p className="text-xs text-muted-foreground">
        {/* Says plainly what will happen to the existing score, because "edit"
            normally means "replace" and here it does not. */}
        Your score is added on top — the assistant&rsquo;s stays on the record underneath it.
      </p>

      <div className="space-y-1.5">
        <Label htmlFor="manual-score" className="text-xs">
          Score out of 100
        </Label>
        <Input
          id="manual-score"
          type="number"
          inputMode="numeric"
          min={0}
          max={100}
          step={1}
          value={score}
          onChange={(e) => setScore(e.target.value)}
          className="num h-9 w-24"
          autoFocus
        />
        {!scoreValid && score.trim() !== "" ? (
          <p className="text-xs text-rose-600 dark:text-rose-400">
            Enter a whole number between 0 and 100.
          </p>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="manual-reason" className="text-xs">
          Why
        </Label>
        <Textarea
          id="manual-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          rows={3}
          placeholder="Visited the Bandra store on Saturday and asked about financing."
          className="text-sm"
        />
      </div>

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={busy || !scoreValid || !reasonValid}>
          {busy ? "Saving…" : "Save score"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------ empty states */

function NotAssessed({
  onAssess,
  onScoreByHand,
  busy,
}: {
  onAssess?: () => void;
  onScoreByHand?: () => void;
  busy: boolean;
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Not assessed yet. Nothing has been scored for this conversation, so there is no
        number to show — a score is calibrated from the messages as they arrive.
      </p>
      <div className="flex flex-wrap gap-2">
        {onAssess ? (
          <Button size="sm" variant="outline" onClick={onAssess} disabled={busy}>
            <Sparkles className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {busy ? "Assessing…" : "Assess now"}
          </Button>
        ) : null}
        {onScoreByHand ? (
          <Button size="sm" variant="ghost" onClick={onScoreByHand} disabled={busy}>
            <PencilLine className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            Score it yourself
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function Unavailable({
  reason,
  considered,
  onAssess,
  onScoreByHand,
  busy,
}: {
  reason: string | null;
  considered: number;
  onAssess?: () => void;
  onScoreByHand?: () => void;
  busy: boolean;
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {/* The server's own words. A generic "not enough data" would be a guess
            about a failure it already explained. */}
        {reason ?? "No score could be produced from this conversation."}
      </p>
      <p className="text-xs text-muted-foreground">
        {considered === 1 ? "1 message" : `${considered} messages`} were considered.
      </p>
      <div className="flex flex-wrap gap-2">
        {onAssess ? (
          <Button size="sm" variant="outline" onClick={onAssess} disabled={busy}>
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} aria-hidden />
            Try again
          </Button>
        ) : null}
        {/* The most useful place for this: the assistant could not read the
            thread, but a person who has spoken to them can still say. */}
        {onScoreByHand ? (
          <Button size="sm" variant="ghost" onClick={onScoreByHand} disabled={busy}>
            <PencilLine className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            Score it yourself
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- the score */

function Assessed({
  data,
  onApplyAction,
  onScoreByHand,
}: {
  data: NonNullable<ReturnType<typeof useLatestQualification>["data"]>;
  onApplyAction?: (text: string) => void;
  onScoreByHand?: () => void;
}) {
  const score = data.score as number;
  const byHand = data.method === "human";
  const tone = toneForScore(score);
  const radius = 38;
  const circumference = 2 * Math.PI * radius;
  const stroke =
    tone === "good" ? "#10b981" : tone === "wait" ? "#f59e0b" : "#ef4444";

  return (
    <div className="space-y-4">
      {data.policyOutdated ? (
        <p className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-700 dark:text-amber-400">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          Your qualification rules have changed since this was scored. Re-assess to score it
          under the current policy.
        </p>
      ) : null}

      {data.handoffRequested ? (
        <p className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2.5 text-xs text-rose-700 dark:text-rose-400">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {data.handoffReason ?? "This conversation is asking for a person."}
        </p>
      ) : null}

      <div className="flex items-center gap-4 rounded-lg border border-border bg-muted/30 p-3.5">
        <div className="relative flex shrink-0 items-center justify-center">
          <svg className="h-24 w-24 -rotate-90" viewBox="0 0 100 100" role="img"
            aria-label={`Intent score ${score} out of 100`}>
            <circle
              cx="50" cy="50" r={radius}
              stroke="currentColor" strokeWidth="8" fill="none"
              className="text-border"
            />
            <circle
              cx="50" cy="50" r={radius}
              stroke={stroke} strokeWidth="8" fill="none"
              strokeDasharray={circumference}
              strokeDashoffset={circumference - (score / 100) * circumference}
              strokeLinecap="round"
            />
          </svg>
          <span className="absolute flex flex-col items-center">
            <span className="num text-2xl font-bold tracking-tight">{score}</span>
            <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
              Score
            </span>
          </span>
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {/* The BAND'S OWN LABEL from the tenant's policy. Nothing here
                invents a phrase like "Easy to Convert" for a number. */}
            <StatusPill tone={tone}>{data.bandLabel ?? data.band ?? "Scored"}</StatusPill>
            <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
              {byHand ? "By hand" : data.method === "ai" ? "Model" : "Rules"}
            </Badge>
            {data.lowConfidence ? (
              <Badge variant="outline" className="text-[10px]">
                low confidence
              </Badge>
            ) : null}
          </div>
          {/* A human score carries neither a confidence nor a message count —
              the server records neither, so there is nothing truthful to put
              here. The footer names who set it instead. */}
          {byHand ? null : (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {/* Confidence is omitted when the server did not report one, rather
                  than filled in with a plausible-looking percentage. */}
              {data.confidence !== null ? (
                <>
                  Confidence{" "}
                  <strong className="text-foreground">
                    {Math.round(data.confidence * 100)}%
                  </strong>
                  {" · "}
                </>
              ) : null}
              from{" "}
              {data.messagesConsidered === 1 ? "1 message" : `${data.messagesConsidered} messages`}
            </p>
          )}
          {onScoreByHand ? (
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2 h-7 px-2 text-xs"
              onClick={onScoreByHand}
            >
              <PencilLine className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              {byHand ? "Change it" : "Score it yourself"}
            </Button>
          ) : null}
        </div>
      </div>

      {data.summary ? (
        <section className="space-y-1.5">
          <h4 className="flex items-center gap-1.5 text-xs font-medium">
            {byHand ? (
              <PencilLine className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <Sparkles className="h-3.5 w-3.5" aria-hidden />
            )}
            {/* For a human score the summary IS the reason they gave, so it is
                labelled as such rather than presented as a machine summary. */}
            {byHand ? "Why this score" : "Summary"}
          </h4>
          <p className="rounded-lg border border-border bg-background p-3 text-xs leading-relaxed text-muted-foreground">
            {data.summary}
          </p>
        </section>
      ) : null}

      {data.firedSignals.length ? (
        <section className="space-y-1.5">
          <h4 className="text-xs font-medium">What moved the score</h4>
          <ul className="space-y-1.5">
            {data.firedSignals.map((sig) => (
              <li
                key={sig.key}
                className="flex items-start gap-2 rounded-lg border border-border bg-background p-2 text-xs"
              >
                <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{sig.label || sig.key}</span>
                  {/* The text that fired it. This is what makes a score
                      arguable rather than something to be taken on faith. */}
                  {sig.evidence ? (
                    <span className="block truncate text-muted-foreground">
                      “{sig.evidence}”
                    </span>
                  ) : null}
                </span>
                <span className="num shrink-0 text-muted-foreground">
                  {sig.weight > 0 ? `+${sig.weight}` : sig.weight}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {data.recommendedAction ? (
        <section className="space-y-1.5">
          <h4 className="flex items-center gap-1.5 text-xs font-medium">
            <Lightbulb className="h-3.5 w-3.5" aria-hidden />
            What this band says to do
          </h4>
          <div className="flex items-start gap-2 rounded-lg border border-border bg-background p-2.5 text-xs">
            <p className="min-w-0 flex-1">{data.recommendedAction}</p>
            {onApplyAction ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 shrink-0 px-2 text-[10px]"
                onClick={() => onApplyAction(data.recommendedAction as string)}
              >
                Use it <ArrowRight className="ml-1 h-3 w-3" aria-hidden />
              </Button>
            ) : null}
          </div>
        </section>
      ) : null}

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2.5 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <HelpCircle className="h-3 w-3" aria-hidden />
          {/* What actually produced this, named exactly. A person is named; an
              account that no longer exists reads as "a person" rather than as
              somebody who still works here. */}
          {byHand
            ? `Set by ${data.authorName ?? "a person"}`
            : data.method === "ai" && data.provider
              ? `${data.provider}${data.model ? ` · ${data.model}` : ""}`
              : "Keyword rules"}
          {` · policy v${data.policyVersion}`}
        </span>
        <span>{new Date(data.createdAt).toLocaleString()}</span>
      </footer>
    </div>
  );
}
