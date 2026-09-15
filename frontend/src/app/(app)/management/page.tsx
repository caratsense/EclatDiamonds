"use client";

import { useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  Clock,
  Download,
  Globe,
  Inbox,
  MessageSquareHeart,
  Phone,
  Store as StoreIcon,
  Ticket,
  TrendingUp,
} from "lucide-react";

import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusPill } from "@/components/ui/status-pill";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  humanSeconds,
  percent,
  useDownloadLeadExport,
  useManagementKpis,
  type Counted,
  type KpiFilters,
  type Ratio,
} from "@/lib/queries/management";
import { formatINR, formatNumber } from "@/lib/format";
import { apiErrorMessage } from "@/lib/utils";
import { useSession } from "@/store/use-session";

/**
 * How the business did, over a window.
 *
 * ## Two rules this screen keeps
 *
 * IT NEVER PRINTS 0% FOR "WE CANNOT SAY". A ratio with no denominator renders as
 * an em dash with its working underneath, because a branch that converted none
 * of forty leads and a branch that had no leads at all are different Tuesdays —
 * and a dashboard that shows both as 0% is one people learn to distrust.
 *
 * IT SAYS WHICH CLOCK DECIDED THE DAYS. Across branches in different timezones
 * "yesterday" genuinely began at different instants, so when they disagree the
 * chosen zone is shown rather than silently applied. Every figure on the page
 * moves together with it, which is exactly why it cannot be a footnote.
 */
