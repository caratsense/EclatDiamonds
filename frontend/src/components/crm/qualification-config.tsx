"use client";

import { useState } from "react";
import { Bot, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useQualificationPolicy,
  useSaveQualificationPolicy,
  type QualificationBand,
  type QualificationSignal,
} from "@/lib/queries/crm-ai";
import { apiErrorMessage } from "@/lib/utils";

/**
 * Lead qualification rules.
 *
 * This screen exists so that no scoring rule lives in code. Weights, phrases,
 * bands and thresholds are all the tenant's, which is the difference between a
 * CRM that ranks leads the way this business sells and one that ranks them the
 * way the vendor guessed.
 *
 * It is also where the honest state of the AI provider is stated: with none
 * configured, this is exact keyword matching. That is a real qualification, and
 * calling it "AI unavailable" would suggest the feature is broken when it is
 * simply literal.
 */
export function QualificationConfig() {
  const { data, isLoading } = useQualificationPolicy();
  const save = useSaveQualificationPolicy();
  const [draft, setDraft] = useState<{
    signals?: QualificationSignal[];
    bands?: QualificationBand[];
  }>({});

  if (isLoading || !data) return <Skeleton className="h-64 w-full" />;

  const { policy, provider } = data;
  const signals = draft.signals ?? policy.signals;
  const bands = draft.bands ?? policy.bands;

  function persist(patch: Parameters<typeof save.mutateAsync>[0]) {
    save
      .mutateAsync(patch)
      .then(() => {
        setDraft({});
        toast.success("Rules saved.");
      })
      .catch((e) => toast.error(apiErrorMessage(e, "Could not save the rules.")));
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              Lead qualification
              <Badge variant={policy.enabled ? "secondary" : "outline"}>
                {policy.enabled ? "On" : "Off"}
              </Badge>
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Version {policy.version} · scores are stamped with the version that produced
              them, so an old score is never re-explained by today&apos;s rules.
            </p>
          </div>
          <Button
            size="sm"
            variant={policy.enabled ? "outline" : "default"}
            onClick={() => persist({ enabled: !policy.enabled })}
            disabled={save.isPending}
          >
            {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {policy.enabled ? "Turn off" : "Turn on"}
          </Button>
        </CardHeader>
        <CardContent>
          {/* The provider's real state, in the tenant's terms. */}
          <div className="flex items-start gap-2 rounded-lg border bg-muted/30 p-3 text-xs">
            {provider.mode === "ai" ? (
              <Bot className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
            ) : (
              <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            )}
            <p className="text-muted-foreground">
              {provider.mode === "ai"
                ? "An AI provider is connected. It reads conversations and reports which of your signals appear — your rules below still decide the score."
                : (provider.reason ??
                  "Running on your keyword rules.")}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">What to look for</CardTitle>
          <p className="text-xs text-muted-foreground">
            Each signal adds or subtracts from the score when it appears. A negative
            weight is deliberate — a complaint is urgent, but it is not a sales lead.
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          {signals.map((sig, i) => (
            <div key={sig.key} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2">
              <Input
                className="h-8 w-48"
                value={sig.label}
                aria-label={`Name for ${sig.key}`}
                onChange={(e) => {
                  const next = [...signals];
                  next[i] = { ...sig, label: e.target.value };
                  setDraft((d) => ({ ...d, signals: next }));
                }}
              />
              <Input
                type="number"
                className="h-8 w-20"
                value={sig.weight}
                aria-label={`Weight for ${sig.label}`}
                onChange={(e) => {
                  const next = [...signals];
                  next[i] = { ...sig, weight: Number(e.target.value) };
                  setDraft((d) => ({ ...d, signals: next }));
                }}
              />
              <Input
                className="h-8 flex-1 min-w-[200px]"
                value={sig.phrases.join(", ")}
                aria-label={`Phrases for ${sig.label}`}
                onChange={(e) => {
                  const next = [...signals];
                  next[i] = {
                    ...sig,
                    phrases: e.target.value.split(",").map((p) => p.trim()).filter(Boolean),
                  };
                  setDraft((d) => ({ ...d, signals: next }));
                }}
              />
            </div>
          ))}
          {draft.signals ? (
            <Button size="sm" onClick={() => persist({ signals })} disabled={save.isPending}>
              Save signals
            </Button>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">What the score means</CardTitle>
          <p className="text-xs text-muted-foreground">
            Your bands, your words, your thresholds. Nothing in CaratOS decides what
            counts as a good lead for your business.
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          {bands.map((band, i) => (
            <div key={band.key} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2">
              <Input
                className="h-8 w-40"
                value={band.label}
                aria-label={`Name for ${band.key}`}
                onChange={(e) => {
                  const next = [...bands];
                  next[i] = { ...band, label: e.target.value };
                  setDraft((d) => ({ ...d, bands: next }));
                }}
              />
              <div className="flex items-center gap-1.5">
                <Label className="text-xs text-muted-foreground">from</Label>
                <Input
                  type="number"
                  className="h-8 w-20"
                  value={band.minScore}
                  aria-label={`Minimum score for ${band.label}`}
                  onChange={(e) => {
                    const next = [...bands];
                    next[i] = { ...band, minScore: Number(e.target.value) };
                    setDraft((d) => ({ ...d, bands: next }));
                  }}
                />
              </div>
              <Input
                className="h-8 flex-1 min-w-[200px]"
                value={band.recommendedAction}
                aria-label={`Action for ${band.label}`}
                onChange={(e) => {
                  const next = [...bands];
                  next[i] = { ...band, recommendedAction: e.target.value };
                  setDraft((d) => ({ ...d, bands: next }));
                }}
              />
            </div>
          ))}
          {draft.bands ? (
            <Button size="sm" onClick={() => persist({ bands })} disabled={save.isPending}>
              Save bands
            </Button>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">When to involve a person</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <div className="grid gap-1.5">
            <Label htmlFor="q-handoff">Escalate at score</Label>
            <Input
              id="q-handoff"
              type="number"
              defaultValue={policy.handoffAtScore ?? ""}
              placeholder="off"
              onBlur={(e) =>
                persist({
                  // Blank switches score-based escalation off entirely, rather
                  // than falling back to a threshold the tenant did not choose.
                  handoffAtScore: e.target.value === "" ? null : Number(e.target.value),
                })
              }
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="q-confidence">Minimum confidence (0-1)</Label>
            <Input
              id="q-confidence"
              type="number"
              step="0.05"
              min={0}
              max={1}
              defaultValue={policy.confidenceThreshold}
              onBlur={(e) => persist({ confidenceThreshold: Number(e.target.value) })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="q-min-messages">Messages needed to score</Label>
            <Input
              id="q-min-messages"
              type="number"
              min={0}
              defaultValue={policy.minMessagesToScore}
              onBlur={(e) => persist({ minMessagesToScore: Number(e.target.value) })}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
