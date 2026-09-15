"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Link2, MessageSquareHeart, Save, Star } from "lucide-react";
import { toast } from "sonner";

import { SectionHeader } from "@/components/section/section-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useFeedbackResponses,
  useFeedbackSettings,
  useFeedbackSummary,
  useUpdateFeedbackSettings,
} from "@/lib/queries/feedback";
import { ROLE_RANK } from "@/lib/types";
import { apiErrorMessage } from "@/lib/utils";
import { useSession } from "@/store/use-session";
import { AfterVisitCard } from "@/components/feedback/after-visit-card";

/**
 * Feedback.
 *
 * The settings half is where a manager decides which ratings are offered the
 * public review link. The screen states the rule in words as well as numbers,
 * because "positive threshold 4" does not tell anyone that a 2 goes to a person
 * instead.
 */

function Stars({ value }: { value: number | null }) {
  if (value === null) return <span className="text-sm text-muted-foreground">No answers yet</span>;
  return (
    <span className="flex items-center gap-1">
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          className={`h-4 w-4 ${n <= Math.round(value) ? "fill-current" : "text-muted-foreground"}`}
        />
      ))}
    </span>
  );
}

export default function FeedbackPage() {
  const role = useSession((s) => s.role);
  const stores = useSession((s) => s.stores);
  const realStores = useMemo(() => stores.filter((s) => !s.isAggregate), [stores]);
  const isManager = ROLE_RANK[role] >= ROLE_RANK.store_manager;

  const [tab, setTab] = useState("all");
  const summary = useFeedbackSummary();
  const responses = useFeedbackResponses(tab === "escalated" ? { escalatedOnly: true } : {});
  const settings = useFeedbackSettings();
  const update = useUpdateFeedbackSettings();

  const [links, setLinks] = useState<Record<string, string> | null>(null);
  const effectiveLinks = links ?? settings.data?.reviewLinks ?? {};

  const saveLinks = () => {
    update.mutate(
      { reviewLinks: effectiveLinks },
      {
        onSuccess: () => {
          toast.success("Review links saved.");
          setLinks(null);
        },
        onError: (e) => toast.error(apiErrorMessage(e, "Could not save the review links.")),
      },
    );
  };

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Feedback"
        purpose="Ask a customer how it went. A happy answer can be invited to review you publicly; an unhappy one goes to a person."
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">Average rating</div>
            <div className="mt-1 flex items-center gap-2">
              <span className="font-[family-name:var(--font-display-face)] text-3xl tabular-nums">
                {summary.data?.averageRating ?? "—"}
              </span>
              <Stars value={summary.data?.averageRating ?? null} />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">Answers</div>
            <div className="mt-1 font-[family-name:var(--font-display-face)] text-3xl tabular-nums">
              {summary.data?.responses ?? "—"}
            </div>
            <div className="text-xs text-muted-foreground">
              of {summary.data?.asked ?? "—"} asked
              {summary.data?.responseRate !== null && summary.data?.responseRate !== undefined
                ? ` · ${summary.data.responseRate}%`
                : ""}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">Escalated to a person</div>
            <div
              className={`mt-1 font-[family-name:var(--font-display-face)] text-3xl tabular-nums ${
                (summary.data?.escalated ?? 0) > 0 ? "text-destructive" : ""
              }`}
            >
              {summary.data?.escalated ?? "—"}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">Window</div>
            <div className="mt-1 font-[family-name:var(--font-display-face)] text-3xl tabular-nums">
              {summary.data?.windowDays ?? "—"}d
            </div>
          </CardContent>
        </Card>
      </div>

      {isManager && settings.data ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Link2 className="h-4 w-4" />
              Public review links
            </CardTitle>
            <CardDescription>
              One link per branch, because a Google Business Profile belongs to a location. A
              customer who rates{" "}
              <strong>{settings.data.positiveThreshold} or more</strong> is offered their
              branch&apos;s link. A customer who rates{" "}
              <strong>{settings.data.escalateAtOrBelow} or less</strong> is never shown it and a
              task is raised for someone to call them.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {realStores.map((s) => (
              <div key={s.id} className="grid gap-2 sm:grid-cols-[12rem_minmax(0,1fr)]">
                <Label className="pt-2 text-sm">{s.name}</Label>
                <Input
                  value={effectiveLinks[s.id] ?? ""}
                  onChange={(e) =>
                    setLinks({ ...effectiveLinks, [s.id]: e.target.value })
                  }
                  placeholder="https://g.page/r/…"
                  inputMode="url"
                />
              </div>
            ))}
            <div className="flex items-center gap-2 pt-1">
              <Button onClick={saveLinks} disabled={update.isPending || !links}>
                <Save className="mr-2 h-4 w-4" />
                Save links
              </Button>
              <p className="text-xs text-muted-foreground">
                Must be an https address. A branch with no link invites nobody.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {isManager ? <AfterVisitCard /> : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">What customers said</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="all">All answers</TabsTrigger>
              <TabsTrigger value="escalated">Needs a person</TabsTrigger>
            </TabsList>
          </Tabs>

          {responses.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : responses.isError ? (
            <p className="text-sm text-muted-foreground">
              {apiErrorMessage(responses.error, "Could not load the answers.")}
            </p>
          ) : !responses.data?.items.length ? (
            <EmptyState
              icon={MessageSquareHeart}
              title={tab === "escalated" ? "Nobody is unhappy" : "No answers yet"}
              description={
                tab === "escalated"
                  ? "Low ratings appear here with a task attached."
                  : "Ask a customer for feedback after a visit or an order."
              }
            />
          ) : (
            <div className="space-y-2">
              {responses.data.items.map((r) => (
                <div key={r.id} className="space-y-1.5 rounded-md border border-border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Stars value={r.rating} />
                    <span className="text-sm font-medium">{r.customer?.name ?? "Anonymous"}</span>
                    {r.escalated ? (
                      <Badge variant="destructive" className="text-[10px]">
                        <AlertTriangle className="mr-1 h-3 w-3" />
                        Escalated
                      </Badge>
                    ) : null}
                    {r.reviewLinkOffered ? (
                      <Badge variant="outline" className="text-[10px]">
                        Review link offered
                      </Badge>
                    ) : null}
                    <span className="ml-auto text-xs text-muted-foreground">
                      {r.respondedAt ? new Date(r.respondedAt).toLocaleDateString() : ""}
                    </span>
                  </div>
                  {r.comment ? <p className="text-sm">{r.comment}</p> : null}
                  {r.escalatedTaskId ? (
                    <Link
                      href="/calling"
                      className="text-xs underline underline-offset-4 hover:no-underline"
                    >
                      Open the follow-up task
                    </Link>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
