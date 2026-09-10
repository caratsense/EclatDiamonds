"use client";

import { useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Megaphone,
  Plus,
  Send,
  XCircle,
} from "lucide-react";

import { SectionHeader } from "@/components/section/section-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
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
  useCampaigns,
  type Campaign,
  type CampaignStatus,
} from "@/lib/queries/campaigns";
import { apiErrorMessage } from "@/lib/utils";

/** Which visual weight each state carries. Failure must not read as success. */
const STATUS_TONE: Record<CampaignStatus, "success" | "warning" | "destructive" | "secondary" | "outline"> = {
  draft: "outline",
  awaiting_approval: "warning",
  approved: "secondary",
  scheduled: "secondary",
  expanding: "secondary",
  queued: "secondary",
  sending: "secondary",
  completed: "success",
  partially_failed: "warning",
  cancelled: "outline",
  failed: "destructive",
};

const FILTERS: { value: string; label: string }[] = [
  { value: "all", label: "All" },
  { value: "draft", label: "Drafts" },
  { value: "awaiting_approval", label: "Awaiting approval" },
  { value: "sending", label: "Sending" },
  { value: "completed", label: "Sent" },
];

function fmtDate(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The delivery figure in one line.
 *
 * Deliberately shows what was EXCLUDED beside what was sent. A campaign summary
 * that reports only successes lets a tenant believe they reached everyone when
 * consent quietly removed half the list.
 */
function DeliveryCell({ campaign }: { campaign: Campaign }) {
  const c = campaign.counts;
  if (campaign.status === "draft" || campaign.status === "awaiting_approval") {
    return <span className="text-xs text-muted-foreground">Not sent yet</span>;
  }
  const bad = c.failed + c.dead;
  return (
    <div className="space-y-0.5 text-xs tabular-nums">
      <div className="flex items-center gap-1.5">
        <Send className="h-3 w-3 text-muted-foreground" />
        <span className="font-medium">{c.sent + c.delivered + c.read}</span>
        <span className="text-muted-foreground">of {c.targeted}</span>
      </div>
      {c.excluded > 0 ? (
        <div className="text-muted-foreground">{c.excluded} excluded</div>
      ) : null}
      {bad > 0 ? (
        <div className="flex items-center gap-1 text-destructive">
          <AlertTriangle className="h-3 w-3" />
          {bad} failed
        </div>
      ) : null}
    </div>
  );
}

export default function CampaignsPage() {
  const [filter, setFilter] = useState("all");
  const campaigns = useCampaigns(filter === "all" ? undefined : filter);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <SectionHeader
          title="Campaigns"
          purpose="Reach a group of customers on WhatsApp, with consent checked for every person at the moment of sending."
        />
        <Button asChild>
          <Link href="/campaigns/new">
            <Plus className="mr-2 h-4 w-4" />
            New campaign
          </Link>
        </Button>
      </div>

      <Tabs value={filter} onValueChange={setFilter}>
        <TabsList>
          {FILTERS.map((f) => (
            <TabsTrigger key={f.value} value={f.value}>
              {f.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your campaigns</CardTitle>
        </CardHeader>
        <CardContent>
          {campaigns.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : campaigns.isError ? (
            <p className="text-sm text-muted-foreground">
              {apiErrorMessage(campaigns.error, "Could not load your campaigns.")}
            </p>
          ) : !campaigns.data?.length ? (
            <EmptyState
              icon={Megaphone}
              title="No campaigns yet"
              description="A campaign sends one approved message to a group of customers you choose."
            />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Campaign</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Audience</TableHead>
                    <TableHead>Delivery</TableHead>
                    <TableHead>Scheduled</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {campaigns.data.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell>
                        <Link
                          href={`/campaigns/${c.id}`}
                          className="font-medium hover:underline"
                        >
                          {c.name}
                        </Link>
                        <div className="text-xs text-muted-foreground">
                          {c.templateName ? `${c.templateName} · ${c.templateLanguage}` : "No template"}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS_TONE[c.status]}>
                          {CAMPAIGN_STATUS_LABELS[c.status]}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm tabular-nums">
                        {c.counts.targeted + c.counts.excluded || "—"}
                      </TableCell>
                      <TableCell>
                        <DeliveryCell campaign={c} />
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {c.scheduledAt ? (
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {fmtDate(c.scheduledAt)}
                          </span>
                        ) : c.finishedAt ? (
                          <span className="flex items-center gap-1">
                            {c.status === "cancelled" ? (
                              <XCircle className="h-3 w-3" />
                            ) : (
                              <CheckCircle2 className="h-3 w-3" />
                            )}
                            {fmtDate(c.finishedAt)}
                          </span>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
