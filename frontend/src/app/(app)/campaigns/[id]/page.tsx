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
  campaign_cancelled: "Campaign cancelled",
  policy_refused_at_send: "Consent or messaging rules refused it at send time",
};

const RECIPIENT_TABS = [
  { value: "all", label: "Everyone" },
  { value: "sent", label: "Sent" },
  { value: "excluded", label: "Excluded" },
  { value: "failed", label: "Failed" },
  { value: "dead", label: "Given up" },
];

function Stat({ label, value, tone }: { label: string; value: number; tone?: "bad" | "good" }) {
  return (
    <div className="rounded-md border border-border p-3">
      <div
        className={`font-[family-name:var(--font-display-face)] text-2xl tabular-nums ${
          tone === "bad" && value > 0 ? "text-destructive" : ""
        }`}
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
  const recipients = useCampaignRecipients(id, tab === "all" ? undefined : tab);
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
          {apiErrorMessage(campaign.error, "Could not load this campaign.")}
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
        <SectionHeader title={c.name} purpose={c.description ?? "WhatsApp campaign."} />
        <div className="flex flex-wrap gap-2">
            {c.status === "awaiting_approval" && canApprove ? (
              <Button
                onClick={() =>
                  approve.mutate(
                    { id },
                    {
                      onSuccess: () => toast.success("Approved. The list is being built now."),
                      onError: (e) =>
                        toast.error(apiErrorMessage(e, "Could not approve this campaign.")),
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
                    { id, body: { reason: "Stopped from the campaign screen" } },
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
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
            <Stat label="Targeted" value={c.counts.targeted} />
            <Stat label="Excluded" value={c.counts.excluded} />
            <Stat label="Queued" value={c.counts.queued} />
            <Stat label="Sent" value={c.counts.sent} />
            <Stat label="Delivered" value={c.counts.delivered} />
            <Stat label="Failed" value={c.counts.failed} tone="bad" />
            <Stat label="Given up" value={c.counts.dead} tone="bad" />
          </div>
        </CardContent>
      </Card>

      {c.counts.excluded > 0 ? (
        <div className="flex gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            {c.counts.excluded.toLocaleString()} people were deliberately not messaged. Consent,
            a STOP reply and blocked-customer status are each enough on their own, and the check
            runs again per person at the moment of sending — so this number can grow after
            approval.
          </p>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recipients</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              {RECIPIENT_TABS.map((t) => (
                <TabsTrigger key={t.value} value={t.value}>
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          {recipients.isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : !recipients.data?.items.length ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {c.status === "draft" || c.status === "awaiting_approval"
                ? "The list is built when the campaign is approved."
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
                  {recipients.data.items.map((r) => (
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
                          {r.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-md text-xs text-muted-foreground">
                        {r.exclusionReason
                          ? (EXCLUSION_LABELS[r.exclusionReason] ?? r.exclusionReason)
                          : (r.lastError ?? "—")}
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
              {recipients.data.nextCursor ? (
                <p className="pt-3 text-xs text-muted-foreground">
                  Showing the first {recipients.data.items.length}. The counts above cover
                  everyone.
                </p>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