export default function ManagementPage() {
  const stores = useSession((s) => s.stores);
  const role = useSession((s) => s.role);
  const isSalesperson = role === "salesperson";

  const [filters, setFilters] = useState<KpiFilters>({});
  const report = useManagementKpis(filters);
  const download = useDownloadLeadExport();
  const data = report.data;

  const set = (patch: Partial<KpiFilters>) =>
    setFilters((f) => {
      const next = { ...f, ...patch };
      for (const k of Object.keys(next) as (keyof KpiFilters)[]) {
        if (!next[k]) delete next[k];
      }
      return next;
    });

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <BarChart3 className="size-5" /> Management view
        </h1>
        <p className="text-sm text-muted-foreground">
          {isSalesperson
            ? "Your own work over the period. Everything here is scoped to you."
            : "Leads, conversations, follow-ups, the floor, quotes and feedback across the business."}
        </p>
      </div>

      {/* ---------------------------------------------------------------- */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="from">From</Label>
          <Input
            id="from"
            type="date"
            className="w-40"
            value={filters.from ?? data?.window.fromDate ?? ""}
            onChange={(e) => set({ from: e.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="to">To</Label>
          <Input
            id="to"
            type="date"
            className="w-40"
            value={filters.to ?? data?.window.toDate ?? ""}
            onChange={(e) => set({ to: e.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="branch">Branch</Label>
          <select
            id="branch"
            className="h-9 rounded-md border bg-background px-3 text-sm"
            value={filters.storeId ?? ""}
            onChange={(e) => set({ storeId: e.target.value })}
          >
            <option value="">Every branch</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <Button
          variant="outline"
          disabled={download.isPending}
          onClick={() =>
            download.mutate(filters, {
              onSuccess: (r) => toast.success(`Saved ${r.filename}`),
              onError: (e) => toast.error(apiErrorMessage(e, "Could not export those rows.")),
            })
          }
        >
          <Download className="size-4" />
          {download.isPending ? "Preparing…" : "Export leads"}
        </Button>
      </div>

      {/* ---------------------------------------------------------------- */}
      {report.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : report.isError ? (
        <EmptyState
          icon={AlertTriangle}
          title="These figures could not be worked out"
          description="Nothing is being shown rather than a partial total. Try a narrower date range, or reload."
        />
      ) : !data ? null : data.scope.unavailable ? (
        <EmptyState
          icon={StoreIcon}
          title="Nothing to report yet"
          description={data.scope.unavailable}
        />
      ) : (
        <>
          {data.window.ambiguous ? (
            <Card className="border-amber-500/40 bg-amber-500/5">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Globe className="size-4" /> Days were counted in{" "}
                  {data.window.timezone}
                </CardTitle>
                <CardDescription>
                  Branches in this view span {data.window.zonesInScope.join(", ")}, so
                  &ldquo;yesterday&rdquo; began at different moments in each. One clock had to
                  be chosen and every figure below uses it. Pick a single branch, or name a
                  timezone, if you need a different one.
                </CardDescription>
              </CardHeader>
            </Card>
          ) : null}

          <p className="text-xs text-muted-foreground">
            {data.window.fromDate} to {data.window.toDate}, counted in {data.window.timezone}
            {data.scope.ownerId ? " · your own records only" : ""}
          </p>

          {/* ---------------------------------------------------- leads */}
          <Section title="Leads" icon={TrendingUp}>
            <Tiles>
              <Tile label="Total" value={formatNumber(data.leads?.total ?? 0)} />
              <Tile label="Per day (mean)" value={String(data.leads?.perDayAverage ?? 0)} />
              <Tile label="New customers" value={formatNumber(data.leads?.newCustomers ?? 0)} />
              <Tile
                label="Returning"
                value={formatNumber(data.leads?.returningCustomers ?? 0)}
              />
              <Tile
                label="Provider-measured ads"
                value={formatNumber(data.leads?.measuredAdAttribution ?? 0)}
                hint="Only leads the ad platform itself attributed. The rest are not proof of organic traffic."
              />
            </Tiles>
            <div className="grid gap-3 lg:grid-cols-3">
              <Breakdown title="By source" rows={data.leads?.bySource ?? []} />
              <Breakdown title="By branch" rows={data.leads?.byStore ?? []} />
              <Breakdown title="By stage" rows={data.leads?.byStage ?? []} />
            </div>
          </Section>

          {/* --------------------------------------------- conversations */}
          <Section title="Conversations" icon={Inbox}>
            <Tiles>
              <Tile
                label="Waiting on us"
                value={formatNumber(data.engagement?.unanswered ?? 0)}
                tone={data.engagement?.unanswered ? "bad" : undefined}
              />
              <Tile
                label="First reply (mean)"
                value={humanSeconds(data.engagement?.averageFirstResponseSeconds ?? null)}
                hint="Across conversations that were answered. Unanswered ones are counted as breaches, not as slow replies."
              />
              <Tile
                label="Within target"
                value={formatNumber(data.engagement?.answeredWithinTarget ?? 0)}
              />
              <Tile
                label="Breached"
                value={formatNumber(data.engagement?.breached ?? 0)}
                tone={data.engagement?.breached ? "bad" : undefined}
              />
              <Tile label="Escalated" value={formatNumber(data.engagement?.escalated ?? 0)} />
            </Tiles>
            <div className="grid gap-3 lg:grid-cols-2">
              <Breakdown title="By channel" rows={data.engagement?.byChannel ?? []} />
              <Breakdown
                title="Who replied first"
                rows={[
                  { key: "A person", count: data.engagement?.firstResponseByHuman ?? 0 },
                  {
                    key: "AI draft, approved",
                    count: data.engagement?.firstResponseByApprovedAi ?? 0,
                  },
                ]}
                note="An AI draft counts only once somebody approved it — an unreviewed draft is not a reply."
              />
            </div>
          </Section>

          {/* ---------------------------------------- follow-ups, calling */}
          <Section title="Follow-ups and calling" icon={Phone}>
            <Tiles>
              <Tile label="Follow-ups" value={formatNumber(data.followUps?.total ?? 0)} />
              <Tile label="Completed" value={formatNumber(data.followUps?.completed ?? 0)} />
              <Tile
                label="Overdue"
                value={formatNumber(data.followUps?.overdue ?? 0)}
                tone={data.followUps?.overdue ? "bad" : undefined}
              />
              <RatioTile label="Completion" r={data.followUps?.completionRate} />
              <Tile label="Calls" value={formatNumber(data.followUps?.calls.total ?? 0)} />
              <Tile
                label="Logged by hand"
                value={formatNumber(data.followUps?.calls.manual ?? 0)}
                hint="Not confirmed by a telephony network — recorded by the person who made the call."
              />
            </Tiles>
          </Section>

          {/* ------------------------------------------------- the floor */}
          <Section title="The floor" icon={StoreIcon}>
            <Tiles>
              <Tile label="Visits" value={formatNumber(data.floor?.visits ?? 0)} />
              <RatioTile label="Visit → enquiry" r={data.floor?.visitToLead} />
              <RatioTile label="Visit → sale" r={data.floor?.visitToSale} />
              <Tile label="Left without enquiry" value={formatNumber(data.floor?.walkOuts ?? 0)} />
            </Tiles>
            <Breakdown title="By branch" rows={data.floor?.byStore ?? []} />
          </Section>

          {/* ------------------------------------------------- quotations */}
          <Section title="Quotations" icon={Ticket}>
            <Tiles>
              <Tile label="Raised" value={formatNumber(data.quotes?.total ?? 0)} />
              <Tile
                label="Average approved"
                value={
                  data.quotes?.averageApprovedAmount == null
                    ? "—"
                    : formatINR(data.quotes.averageApprovedAmount)
                }
              />
              <Tile
                label="Approval turnaround"
                value={
                  data.quotes?.approvalTurnaroundHours?.average != null
                    ? `${data.quotes.approvalTurnaroundHours.average} h`
                    : "—"
                }
                hint={
                  data.quotes?.approvalTurnaroundHours
                    ? `Mean over all ${formatNumber(data.quotes.approvalTurnaroundHours.decisions)} decisions · median ${data.quotes.approvalTurnaroundHours.median ?? "—"} h`
                    : undefined
                }
              />
            </Tiles>
            <Breakdown
              title="By state"
              rows={Object.entries(data.quotes?.byStatus ?? {}).map(([key, count]) => ({
                key,
                count,
              }))}
            />
          </Section>

          {/* --------------------------------------------------- feedback */}
          <Section title="Feedback" icon={MessageSquareHeart}>
            <Tiles>
              <Tile label="Asked" value={formatNumber(data.feedback?.requested ?? 0)} />
              <Tile
                label="Actually delivered"
                value={formatNumber(data.feedback?.delivered ?? 0)}
                hint="A request the provider accepted. One that never left the building cannot be answered."
              />
              <Tile label="Answered" value={formatNumber(data.feedback?.responded ?? 0)} />
              <RatioTile label="Response rate" r={data.feedback?.responseRate} />
              <Tile
                label="Escalated"
                value={formatNumber(data.feedback?.negativeOrEscalated ?? 0)}
                tone={data.feedback?.negativeOrEscalated ? "bad" : undefined}
              />
            </Tiles>
          </Section>

          {/* ------------------------------------------------- operations
              Organisation-level plumbing: the API sends it only for the
              organisation-wide view, so a branch view shows nothing rather
              than a row of zeroes that reads as "all clear". */}
          {data.operations ? (
          <Section title="Reporting and operations" icon={Clock}>
            <Tiles>
              <Tile
                label="Latest month-end"
                value={data.operations?.latestReport?.periodKey ?? "—"}
                tone={
                  data.operations?.latestReport && !data.operations.latestReport.delivered
                    ? "wait"
                    : undefined
                }
                hint={
                  data.operations?.latestReport && !data.operations.latestReport.delivered
                    ? "Built, but not delivered — email is not configured."
                    : undefined
                }
              />
              <Tile
                label="Import batches"
                value={formatNumber(data.operations?.imports.batches ?? 0)}
              />
              <Tile
                label="Rejected rows"
                value={formatNumber(data.operations?.imports.rejectedRows ?? 0)}
                tone={data.operations?.imports.rejectedRows ? "wait" : undefined}
              />
              <Tile
                label="Dead jobs"
                value={formatNumber(data.operations?.deadJobs ?? 0)}
                tone={data.operations?.deadJobs ? "bad" : undefined}
              />
            </Tiles>
          </Section>
          ) : null}

          {/* ------------------------------------------------- conversion */}
          <Section title="Conversion" icon={TrendingUp}>
            <p className="text-xs text-muted-foreground">
              {data.conversion?.measured.note}
            </p>
            <div className="grid gap-3 lg:grid-cols-3">
              <ConversionTable title="By source (declared)" rows={data.conversion?.bySource ?? []} />
              <ConversionTable title="By branch" rows={data.conversion?.byStore ?? []} />
              <ConversionTable
                title="By owner"
                rows={data.conversion?.byOwner ?? []}
              />
            </div>
          </Section>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ parts */

function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="size-4" /> {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">{children}</CardContent>
    </Card>
  );
}

function Tiles({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">{children}</div>
  );
}

function Tile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "bad" | "wait";
}) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={
          tone === "bad"
            ? "num text-xl font-semibold text-rose-600 dark:text-rose-400"
            : tone === "wait"
              ? "num text-xl font-semibold text-amber-600 dark:text-amber-400"
              : "num text-xl font-semibold"
        }
      >
        {value}
      </div>
      {hint ? <div className="mt-1 text-[11px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

/** A percentage that shows its working, and an em dash when there is none. */
function RatioTile({ label, r }: { label: string; r?: Ratio }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="num text-xl font-semibold">{percent(r)}</div>
      <div className="mt-1 text-[11px] text-muted-foreground">
        {r && r.denominator > 0
          ? `${formatNumber(r.numerator)} of ${formatNumber(r.denominator)}`
          : "Nothing to measure in this period"}
      </div>
    </div>
  );
}

function Breakdown({
  title,
  rows,
  note,
}: {
  title: string;
  rows: Counted[];
  note?: string;
}) {
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  return (
    <div className="space-y-1 rounded-md border p-3">
      <div className="text-xs font-medium">{title}</div>
      {rows.length === 0 ? (
        <div className="text-xs text-muted-foreground">Nothing in this period.</div>
      ) : (
        <Table>
          <TableBody>
            {[...rows]
              .sort((a, b) => b.count - a.count)
              .map((r) => (
                <TableRow key={r.key ?? "none"}>
                  <TableCell className="py-1 text-sm">{r.label ?? r.key ?? "—"}</TableCell>
                  <TableCell className="num py-1 text-right text-sm">
                    {formatNumber(r.count)}
                  </TableCell>
                  <TableCell className="num py-1 text-right text-xs text-muted-foreground">
                    {total > 0 ? `${Math.round((r.count / total) * 100)}%` : "—"}
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      )}
      {note ? <p className="text-[11px] text-muted-foreground">{note}</p> : null}
    </div>
  );
}

function ConversionTable({
  title,
  rows,
}: {
  title: string;
  rows: (Ratio & { key: string; label: string })[];
}) {
  return (
    <div className="space-y-1 rounded-md border p-3">
      <div className="text-xs font-medium">{title}</div>
      {rows.length === 0 ? (
        <div className="text-xs text-muted-foreground">Nothing in this period.</div>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="py-1">Group</TableHead>
                <TableHead className="py-1 text-right">Won / total</TableHead>
                <TableHead className="py-1 text-right">Rate</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.key}>
                  <TableCell className="py-1 text-sm">{r.label}</TableCell>
                  <TableCell className="num py-1 text-right text-sm">
                    {r.numerator} / {r.denominator}
                  </TableCell>
                  <TableCell className="py-1 text-right">
                    <StatusPill tone={r.value == null ? "mute" : r.value >= 20 ? "good" : "wait"}>
                      {percent(r)}
                    </StatusPill>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
