"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, BarChart3, CircleSlash, Download } from "lucide-react";
import { toast } from "sonner";

import {
  AdminPageHeader,
  ConnectionPicker,
  LoadFailed,
  LoadingBlock,
  NotConnected,
  connectionsFor,
} from "@/components/integrations/admin-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ROAS_STATUS_REASON,
  useAdPerformance,
  useSyncAdSpend,
  type AdPerformanceQuery,
} from "@/lib/queries/meta-admin";
import { useIntegrations } from "@/lib/queries/tenant-config";
import { apiErrorMessage } from "@/lib/utils";

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Screen 9 — measured spend, how much of it we actually have, and a return
 * figure that refuses to appear when it would be meaningless.
 *
 * Three separate honesty problems live on this one screen, and each has its own
 * visible answer:
 *
 *   Coverage    A window nobody finished ingesting is shown as partial, with the
 *               missing days named. A total over a fraction of the days looks
 *               exactly like a total over all of them.
 *   Currency    Revenue is in your currency; spend is in the ad account's. When
 *               they differ there is no ratio to show, and no rate here to make
 *               one up with.
 *   Attribution Provider-measured spend and click-backed revenue are kept apart
 *               from figures a person typed in.
 */
export default function AdPerformancePage() {
  const { data: integrations, isLoading } = useIntegrations();
  const connections = useMemo(() => connectionsFor(integrations, "meta_ads"), [integrations]);
  // Both selections are derived from what exists, with an explicit choice
  // overriding. Storing them in an effect would re-render on every arrival of
  // the connection list and fight a user who had already picked.
  const [chosenConnection, setIntegrationId] = useState<string | null>(null);
  const [chosenAsset, setAssetId] = useState<string | null>(null);
  const [dateFrom, setDateFrom] = useState(isoDaysAgo(29));
  const [dateTo, setDateTo] = useState(isoDaysAgo(0));

  const integrationId = chosenConnection ?? connections[0]?.id ?? null;
  const connection = connections.find((c) => c.id === integrationId);
  const adAccounts = (connection?.assets ?? []).filter((a) => a.kind === "ad_account");
  const assetId = adAccounts.some((a) => a.id === chosenAsset)
    ? chosenAsset
    : (adAccounts[0]?.id ?? null);

  const query: AdPerformanceQuery | null =
    integrationId && assetId ? { integrationId, adAccountAssetId: assetId, dateFrom, dateTo } : null;
  const report = useAdPerformance(query);
  const sync = useSyncAdSpend();

  if (isLoading) return <LoadingBlock />;
  if (!connections.length) return <NotConnected what="Meta Ads account" icon={BarChart3} />;

  return (
    <>
      <AdminPageHeader
        title="Advertising spend and return"
        purpose="What the provider says you spent, how much of the period we actually have, and what came back from it."
        action={
          <Button
            size="sm"
            variant="outline"
            disabled={!query || sync.isPending}
            onClick={() =>
              sync.mutate(query!, {
                onSuccess: () => toast.success("Queued. Figures update once the pull finishes."),
                onError: (e) => toast.error(apiErrorMessage(e, "That did not work. Nothing was changed.")),
              })
            }
          >
            <Download className="h-4 w-4" />
            Pull spend for this range
          </Button>
        }
      />

      <Card className="mb-6">
        <CardContent className="grid gap-3 pt-6 sm:grid-cols-4 sm:items-end">
          <div className="space-y-1.5">
            <Label>Connection</Label>
            {connections.length > 1 ? (
              <ConnectionPicker
                connections={connections}
                value={integrationId}
                onChange={setIntegrationId}
              />
            ) : (
              <p className="text-sm">{connections[0].name}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="account">Ad account</Label>
            <select
              id="account"
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={assetId ?? ""}
              onChange={(e) => setAssetId(e.target.value)}
              disabled={adAccounts.length === 0}
            >
              {adAccounts.length === 0 ? <option value="">None registered</option> : null}
              {adAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name ?? a.externalId}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="from">From</Label>
            <Input
              id="from"
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="to">To</Label>
            <Input id="to" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      {adAccounts.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <CircleSlash className="h-5 w-5 text-muted-foreground" />
            <p className="text-sm font-medium">No ad account is registered</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              Spend is read per ad account. Register one on the Meta assets screen first.
            </p>
          </CardContent>
        </Card>
      ) : report.isLoading ? (
        <LoadingBlock />
      ) : report.isError ? (
        <LoadFailed message={apiErrorMessage(report.error, "This report could not be read. Your plan may not include advertising attribution.")} />
      ) : !report.data ? (
        <LoadingBlock />
      ) : (
        <div className="space-y-6">
          {!report.data.coverage.complete ? (
            <Card className="border-warning">
              <CardContent className="flex gap-3 pt-6">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                <div className="space-y-1">
                  <p className="text-sm font-medium">
                    Partial period — {report.data.coverage.completedDays} of{" "}
                    {report.data.coverage.expectedDays} days have been pulled
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Missing: {report.data.coverage.missingDates.slice(0, 12).join(", ")}
                    {report.data.coverage.missingDates.length > 12 ? " and more" : ""}. The spend
                    total below is real but incomplete, so no return figure is shown for it.
                  </p>
                </div>
              </CardContent>
            </Card>
          ) : null}

          {report.data.currencies.mismatch ? (
            <Card className="border-warning">
              <CardContent className="flex gap-3 pt-6">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                {/*
                  Two different causes reach this banner and they need different
                  words. Saying "spend is in INR; revenue is in INR" — which is
                  what a single sentence produced — names one currency twice and
                  reads as a bug rather than as a warning.
                */}
                <div className="space-y-1">
                  <p className="text-sm font-medium">
                    {report.data.currencies.spend !== report.data.currencies.revenue
                      ? `Spend is in ${report.data.currencies.spend}; revenue is in ${report.data.currencies.revenue}`
                      : `Some spend in this period is not in ${report.data.currencies.spend}`}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {report.data.currencies.spend !== report.data.currencies.revenue
                      ? "No exchange rate has been supplied, and this screen will not invent one. Both figures are shown with their own currency; the ratio between them is not."
                      : "This ad account was reconfigured at some point, so part of the period was measured in another currency. Those amounts are shown separately and are not added to the total."}
                    {report.data.currencies.foreignSpend.length
                      ? ` Also found: ${report.data.currencies.foreignSpend
                          .map((f) => `${f.measuredSpend} ${f.currency}`)
                          .join(", ")}.`
                      : ""}
                  </p>
                </div>
              </CardContent>
            </Card>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-4">
            <Total
              label="Measured spend"
              value={`${report.data.totals.measuredSpend} ${report.data.totals.measuredSpendCurrency}`}
            />
            <Total
              label="Click-backed revenue"
              value={`${report.data.totals.measuredRevenue} ${report.data.totals.measuredRevenueCurrency}`}
            />
            <Total
              label="Return on spend"
              value={report.data.totals.measuredRoas ?? "Not shown"}
              hint={ROAS_STATUS_REASON[report.data.totals.measuredRoasStatus]}
            />
            <Total
              label="Declared revenue"
              value={`${report.data.totals.declaredRevenue} ${report.data.totals.measuredRevenueCurrency}`}
              hint="Recorded by a person rather than traced from a click. Kept separate on purpose."
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">By campaign</CardTitle>
              <p className="text-xs text-muted-foreground">{report.data.note}</p>
            </CardHeader>
            <CardContent className="px-0 sm:px-6">
              {report.data.rows.length === 0 ? (
                <p className="px-6 pb-6 text-sm text-muted-foreground sm:px-0">
                  Nothing was measured in this range. Pull the period first, or widen the dates.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Campaign</TableHead>
                      <TableHead className="text-right">Spend</TableHead>
                      <TableHead className="text-right">Clicks</TableHead>
                      <TableHead className="text-right">Revenue</TableHead>
                      <TableHead className="text-right">Return</TableHead>
                      <TableHead>Mapping</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.data.rows.map((row) => (
                      <TableRow key={row.externalCampaignId}>
                        <TableCell>
                          <div className="space-y-0.5">
                            <p className="text-sm">{row.label}</p>
                            <p className="font-mono text-xs text-muted-foreground">
                              {row.externalCampaignId}
                            </p>
                          </div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {row.measuredSpend} {row.currency}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{row.clicks}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {row.measuredRevenue}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {row.measuredRoas ?? (
                            <span
                              className="text-xs text-muted-foreground"
                              title={ROAS_STATUS_REASON[row.measuredRoasStatus]}
                            >
                              not shown
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              row.mappingStatus === "mapped"
                                ? "success"
                                : row.mappingStatus === "ambiguous"
                                  ? "warning"
                                  : "outline"
                            }
                          >
                            {row.mappingStatus === "mapped"
                              ? "Matched"
                              : row.mappingStatus === "ambiguous"
                                ? "Two campaigns share this id"
                                : "No local campaign"}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}

function Total({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="space-y-1 pt-6">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-xl font-semibold tabular-nums">{value}</p>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}
