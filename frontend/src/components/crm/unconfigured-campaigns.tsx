"use client";

import { AlertTriangle } from "lucide-react";

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
import { lastInteraction } from "@/lib/conversation-time";
import {
  useUnconfiguredCampaigns,
  type UnconfiguredCampaign,
} from "@/lib/queries/crm-ai";
import { ROLE_RANK } from "@/lib/types";
import { apiErrorMessage } from "@/lib/utils";
import { useSession } from "@/store/use-session";

/**
 * Campaigns that have brought in enquiries and carry no script.
 *
 * ## Why this panel exists
 *
 * The eight newest unrouted threads on 28 Nov all came from adverts of campaign
 * "blue diamond 24/11", which has no rule. Routing was behaving exactly as
 * configured — no rule, no branch, no script — and the only thing that said so
 * was a `logger.warn("no campaign matched ad X")` in a container log. From this
 * screen the campaign simply did not exist, and "nothing listed" looks
 * identical to "nothing wrong" while the clicks are being paid for.
 *
 * ## Why it sits above the scripts and not on a dashboard
 *
 * The gap belongs on the screen where it is closed. Somebody who reads
 * "blue diamond 24/11 — 8 enquiries, most recent today" is one click from the
 * "Add campaign" button that fixes it.
 *
 * ## Why it disappears when there is nothing to say
 *
 * A panel that is always on screen saying "0 problems" is furniture, and
 * furniture is not read. Nothing unconfigured, nothing rendered.
 */
export function UnconfiguredCampaignsPanel() {
  const role = useSession((s) => s.role);
  /*
   * The server is the authority — the route is store_manager and above. This
   * only decides whether to ask, so a salesperson reading the script wording
   * does not get a 403 rendered as a broken panel.
   */
  const mayRead = ROLE_RANK[role] >= ROLE_RANK.store_manager;
  const { data, isLoading, isError, error, refetch } = useUnconfiguredCampaigns(mayRead);

  if (!mayRead) return null;
  if (isLoading) return <Skeleton className="h-24 w-full" />;

  if (isError) {
    /*
     * Said out loud rather than swallowed. This panel exists because a silent
     * failure cost the client eight leads; a version of it that fails silently
     * would be the same bug wearing the fix's clothes.
     */
    return (
      <Card>
        <CardContent className="flex items-center justify-between gap-3 pt-6">
          <p className="text-sm text-destructive">
            {apiErrorMessage(error, "Could not check which campaigns have no script.")}
          </p>
          <Button size="sm" variant="outline" onClick={() => refetch()}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  const rows = data?.campaigns ?? [];
  if (rows.length === 0) return null;

  return (
    <Card className="border-amber-300/60">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden="true" />
          Campaigns with no script
          <Badge variant="secondary">{rows.length}</Badge>
        </CardTitle>
        <CardDescription>
          These have sent real enquiries in the last {data?.sinceDays ?? 30} days and no campaign
          below answers them. Until one does, the customer gets no reply from the advert and the
          thread waits unrouted — add a campaign for each, matching on its name.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.map((row) => (
          <div
            key={row.key}
            className="rounded-md border border-amber-300/60 bg-amber-50/40 p-3 dark:bg-amber-950/10"
          >
            <p className="text-sm font-medium">{campaignLabel(row)}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {enquiriesSoFar(row.enquiries)} &middot; most recent{" "}
              {lastInteraction(row.lastEnquiryAt)}
            </p>
            {/*
              The advert ids, because an unresolved campaign is named by nothing
              else and because a page-post click sends the post's id rather than
              the ad's — which is the id somebody pastes into "other ids" to make
              that one advert match.
            */}
            <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
              {row.adIds.join(", ")}
            </p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/**
 * What to call a campaign nobody configured.
 *
 * NEVER a blank row. A deleted ad, an expired token or a Graph outage all leave
 * the campaign unnamed, and those are precisely the moments the client most
 * needs to see that clicks are arriving — so the advert id stands in for the
 * name it could not be given.
 */
export function campaignLabel(row: Pick<UnconfiguredCampaign, "campaignName" | "adIds">): string {
  if (row.campaignName?.trim()) return row.campaignName.trim();
  const [first] = row.adIds;
  return first ? `Advert ${first}` : "An advert we could not identify";
}

/** "1 enquiry", not "1 enquiries" — the count is usually small and always read. */
export function enquiriesSoFar(count: number): string {
  return count === 1 ? "1 enquiry" : `${count} enquiries`;
}
