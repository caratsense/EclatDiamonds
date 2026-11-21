"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  CheckCircle2,
  RefreshCw,
  ShieldCheck,
  ThumbsUp,
} from "lucide-react";
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
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  CAMPAIGN_STATUS_LABELS,
  useApproveCampaign,
  useCampaign,
  useCampaignRecipients,
  useCancelCampaign,
  useRetryCampaign,
  type CampaignCounts,
} from "@/lib/queries/campaigns";
import { ROLE_RANK } from "@/lib/types";
import { apiErrorMessage } from "@/lib/utils";
import { useSession } from "@/store/use-session";

/**
 * Why a person was not messaged, in words they can act on.
 *
 * The API stores machine reasons so they stay stable; the translation belongs
 * here rather than in the database, where changing the wording would mean
 * rewriting history.
 */
const EXCLUSION_LABELS: Record<string, string> = {
  blocked_customer: "Blocked customer",
  campaign_cancelled: "Broadcast cancelled",
  /*
   * Deliberately vague no longer.
   *
   * This read "Consent or messaging rules refused it at send time" for every
   * refusal, so the owner — who had already told us his customer list IS the
   * permission — kept reading "consent" for customers whose real problem was
   * an unusable number or a thread not linked to any customer. The row now
   * shows the server's own sentence when there is one, and falls back to this
   * only when there is not.
   */
  policy_refused_at_send: "The messaging rules refused it at send time",
};

/**
 * The tabs, as questions rather than column values.
 *
 * They used to be the raw statuses: Everyone, Sent, Excluded, Failed, Given
 * up. "Sent" therefore meant the seven people whose delivery receipt had not
 * come back yet — not the 145 who got the message — and the 138 who were
 * delivered or had already read it could not be listed at all. The owner's
 * words: "it's not showing sent, all names, only 7 people I can see in the
 * sent tab... we cannot clearly see who all received what each means."
 *
 * `count` reads the campaign's own figures, so a tab never disagrees with the
 * delivery row above it.
 */
const RECIPIENT_TABS: {
  value: string;
  label: string;
  count: (c: CampaignCounts) => number;
  hint?: string;
}[] = [
  { value: "all", label: "Everyone", count: (c) => c.targeted + c.excluded },
  {
    value: "reached",
    label: "Got it",
    count: (c) => c.sent + c.delivered + c.read,
    hint: "The message arrived on their phone.",
  },
  { value: "read", label: "Read", count: (c) => c.read, hint: "They opened and read it." },
  {
    value: "delivered",
    label: "Delivered",
    count: (c) => c.delivered,
    hint: "It reached their phone; they have not opened it yet.",
  },
  {
    value: "sent",
    label: "Sent, no receipt",
    count: (c) => c.sent,
    hint: "WhatsApp accepted it but has not confirmed delivery yet.",
  },
  {
    value: "not_reached",
    label: "Did not arrive",
    count: (c) => c.failed + c.dead,
    hint: "WhatsApp refused it. The reason is on each row.",
  },
  {
    value: "excluded",
    label: "Not messaged",
    count: (c) => c.excluded,
    hint: "Left out before sending — no usable number, opted out, or blocked.",
  },
];

/** What a row's status means, in the words a person would use. */
const STATUS_WORDS: Record<string, string> = {
  read: "Read",
  delivered: "Delivered",
  sent: "Sent",
  queued: "Waiting to send",
  pending: "Waiting to send",
  failed: "Did not arrive",
  // Never "dead" on a screen. It is a queue word for a row that has used up
  // its attempts, and it reads as something that happened to the customer.
  dead: "Did not arrive",
  excluded: "Not messaged",
  cancelled: "Cancelled",
};

/**
 * One figure on the delivery row.
 *
 * `muted` is for a figure that is part of another one on the same row — the
 * readers are also among the reached — so the eye reads the headline number
 * first and the breakdown as detail under it, rather than as four totals to
 * add together.
 */
