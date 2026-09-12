"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Hourglass, ScanLine, Tag, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import {
  STOCK_CATEGORIES,
  useClearDeadStockRule,
  useDeadStock,
  useDeadStockPolicy,
  useIssueMissingVins,
  useSetDeadStockRule,
  useVinLookup,
} from "@/lib/queries/dead-stock";
import { formatINR } from "@/lib/format";
import { apiErrorMessage } from "@/lib/utils";
import { useSession } from "@/store/use-session";

/**
 * Dead stock, on the tenant's own terms — and the number on the tag.
 *
 * Two things this screen is careful about. The threshold is shown on every row,
 * so "dead" is never an unexplained verdict: the reader can see that this chain
 * was condemned at 45 days and that necklace was not, at 365. And the headline
 * counts come from the same request as the rows, so the card above the table
 * cannot say 52 over a list of 40.
 */
export default function DeadStockPage() {
  const role = useSession((s) => s.role);
  const stores = useSession((s) => s.stores);
  const isHo = role === "head_office";
  const canIssue = isHo || role === "store_manager";

  const [storeId, setStoreId] = useState("");
  const [category, setCategory] = useState("");
  const [includeWarning, setIncludeWarning] = useState(false);
  const [vin, setVin] = useState("");

  const policy = useDeadStockPolicy();
  const list = useDeadStock({
    storeId: storeId || undefined,
    category: category || undefined,
    includeWarning,
    limit: 500,
  });
  const setRule = useSetDeadStockRule();
  const clearRule = useClearDeadStockRule();
  const issueMissing = useIssueMissingVins();
  const lookup = useVinLookup(vin);

  const [ruleCategory, setRuleCategory] = useState("");
  const [threshold, setThreshold] = useState("");
  const [warn, setWarn] = useState("");

  const onSaveRule = () => {
    setRule.mutate(
      {
        category: ruleCategory || null,
        thresholdDays: Number(threshold),
        warnAfterDays: warn.trim() === "" ? null : Number(warn),
      },
      {
        onSuccess: () => {
          toast.success(
            ruleCategory
              ? `${ruleCategory} counts as dead after ${threshold} days`
              : `Everything else counts as dead after ${threshold} days`,
          );
          setThreshold("");
          setWarn("");
        },
        onError: (e) => toast.error(apiErrorMessage(e, "Could not save that rule.")),
      },
    );
  };

  const onIssueMissing = () => {
    issueMissing.mutate(
      { storeId: storeId || undefined },
      {
        onSuccess: (res) =>
          toast.success(`${res.issued} piece identifier(s) issued`, {
            description:
              res.remaining > 0
                ? `${res.remaining} still have none — run it again to continue.`
                : "Every piece in this branch now has one.",
          }),
        onError: (e) => toast.error(apiErrorMessage(e, "Could not issue them.")),
      },
    );
  };

  const data = list.data;

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Link
          href="/inventory"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" /> Inventory
        </Link>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Hourglass className="size-5" /> Dead stock
        </h1>
        <p className="text-sm text-muted-foreground">
          Pieces past the age you decided for their category. Every row shows the threshold that
          condemned it.
        </p>
      </div>

      {/* ---------------------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ScanLine className="size-4" /> Find a piece by its tag
          </CardTitle>
          <CardDescription>
            The number we print on the piece. The SKU is the design and is shared across identical
            pieces; this one is not.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="vin">Piece number</Label>
              <Input
                id="vin"
                className="w-56 font-mono"
                placeholder="260000123"
                value={vin}
                onChange={(e) => setVin(e.target.value)}
              />
            </div>
            {canIssue ? (
              <Button variant="outline" onClick={onIssueMissing} disabled={issueMissing.isPending}>
                <Tag className="size-4" />
                {issueMissing.isPending ? "Issuing…" : "Issue for pieces with none"}
              </Button>
            ) : null}
          </div>

          {vin.trim().length >= 4 && lookup.data ? (
            lookup.data.found ? (
              <div className="rounded-md border p-3 text-sm">
                <div className="font-medium">
                  {lookup.data.name} <span className="num text-muted-foreground">{lookup.data.sku}</span>
                </div>
                <div className="text-muted-foreground">
                  {lookup.data.store?.name ?? "Unknown branch"} · {lookup.data.ageDays} days in stock
                  {lookup.data.styleNumber ? ` · design ${lookup.data.styleNumber}` : ""}
                  {lookup.data.tagPrice ? ` · ${formatINR(lookup.data.tagPrice)}` : ""}
                </div>
                {!lookup.data.inScope ? (
                  // Found and named rather than hidden: somebody holding the tag
                  // needs to be told where it belongs.
                  <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                    This piece belongs to a branch outside your scope.
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Nothing here answers to that number. It may have been sold, transferred, or never
                entered.
              </p>
            )
          ) : null}
        </CardContent>
      </Card>

      {/* ---------------------------------------------------------------- */}
      {data ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile
            label="Dead"
            value={String(data.dead)}
            tone={data.dead > 0 ? "text-rose-600 dark:text-rose-400" : undefined}
          />
          <Tile label="Heading that way" value={String(data.ageing)} />
          <Tile label="Tied-up value" value={formatINR(data.value)} />
          <Tile
            label="Default threshold"
            value={`${policy.data?.defaultThresholdDays ?? 180}d`}
          />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <select
          className="h-9 rounded-md border bg-background px-3 text-sm"
          value={storeId}
          onChange={(e) => setStoreId(e.target.value)}
        >
          <option value="">Every branch</option>
          {stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select
          className="h-9 rounded-md border bg-background px-3 text-sm capitalize"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">Every category</option>
          {STOCK_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={includeWarning}
            onChange={(e) => setIncludeWarning(e.target.checked)}
          />
          Include pieces heading that way
        </label>
      </div>

      {list.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : (data?.items ?? []).length === 0 ? (
        <EmptyState
          icon={Hourglass}
          title="Nothing is dead"
          description="Every piece is inside the threshold you set for its category."
        />
      ) : (
        <>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Piece</TableHead>
                  <TableHead>Design</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead className="text-right">In stock</TableHead>
                  <TableHead className="text-right">Threshold</TableHead>
                  <TableHead className="text-right">Over by</TableHead>
                  <TableHead className="text-right">Tag price</TableHead>
                  <TableHead>State</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data?.items ?? []).map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <div className="font-medium">{r.name}</div>
                      <div className="num text-xs text-muted-foreground">
                        {r.sku}
                        {r.vin ? ` · ${r.vin}` : ""}
                      </div>
                    </TableCell>
                    <TableCell className="num text-muted-foreground">
                      {r.styleNumber ?? "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{r.storeName}</TableCell>
                    <TableCell className="num text-right">{r.ageDays}d</TableCell>
                    {/* Shown on every row so "dead" is never an unexplained verdict. */}
                    <TableCell className="num text-right text-muted-foreground">
                      {r.thresholdDays}d
                    </TableCell>
                    <TableCell className="num text-right">
                      {r.daysOver > 0 ? `${r.daysOver}d` : "—"}
                    </TableCell>
                    <TableCell className="num text-right">{formatINR(r.tagPrice)}</TableCell>
                    <TableCell>
                      <StatusPill tone={r.state === "dead" ? "bad" : "wait"}>
                        {r.state === "dead" ? "Dead" : "Ageing"}
                      </StatusPill>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {data?.truncated ? (
            <p className="text-xs text-muted-foreground">
              Showing the worst 500. Narrow by branch or category to see the rest.
            </p>
          ) : null}
        </>
      )}

      {/* ---------------------------------------------------------------- */}
      {isHo ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">What counts as dead</CardTitle>
            <CardDescription>
              {policy.data?.usingPlatformDefault
                ? "Nothing is configured, so everything uses 180 days."
                : "A category with its own rule uses it; everything else uses your default."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="rule-cat">Category</Label>
                <select
                  id="rule-cat"
                  className="h-9 w-44 rounded-md border bg-background px-3 text-sm capitalize"
                  value={ruleCategory}
                  onChange={(e) => setRuleCategory(e.target.value)}
                >
                  <option value="">Everything else (default)</option>
                  {STOCK_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rule-days">Dead after (days)</Label>
                <Input
                  id="rule-days"
                  inputMode="numeric"
                  className="w-32"
                  placeholder="180"
                  value={threshold}
                  onChange={(e) => setThreshold(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rule-warn">Warn after (days)</Label>
                <Input
                  id="rule-warn"
                  inputMode="numeric"
                  className="w-32"
                  placeholder="Optional"
                  value={warn}
                  onChange={(e) => setWarn(e.target.value)}
                />
              </div>
              <Button onClick={onSaveRule} disabled={setRule.isPending || !threshold.trim()}>
                Save rule
              </Button>
            </div>

            {(policy.data?.rules ?? []).length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Applies to</TableHead>
                    <TableHead className="text-right">Dead after</TableHead>
                    <TableHead className="text-right">Warn after</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(policy.data?.rules ?? []).map((r) => (
                    <TableRow key={r.category ?? "default"}>
                      <TableCell className="capitalize">
                        {r.category ?? "Everything else"}
                      </TableCell>
                      <TableCell className="num text-right">{r.thresholdDays}d</TableCell>
                      <TableCell className="num text-right text-muted-foreground">
                        {r.warnAfterDays ? `${r.warnAfterDays}d` : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            clearRule.mutate(r.category ?? "default", {
                              onSuccess: () => toast.success("Rule removed"),
                              onError: (e) =>
                                toast.error(apiErrorMessage(e, "Could not remove it.")),
                            })
                          }
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border p-3">
      <div className={STAT_LABEL}>{label}</div>
      <div className={tone ? `${STAT_VALUE_SM} ${tone}` : STAT_VALUE_SM}>{value}</div>
    </div>
  );
}
