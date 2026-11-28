"use client";

import { useState } from "react";
import Link from "next/link";
import { Megaphone } from "lucide-react";

import { BarChart, horizontalBarHeight, type ChartSeries } from "@/components/chart/echart";
import { SectionHeader } from "@/components/section/section-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { HelpNote } from "@/components/ui/help-note";
import { Skeleton } from "@/components/ui/skeleton";
import { STAT_LABEL, STAT_VALUE_SM } from "@/components/ui/stat";
import { StatusPill } from "@/components/ui/status-pill";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatNumber, formatPercent } from "@/lib/format";
import { getNavItem } from "@/lib/navigation";
import {
  AD_ENQUIRY_WINDOWS,
  useAdEnquiries,
  type AdEnquiryBranch,
  type AdEnquiryCampaign,
} from "@/lib/queries/ad-enquiries";
import { apiErrorMessage } from "@/lib/utils";
import { useSession } from "@/store/use-session";

import { advertLabel, campaignLabel, chartRows } from "./ad-enquiry-labels";

/**
 * Which advert is bringing the most enquiries (client, 28 Nov).
 *
 * In her words: "kaun se ad pe mujhe sabse zyada number of messages aa rahe
 * hain? Because I can see hum teen chaar ads run kar rahe hain, aur usme se sab
 * pe replies aa rahe hain. So I want like a count."
 *
 * ## Four things the screen is careful about
 *
 * **Arrived and wrote again are separate columns.** A Click-to-WhatsApp tap
 * sends the customer's first message for them, so every tap looks like a
 * conversation. The column is labelled "wrote again" rather than "replied" so
 * nobody reads it as OUR reply rate, which is a different measure with its own
 * screen (Response time).
 *
 * **The window and the branch scope are written on the page.** A manager
 * reading their own branch's figures must not take them for the chain's.
 *
 * **An advert Meta would not name is still listed**, by its id, with the
 * reason beside it. Dropping it would under-count the very thing being
 * measured, and would do so hardest when the Meta connection is broken.
 *
 * **No money anywhere.** Spend, cost-per-enquiry and ROAS live on the measured
 * performance view, which knows which days were actually fetched from Meta. A
 * cost figure assembled here would be a guess about real money.
 */