function Stat({
  label,
  value,
  tone,
  muted,
}: {
  label: string;
  value: number;
  tone?: "bad" | "good";
  muted?: boolean;
}) {
  const colour =
    tone === "bad" && value > 0
      ? "text-destructive"
      : tone === "good" && value > 0
        ? "text-emerald-600 dark:text-emerald-400"
        : "";
  return (
    <div className={`rounded-md border p-3 ${muted ? "border-dashed border-border/60" : "border-border"}`}>
      <div
        className={`font-[family-name:var(--font-display-face)] tabular-nums ${
          muted ? "text-xl text-muted-foreground" : "text-2xl"
        } ${colour}`}
      >
        {value.toLocaleString()}
      </div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

export default function CampaignDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const role = useSession((s) => s.role);
  const [tab, setTab] = useState("all");

  const campaign = useCampaign(id);
  const [page, setPage] = useState(1);
  const recipients = useCampaignRecipients(id, tab === "all" ? undefined : tab, page);
  const recipientRows = recipients.data?.items ?? [];
  const approve = useApproveCampaign();
  const cancel = useCancelCampaign();
  const retry = useRetryCampaign();

  const canApprove = ROLE_RANK[role] >= ROLE_RANK.area_manager;

  if (campaign.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (campaign.isError || !campaign.data) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" asChild>
          <Link href="/campaigns">
            <ArrowLeft className="mr-2 h-4 w-4" />
            All campaigns
          </Link>
        </Button>
        <p className="text-sm text-muted-foreground">
          {apiErrorMessage(campaign.error, "Could not load this broadcast.")}
        </p>
      </div>
    );
  }

  const c = campaign.data;
  const inFlight = ["expanding", "queued", "sending"].includes(c.status);
  const stoppable = [
    "draft",
    "awaiting_approval",
    "approved",
    "scheduled",
    "expanding",
    "queued",
    "sending",
  ].includes(c.status);

  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" asChild className="-ml-2">
        <Link href="/campaigns">
          <ArrowLeft className="mr-2 h-4 w-4" />
          All campaigns
        </Link>
      </Button>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <SectionHeader title={c.name} purpose={c.description ?? "WhatsApp broadcast."} />
        <div className="flex flex-wrap gap-2">
            {c.status === "awaiting_approval" && canApprove ? (
              <Button
                onClick={() =>
                  approve.mutate(
                    { id },
                    {
                      onSuccess: () => toast.success("Approved. The list is being built now."),
                      onError: (e) =>
                        toast.error(apiErrorMessage(e, "Could not approve this broadcast.")),
                    },
                  )
                }
                disabled={approve.isPending}
              >
                <ThumbsUp className="mr-2 h-4 w-4" />
                Approve and send
              </Button>
            ) : null}
            {c.counts.failed > 0 && !inFlight ? (
              <Button
                variant="outline"
                onClick={() =>
                  retry.mutate(
                    { id },
                    {
                      onSuccess: (r) =>
                        toast.success(
                          `Retrying ${(r as unknown as { retried?: number })?.retried ?? 0} recipients.`,
                        ),
                      onError: (e) => toast.error(apiErrorMessage(e, "Could not retry.")),
                    },
                  )
                }
                disabled={retry.isPending}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Retry failed
              </Button>
            ) : null}
            {stoppable ? (
              <Button
                variant="outline"
                onClick={() =>
                  cancel.mutate(
                    { id, body: { reason: "Stopped from the broadcast screen" } },
                    {
                      onSuccess: () => toast.success("Cancelled. Nobody else will be messaged."),
                      onError: (e) => toast.error(apiErrorMessage(e, "Could not cancel.")),
                    },
                  )
                }
                disabled={cancel.isPending}
              >
                <Ban className="mr-2 h-4 w-4" />
                Cancel
              </Button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={c.status === "failed" ? "destructive" : "secondary"}>
          {CAMPAIGN_STATUS_LABELS[c.status]}
        </Badge>
        {c.templateName ? (
          <Badge variant="outline">
            {c.templateName} · {c.templateLanguage}
          </Badge>
        ) : null}
        {inFlight ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <RefreshCw className="h-3 w-3 animate-spin" />
            Updating automatically
          </span>
        ) : null}
      </div>

      {c.lastError ? (
        <div className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{c.lastError}</span>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Delivery</CardTitle>
          <CardDescription>
            Counted in the database across the whole campaign, not from the rows listed below.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/*
            REACHED FIRST, AND THE READERS COUNTED.

            This row used to run Targeted / Excluded / Queued / Sent /
            Delivered / Failed / Given up — with no tile for `read`, which the
            API had been returning all along. On the nails-event broadcast that
            left 59 of 126 people nowhere on the screen: the tiles added up to
            67, the customer who had opened and read the invitation was counted
            as neither delivered nor anything else, and the campaign looked
            like it had reached a third of the list when it had reached four
            fifths of it.

            `Reached` leads because it is the question the screen is opened to
            answer. The three states underneath it are the same people in more
            detail, which is why they are muted — a reader is also delivered,
            and showing both as equals invites adding them together.
          */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
            <Stat label="Targeted" value={c.counts.targeted} />
            <Stat
              label="Reached"
              value={c.counts.sent + c.counts.delivered + c.counts.read}
              tone="good"
            />
            <Stat label="Read" value={c.counts.read} muted />
            <Stat label="Delivered" value={c.counts.delivered} muted />
            <Stat label="Sent" value={c.counts.sent} muted />
            <Stat label="Queued" value={c.counts.queued} />
            <Stat label="Failed" value={c.counts.failed} tone="bad" />
            <Stat label="Given up" value={c.counts.dead} tone="bad" />
          </div>
          <p className="pt-3 text-xs text-muted-foreground">
            {/* Said plainly, because three of the tiles above are subsets of
                one another and somebody will otherwise add them up. */}
            Reached counts everyone the message got to — sent, delivered and
            read are the same people at different stages.
            {c.counts.excluded > 0
              ? ` ${c.counts.excluded} more were not messaged; the reasons are below.`
              : ""}
          </p>
        </CardContent>
      </Card>

      {c.counts.excluded > 0 ? (
        <div className="flex gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            {c.counts.excluded.toLocaleString()} of them were not messaged — each one is listed
            below with the reason. A customer who has replied STOP, one marked blocked, and one
            whose number cannot be messaged are each enough on their own, and every person is
            checked again at the moment of sending, so this number can grow after approval.
          </p>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recipients</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Page 1 on every tab change: "Sent" has seven rows and the reader
              could be on page four of "Everyone" when they switch. */}
          <Tabs
            value={tab}
            onValueChange={(v) => {
              setTab(v);
              setPage(1);
            }}
          >
            <TabsList>
              {RECIPIENT_TABS.map((t) => (
                <TabsTrigger key={t.value} value={t.value} title={t.hint}>
                  {t.label}
                  {/* The count on the tab itself, from the campaign's own
                      figures. Without it somebody opens a tab to find out how
                      many are behind it, and an empty one looks broken rather
                      than empty. */}
                  <span className="ml-1.5 tabular-nums opacity-60">{t.count(c.counts)}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          {/* What the tab they are on actually means. One line, under the
              tabs, because every one of these words is a WhatsApp distinction
              rather than an ordinary English one. */}
          {RECIPIENT_TABS.find((t) => t.value === tab)?.hint ? (
            <p className="pb-1 pt-2 text-xs text-muted-foreground">
              {RECIPIENT_TABS.find((t) => t.value === tab)?.hint}
            </p>
          ) : null}

          {recipients.isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : !recipientRows.length ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {c.status === "draft" || c.status === "awaiting_approval"
                ? "The list is built when the broadcast is approved."
                : "Nothing here."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Contact</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Why</TableHead>
                    <TableHead>Sent</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recipientRows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-[family-name:var(--font-mono-face)] text-sm">
                        {r.contact ?? "—"}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            r.status === "sent" || r.status === "delivered" || r.status === "read"
                              ? "success"
                              : r.status === "failed" || r.status === "dead"
                                ? "destructive"
                                : "outline"
                          }
                        >
                          {STATUS_WORDS[r.status] ?? r.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-md text-xs text-muted-foreground">
                        {/*
                          The server's own sentence first. It names the actual
                          problem — "that is not a usable WhatsApp number" —
                          where the category label can only say a rule refused
                          it, which is what had fifty rows reading the same
                          unhelpful line.
                        */}
                        {r.lastError ??
                          (r.exclusionReason
                            ? (EXCLUSION_LABELS[r.exclusionReason] ?? r.exclusionReason)
                            : "—")}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {r.sentAt ? (
                          <span className="flex items-center gap-1">
                            <CheckCircle2 className="h-3 w-3" />
                            {new Date(r.sentAt).toLocaleString()}
                          </span>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {/* Numbered pages, because somebody reading this is looking for
                  one person among a few hundred and needs to get back to the
                  page they were just on. The range is spelled out so the list
                  never again hides four fifths of itself behind a count. */}
              <div className="flex flex-wrap items-center justify-between gap-3 pt-3">
                <p className="text-xs text-muted-foreground tabular-nums">
                  {recipients.data
                    ? recipients.data.total === 0
                      ? "None here."
                      : `${(recipients.data.page - 1) * recipients.data.pageSize + 1}–${Math.min(
                          recipients.data.page * recipients.data.pageSize,
                          recipients.data.total,
                        )} of ${recipients.data.total}`
                    : ""}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1 || recipients.isFetching}
                  >
                    Previous
                  </Button>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    Page {recipients.data?.page ?? page} of {recipients.data?.pageCount ?? 1}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((p) => p + 1)}
                    disabled={
                      recipients.isFetching ||
                      page >= (recipients.data?.pageCount ?? 1)
                    }
                  >
                    Next
                  </Button>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
