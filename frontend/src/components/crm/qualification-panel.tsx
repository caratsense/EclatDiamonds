"use client";

import { Bot, Loader2, ShieldQuestion, Sparkles, TrendingUp, UserCog } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useAssessConversation,
  useAssessLead,
  useLatestQualification,
  type Qualification,
} from "@/lib/queries/crm-ai";
import { apiErrorMessage } from "@/lib/utils";

/**
 * Lead qualification, shown where someone is about to act on it.
 *
 * WHAT THIS SCREEN REFUSES TO DO, because each would make the number look more
 * authoritative than it is:
 *
 *  - It never shows a bare score. The signals that produced it are listed with
 *    the text that fired each one, so a salesperson can disagree with a "hot"
 *    lead by reading the reason rather than by trusting a badge.
 *  - It never shows a score of zero for "we could not assess". Those are
 *    different statements and the screen says which one it is.
 *  - It never implies a model was involved when one was not. With no provider
 *    configured this is the tenant's own keyword rules, and it says so.
 */
export function QualificationPanel({
  partyId,
  leadId,
  conversationId,
}: {
  partyId?: string;
  leadId?: string;
  conversationId?: string;
}) {
  const { data, isLoading } = useLatestQualification({ partyId, leadId, conversationId });
  const assessConversation = useAssessConversation();
  const assessLead = useAssessLead();
  const busy = assessConversation.isPending || assessLead.isPending;

  function run() {
    const action = conversationId
      ? assessConversation.mutateAsync(conversationId)
      : leadId
        ? assessLead.mutateAsync(leadId)
        : null;
    if (!action) return;
    action.catch((e) => toast.error(apiErrorMessage(e, "Could not assess this.")));
  }

  const canAssess = !!(conversationId || leadId);

  if (isLoading) return <Skeleton className="h-40 w-full" />;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <TrendingUp className="h-4 w-4 text-muted-foreground" />
          Qualification
        </CardTitle>
        {canAssess ? (
          <Button size="sm" variant="outline" onClick={run} disabled={busy}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {data ? "Re-assess" : "Assess"}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {!data ? (
          <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
            Not assessed yet.
            {canAssess ? " Run an assessment to see how this lead scores against your rules." : ""}
          </p>
        ) : (
          <QualificationBody q={data} />
        )}
      </CardContent>
    </Card>
  );
}

function QualificationBody({ q }: { q: Qualification }) {
  // "Could not assess" is rendered as its own state, never as a zero score.
  if (!q.available) {
    return (
      <div className="flex items-start gap-2 rounded-lg border bg-muted/30 p-3 text-sm">
        <ShieldQuestion className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div>
          <p className="font-medium">No score</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{q.unavailableReason}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-baseline gap-1.5">
          <span className="num text-3xl font-semibold">{q.score}</span>
          <span className="text-sm text-muted-foreground">/ 100</span>
        </div>
        {q.bandLabel ? <Badge variant="secondary">{q.bandLabel}</Badge> : null}
        <Badge variant="outline" className="gap-1">
          {q.method === "ai" ? (
            <>
              <Bot className="h-3 w-3" />
              {q.model ?? "AI"}
            </>
          ) : (
            <>
              <Sparkles className="h-3 w-3" />
              Your rules
            </>
          )}
        </Badge>
        {q.confidence != null ? (
          <span className="text-xs text-muted-foreground">
            confidence {Math.round(q.confidence * 100)}%
          </span>
        ) : null}
      </div>

      {q.lowConfidence ? (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs">
          Below your confidence threshold — read the evidence before acting on this.
        </p>
      ) : null}

      {q.recommendedAction ? (
        <p className="text-sm">
          <span className="font-medium">Suggested: </span>
          {q.recommendedAction}
        </p>
      ) : null}

      {q.handoffRequested ? (
        <p className="flex items-start gap-2 rounded-md border border-[var(--gold)]/40 bg-[var(--gold)]/5 px-3 py-2 text-xs">
          <UserCog className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {q.handoffReason ?? "A person should take this over."}
        </p>
      ) : null}

      {q.summary ? <p className="text-sm text-muted-foreground">{q.summary}</p> : null}

      {/* The "why". Without this the score is an oracle. */}
      {q.firedSignals.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Why
          </p>
          {q.firedSignals.map((s) => (
            <div key={s.key} className="rounded-md border px-3 py-1.5 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{s.label}</span>
                <span className={`num ${s.weight < 0 ? "text-destructive" : "text-emerald-600"}`}>
                  {s.weight > 0 ? "+" : ""}
                  {s.weight}
                </span>
              </div>
              {s.evidence ? (
                <p className="mt-0.5 italic text-muted-foreground">“{s.evidence}”</p>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          None of your signals came up in what this customer said.
        </p>
      )}

      {Object.keys(q.requirements).length > 0 ? (
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            What they told us
          </p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            {Object.entries(q.requirements).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="capitalize text-muted-foreground">{k}</dt>
                <dd className="font-medium">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      <p className="text-[11px] text-muted-foreground">
        Read {q.messagesConsidered} message{q.messagesConsidered === 1 ? "" : "s"} ·{" "}
        {new Date(q.createdAt).toLocaleString()}
        {/* A score produced under rules that have since changed must say so, or
            someone will defend today's decision with yesterday's policy. */}
        {q.policyOutdated ? " · your rules have changed since this was scored" : ""}
      </p>
    </div>
  );
}