export default function AdEnquiriesPage() {
  const item = getNavItem("ad-enquiries");
  const role = useSession((s) => s.role);
  const currentStore = useSession((s) => s.currentStore);
  const [days, setDays] = useState<number>(30);

  const query = useAdEnquiries(days);
  const data = query.data;
  const campaigns = data?.campaigns ?? [];
  const { rows, hidden } = chartRows(campaigns);

  const series: ChartSeries[] = [
    { name: "Enquiries", data: rows.map((r) => r.enquiries) },
    { name: "Wrote again", data: rows.map((r) => r.replied) },
  ];

  return (
    <div>
      <SectionHeader
        title={item?.title ?? "Advert Enquiries"}
        purpose={item?.purpose}
        actions={
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {AD_ENQUIRY_WINDOWS.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDays(d)}
                className={
                  days === d
                    ? "font-semibold text-foreground underline underline-offset-4"
                    : "hover:text-foreground"
                }
              >
                {d}d
              </button>
            ))}
          </div>
        }
      />

      <div className="space-y-5">
        {/*
          The scope, stated rather than implied. Written from the server's own
          answer — the window it actually used and the branches it actually
          counted — so it cannot drift from the figures beneath it.
        */}
        {data ? (
          <HelpNote
            label="What is counted"
            more={
              <span>
                An <strong>enquiry</strong> is one customer thread that a Meta advert opened in
                this window. <strong>Wrote again</strong> counts the threads where the customer
                sent a second message of their own — tapping the advert sends the first one for
                them, so arriving and having a conversation are not the same thing. This is not
                our reply rate; for that, see{" "}
                <Link href="/conversations/sla" className="underline">
                  Response time
                </Link>
                . No spend, cost-per-enquiry or return figure appears here: those come from
                measured Meta spend for a named ad account and date range, and are read on the
                campaign performance view.
              </span>
            }
          >
            Last {data.windowDays} days ·{" "}
            {scopeLine(role, currentStore?.name, data.storeIds.length)} ·{" "}
            {data.includesUnrouted
              ? "includes enquiries that reached no branch"
              : "enquiries that reached no branch are not yours to see and are not counted here"}
          </HelpNote>
        ) : null}

        {query.isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : query.isError ? (
          <Card>
            <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6">
              <p className="text-sm text-destructive">
                {apiErrorMessage(query.error, "Could not count enquiries by advert.")}
              </p>
              <Button size="sm" variant="outline" onClick={() => query.refetch()}>
                Retry
              </Button>
            </CardContent>
          </Card>
        ) : !data || data.totals.enquiries === 0 ? (
          <EmptyState
            icon={Megaphone}
            title="No advert brought anybody in this window"
            description={
              `Nothing tapped through from a Meta advert in the last ${data?.windowDays ?? days} days. ` +
              "Try a longer window, or check that the adverts you are running send people to WhatsApp."
            }
          />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <Tile label="Enquiries" value={formatNumber(data.totals.enquiries)} />
              <Tile label="Wrote again" value={formatNumber(data.totals.replied)} />
              <Tile
                label="Wrote again (share)"
                /* Null, not zero, when nothing arrived — "0%" on a ranking screen
                   reads as a failing advert rather than an empty window. */
                value={formatPercent(data.totals.repliedPct, 0)}
              />
              <Tile label="Campaigns" value={formatNumber(data.totals.campaigns)} />
              <Tile
                label="No branch"
                value={formatNumber(data.totals.unrouted)}
                tone={
                  data.totals.unrouted > 0 ? "text-rose-600 dark:text-rose-400" : undefined
                }
              />
            </div>

            {data.totals.unrouted > 0 ? (
              <Card className="border-amber-300/60">
                <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6">
                  <p className="text-sm">
                    <strong className="num">{formatNumber(data.totals.unrouted)}</strong> of these
                    enquiries reached no branch, so nobody at a shop is answering them. That means
                    the advert has no routing rule.
                  </p>
                  <Button asChild size="sm" variant="outline">
                    <Link href="/bot-script">Set up routing</Link>
                  </Button>
                </CardContent>
              </Card>
            ) : null}

            <Card>
              <CardHeader>
                <CardTitle>Enquiries by campaign</CardTitle>
                <CardDescription>
                  Ranked by how many people arrived, over the last {data.windowDays} days.
                  {hidden > 0
                    ? ` The ${hidden} smallest campaign${hidden === 1 ? "" : "s"} ${
                        hidden === 1 ? "is" : "are"
                      } in the table below rather than on the chart.`
                    : ""}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {/* A row per campaign: campaign names are long and of uneven
                    length, which is what `horizontal` is for. */}
                <BarChart
                  categories={rows.map((r) => r.label)}
                  series={series}
                  horizontal
                  showLegend
                  height={horizontalBarHeight(rows.length, series.length)}
                  valueFormatter={(v) => formatNumber(v)}
                  emptyMessage="No advert brought anybody in this window"
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Every campaign, with its adverts</CardTitle>
                <CardDescription>
                  One campaign usually runs several adverts, and a WhatsApp referral only ever
                  carries the advert&rsquo;s id — so the adverts are listed beneath the campaign
                  they belong to.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="rounded-lg border">
                  <Table maxHeight="70vh">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Campaign / advert</TableHead>
                        <TableHead className="text-right">Enquiries</TableHead>
                        <TableHead className="text-right">Wrote again</TableHead>
                        <TableHead className="text-right">No branch</TableHead>
                        <TableHead>Branches</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {campaigns.map((c) => (
                        <CampaignRows key={c.key} campaign={c} />
                      ))}
                    </TableBody>
                  </Table>
                </div>
                {data.advertsNotLookedUp > 0 ? (
                  <p className="mt-3 text-xs text-muted-foreground">
                    {data.advertsNotLookedUp} advert
                    {data.advertsNotLookedUp === 1 ? "" : "s"} further down the list
                    {data.advertsNotLookedUp === 1 ? " was" : " were"} counted but not looked up
                    against Meta, so {data.advertsNotLookedUp === 1 ? "it carries" : "they carry"}{" "}
                    an id instead of a name. Narrow the window to see{" "}
                    {data.advertsNotLookedUp === 1 ? "it" : "them"} named.
                  </p>
                ) : null}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

/** A campaign, then each of its adverts indented beneath it. */
function CampaignRows({ campaign }: { campaign: AdEnquiryCampaign }) {
  return (
    <>
      <TableRow className="bg-muted/30">
        <TableCell className="font-medium">
          <span className="flex flex-wrap items-center gap-2">
            {campaignLabel(campaign)}
            {campaign.campaignName ? null : (
              /*
                Said out loud, never left blank. Meta answers "no campaign" for
                a deleted ad, an expired token and a Graph outage alike, and
                those are the moments the client most needs to see the clicks
                still arriving.
              */
              <StatusPill tone="wait" title="Meta did not name this advert's campaign">
                Not named by Meta
              </StatusPill>
            )}
            <Badge variant="secondary">
              {campaign.adverts.length === 1 ? "1 advert" : `${campaign.adverts.length} adverts`}
            </Badge>
          </span>
        </TableCell>
        <TableCell className="num text-right font-semibold">
          {formatNumber(campaign.enquiries)}
        </TableCell>
        <TableCell className="num text-right">
          {formatNumber(campaign.replied)}{" "}
          <span className="text-muted-foreground">({formatPercent(campaign.repliedPct, 0)})</span>
        </TableCell>
        <TableCell className="num text-right">
          {campaign.unrouted > 0 ? (
            <span className="text-rose-600 dark:text-rose-400">
              {formatNumber(campaign.unrouted)}
            </span>
          ) : (
            "—"
          )}
        </TableCell>
        <TableCell>
          <BranchList branches={campaign.branches} />
        </TableCell>
      </TableRow>

      {campaign.adverts.map((advert) => (
        <TableRow key={advert.adId}>
          <TableCell className="pl-8">
            <span className="text-sm">{advertLabel(advert)}</span>
            {/* The advert id, because an unnamed advert has nothing else — and
                because it is what somebody pastes into a routing rule. */}
            <span className="mt-0.5 block break-all font-mono text-[11px] text-muted-foreground">
              {advert.adId}
              {advert.named ? "" : " · nothing known about this advert from Meta"}
            </span>
          </TableCell>
          <TableCell className="num text-right">{formatNumber(advert.enquiries)}</TableCell>
          <TableCell className="num text-right">
            {formatNumber(advert.replied)}{" "}
            <span className="text-muted-foreground">({formatPercent(advert.repliedPct, 0)})</span>
          </TableCell>
          <TableCell className="num text-right">
            {advert.unrouted > 0 ? formatNumber(advert.unrouted) : "—"}
          </TableCell>
          <TableCell>
            <BranchList branches={advert.branches} />
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

function BranchList({ branches }: { branches: AdEnquiryBranch[] }) {
  if (!branches.length) {
    return <span className="text-xs text-muted-foreground">No branch</span>;
  }
  return (
    <span className="flex flex-wrap gap-1.5">
      {branches.map((b) => (
        <Badge key={b.storeId} variant="outline" className="font-normal">
          {/* The branch row can be gone; the id is then all there is to show. */}
          {b.storeName ?? b.storeId} <span className="num ml-1">{formatNumber(b.enquiries)}</span>
        </Badge>
      ))}
    </span>
  );
}

/**
 * Whose numbers these are.
 *
 * Head office reads the chain, a manager reads their own shops, and the two
 * must never look alike — a branch figure mistaken for the chain's is how a
 * campaign gets called a failure. Worded from the server's own store count so
 * it cannot claim a reach the query did not have.
 */
function scopeLine(role: string, storeName: string | undefined, storeCount: number): string {
  if (storeName && storeCount === 1) return storeName;
  if (role === "head_office") {
    return storeCount === 1 ? "1 branch" : `all ${storeCount} branches`;
  }
  return storeCount === 1 ? "your branch" : `your ${storeCount} branches`;
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border p-3">
      <div className={STAT_LABEL}>{label}</div>
      <div className={tone ? `${STAT_VALUE_SM} ${tone}` : STAT_VALUE_SM}>{value}</div>
    </div>
  );
}
