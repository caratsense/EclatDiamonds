"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Globe,
  KeyRound,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  ScanSearch,
  ShieldCheck,
  TestTube2,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import { ProductDetailDialog } from "@/components/catalogue/product-detail-dialog";
import { SectionHeader } from "@/components/section/section-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { formatNumber } from "@/lib/format";
import {
  useCatalogueConflicts,
  useCatalogueHealth,
  useCatalogueRuns,
  useSaveWebsiteCredential,
  useStartWebsiteSync,
  useUpdateConflict,
  type CatalogueSyncRun,
  type ConflictStatus,
} from "@/lib/queries/catalogue-integration";
import { useStartReindex } from "@/lib/queries/jewelry-similarity";
import type { CatalogueConflictView } from "@/lib/queries/products";
import { imageSourceLabel } from "@/lib/mock/catalogue";
import { apiErrorMessage, cn } from "@/lib/utils";
import { useSession } from "@/store/use-session";

/**
 * Head office's control room for the lossless catalogue: is the website
 * connected, when did Gati last deliver, do the totals reconcile, what did each
 * run do, what did a sync refuse to guess about — and the buttons to act.
 */
export default function CatalogueIntegrationPage() {
  const role = useSession((s) => s.role);
  const isHO = role === "head_office";

  return (
    <>
      <SectionHeader
        title="Catalogue integration"
        purpose="Website and Gati catalogue sync, conflicts to review, and the visual-search index."
      />
      <Button asChild variant="ghost" size="sm" className="-mt-2 mb-4">
        <Link href="/catalogue">
          <ArrowLeft className="h-4 w-4" /> Back to catalogue
        </Link>
      </Button>
      {isHO ? (
        <IntegrationView />
      ) : (
        <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          Catalogue integration is managed by head office.
        </p>
      )}
    </>
  );
}

function IntegrationView() {
  const health = useCatalogueHealth(true);
  const runs = useCatalogueRuns(true);
  const h = health.data;
  const lastRun = runs.data?.[0] ?? h?.website?.lastRun ?? null;

  if (health.isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-40 rounded-xl" />
        ))}
      </div>
    );
  }
  if (health.isError) {
    return (
      <div className="rounded-xl border p-6 text-center">
        <p className="text-sm font-medium">Couldn&apos;t load the integration status.</p>
        <p className="mt-1 text-xs text-muted-foreground">{apiErrorMessage(health.error, "")}</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={() => health.refetch()}>
          <RefreshCw className="h-4 w-4" /> Try again
        </Button>
      </div>
    );
  }

  const w = h?.website;
  const g = h?.gati;
  const cat = h?.catalogue;
  const emb = h?.embeddings;
  const conflictsOpen = Object.entries(h?.conflictsOpen ?? {});

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="Website" icon={<Globe className="h-4 w-4" />}>
          <State ok={!!w?.configured} okText="Connected" badText="Not connected" />
          {w?.host ? (
            <KV label="Host">
              <span className="font-mono text-xs">{w.host}</span>
            </KV>
          ) : null}
          <KV label="Last run">{lastRun?.status ? <RunStatus status={lastRun.status} /> : "Never"}</KV>
          <KV label="Last success">{when(w?.lastSuccessAt)}</KV>
          <KV label="Website says it has">{n(w?.sourceTotal)}</KV>
          <KV label="Live listings here">
            {n(w?.listingsActive)}
            {w?.sourceTotal != null &&
            w?.listingsActive != null &&
            w.sourceTotal !== w.listingsActive + (w.listingsUnpublished ?? 0) ? (
              <Badge variant="warning" className="ml-2">
                differs by {formatNumber(Math.abs(w.sourceTotal - w.listingsActive - (w.listingsUnpublished ?? 0)))}
              </Badge>
            ) : null}
          </KV>
          {w?.listingsUnpublished ? <KV label="Unpublished on the website">{n(w.listingsUnpublished)}</KV> : null}
          {w?.listingsTombstoned ? <KV label="Gone from the website">{n(w.listingsTombstoned)}</KV> : null}
          {w?.tokenStored ? <KV label="Token last used">{when(w.credentialLastUsedAt)}</KV> : null}
        </Panel>

        <Panel title="Gati" icon={<ShieldCheck className="h-4 w-4" />}>
          <State
            ok={!!(g?.productsSyncedAt || g?.stockSyncedAt)}
            okText="Delivering"
            badText="No Gati sync seen yet"
          />
          <KV label="Designs last synced">{when(g?.productsSyncedAt)}</KV>
          <KV label="Stock last synced">{when(g?.stockSyncedAt)}</KV>
          <KV label="CAD pictures last synced">{when(g?.imagesSyncedAt)}</KV>
        </Panel>

        <Panel title="Catalogue">
          <KV label="Designs">{n(cat?.products)}</KV>
          <KV label="Website variants">{n(cat?.variants)}</KV>
          {Object.entries(cat?.imagesBySource ?? {}).map(([k, v]) => (
            <KV key={k} label={`Pictures · ${imageSourceLabel(k)}`}>
              {n(v)}
            </KV>
          ))}
          <KV label="Gati designs without CAD">{n(cat?.missingCad)}</KV>
          <KV label="Open conflicts">{n(conflictsOpen.reduce((t, [, v]) => t + v, 0))}</KV>
          {conflictsOpen.map(([k, v]) => (
            <KV key={k} label={`· ${humanize(k)}`}>
              {n(v)}
            </KV>
          ))}
        </Panel>

        <Panel title="Visual search index" icon={<ScanSearch className="h-4 w-4" />}>
          {Object.entries(emb?.byStatus ?? {}).map(([k, v]) => (
            <KV key={k} label={humanize(k)}>
              {n(v)}
            </KV>
          ))}
          {Object.entries(emb?.latestVersions ?? {}).map(([k, v]) => (
            <KV key={k} label={humanize(k)}>
              <span className="break-all font-mono text-xs">{v ?? "—"}</span>
            </KV>
          ))}
        </Panel>
      </div>

      <Actions lastRun={lastRun} deadCount={(emb?.byStatus?.dead ?? 0) + (emb?.byStatus?.failed ?? 0)} />

      <CredentialForm key={w?.baseUrl ?? ""} configured={!!w?.configured} tokenStored={!!w?.tokenStored} savedBaseUrl={w?.baseUrl ?? null} />

      <Runs runs={runs.data ?? []} loading={runs.isLoading} />

      <Conflicts />
    </div>
  );
}

function Actions({ lastRun, deadCount }: { lastRun: Partial<CatalogueSyncRun> | null; deadCount: number }) {
  const sync = useStartWebsiteSync();
  const reindex = useStartReindex();
  const retryDead = useStartReindex();
  const running = lastRun?.status === "running";
  const canResume = lastRun?.status === "partial" || lastRun?.status === "failed";
  const start = (mode: "full" | "resume", dryRun: boolean) =>
    sync.mutate(
      { mode, dryRun },
      {
        onSuccess: () =>
          toast.success(dryRun ? "Dry run queued — nothing will be written" : mode === "resume" ? "Resume queued" : "Full sync queued"),
        onError: (err) => toast.error(apiErrorMessage(err, "Could not start the sync.")),
      },
    );
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <h3 className="text-sm font-semibold">Run</h3>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          <Button variant="outline" className="h-11" disabled={sync.isPending || running} onClick={() => start("full", true)}>
            <TestTube2 className="h-4 w-4" /> Dry run
          </Button>
          <Button variant="gold" className="h-11" disabled={sync.isPending || running} onClick={() => start("full", false)}>
            <Play className="h-4 w-4" /> Full sync
          </Button>
          <Button variant="outline" className="h-11" disabled={sync.isPending || running || !canResume} onClick={() => start("resume", false)}>
            <RotateCcw className="h-4 w-4" /> Resume
          </Button>
          <Button
            variant="outline"
            className="h-11"
            disabled={reindex.isPending}
            onClick={() =>
              reindex.mutate(
                { force: true },
                {
                  onSuccess: (r) => toast.success(`${formatNumber(r.queued ?? 0)} pictures queued to re-embed`),
                  onError: (err) => toast.error(apiErrorMessage(err, "Could not start the rebuild.")),
                },
              )
            }
          >
            <ScanSearch className="h-4 w-4" /> Re-embed everything
          </Button>
          <Button
            variant="outline"
            className="h-11"
            disabled={retryDead.isPending || deadCount === 0}
            onClick={() =>
              // Without force the rebuild queues every picture that is not
              // current, which is exactly the failed and given-up ones.
              retryDead.mutate(undefined, {
                onSuccess: (r) => toast.success(`${formatNumber(r.queued ?? 0)} pictures queued again`),
                onError: (err) => toast.error(apiErrorMessage(err, "Could not retry the failed pictures.")),
              })
            }
          >
            <RefreshCw className="h-4 w-4" /> Retry failed ({formatNumber(deadCount)})
          </Button>
        </div>
        {running ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> A run is in progress — page {lastRun?.nextPage ?? "?"},{" "}
            {n(lastRun?.received)} of {n(lastRun?.expected)} received.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Write-only: the stored token is never fetched, shown or echoed. */
const DEFAULT_BASE_URL = "https://apis.eclatdiamonds.in/v1/api";

function CredentialForm({
  configured,
  tokenStored,
  savedBaseUrl,
}: {
  configured: boolean;
  tokenStored: boolean;
  savedBaseUrl: string | null;
}) {
  const save = useSaveWebsiteCredential();
  const [token, setToken] = useState("");
  const [baseUrl, setBaseUrl] = useState(savedBaseUrl ?? DEFAULT_BASE_URL);
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Website connection</h3>
          {configured ? <Badge variant="success">Connected</Badge> : <Badge variant="warning">Not connected</Badge>}
        </div>
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (!baseUrl.trim()) return;
            save.mutate(
              { token: token.trim() || undefined, baseUrl: baseUrl.trim() },
              {
                onSuccess: () => {
                  setToken("");
                  toast.success("Connection saved");
                },
                onError: (err) => toast.error(apiErrorMessage(err, "Could not save the connection.")),
              },
            );
          }}
        >
          <div className="grid flex-1 gap-1.5">
            <Label htmlFor="website-base">API address</Label>
            <Input
              id="website-base"
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              className="h-11 font-mono text-xs"
            />
          </div>
          <div className="grid flex-1 gap-1.5">
            <Label htmlFor="website-token">{tokenStored ? "Replace the token" : "Token (optional)"}</Label>
            <Input
              id="website-token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={tokenStored ? "A new token replaces the stored one" : "Not needed for the public feed"}
              className="h-11"
            />
          </div>
          <Button type="submit" className="h-11" disabled={!baseUrl.trim() || save.isPending}>
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {configured ? "Save" : "Connect"}
          </Button>
        </form>
        <p className="text-[11px] text-muted-foreground">
          The Eclat product feed is public, so no token is needed. A token, if given, is stored encrypted and never shown
          again — to change it, paste a new one.
        </p>
      </CardContent>
    </Card>
  );
}

function Runs({ runs, loading }: { runs: CatalogueSyncRun[]; loading: boolean }) {
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <h3 className="text-sm font-semibold">Runs</h3>
        {loading ? (
          <Skeleton className="h-24 w-full" />
        ) : runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No catalogue sync has run yet.</p>
        ) : (
          <ul className="divide-y">
            {runs.map((r) => (
              <li key={r.id} className="py-2">
                <details>
                  <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <RunStatus status={r.status} />
                    <span className="font-medium">
                      {humanize(r.source)} · {r.mode}
                      {r.dryRun ? " · dry run" : ""}
                    </span>
                    <span className="text-xs text-muted-foreground">{when(r.startedAt)}</span>
                    <span className="num ml-auto text-xs text-muted-foreground">
                      {n(r.received)}/{n(r.expected)} received
                    </span>
                  </summary>
                  <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
                    {(
                      [
                        "created",
                        "updated",
                        "unchanged",
                        "tombstoned",
                        "conflicted",
                        "failed",
                        "imagesExpected",
                        "imagesReceived",
                        "imagesQueued",
                      ] as const
                    ).map((k) => (
                      <KV key={k} label={humanize(k)}>
                        {n(r[k])}
                      </KV>
                    ))}
                    <KV label="Finished">{when(r.finishedAt)}</KV>
                  </dl>
                  {r.lastError ? (
                    <p className="mt-2 rounded bg-destructive/5 p-2 text-xs text-destructive">{r.lastError}</p>
                  ) : null}
                  {r.detail ? (
                    <pre className="mt-2 max-h-64 overflow-auto rounded bg-muted/50 p-2 text-[11px]">
                      {JSON.stringify(r.detail, null, 2)}
                    </pre>
                  ) : null}
                </details>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function Conflicts() {
  const [status, setStatus] = useState<ConflictStatus>("open");
  const [productId, setProductId] = useState<string | null>(null);
  const list = useCatalogueConflicts(status, true);
  const update = useUpdateConflict();
  const act = (c: CatalogueConflictView, next: ConflictStatus, resolution?: Record<string, unknown>) =>
    update.mutate(
      { id: c.id, status: next, resolution },
      {
        onSuccess: () => toast.success(next === "ignored" ? "Ignored" : "Resolved"),
        onError: (err) => toast.error(apiErrorMessage(err, "Could not update the conflict.")),
      },
    );
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <AlertTriangle className="h-4 w-4 text-warning" /> Conflicts to review
          </h3>
          <div className="flex gap-1" role="group" aria-label="Conflict status">
            {(["open", "resolved", "ignored"] as const).map((s) => (
              <Button
                key={s}
                size="sm"
                variant={status === s ? "default" : "ghost"}
                aria-pressed={status === s}
                onClick={() => setStatus(s)}
              >
                {humanize(s)}
              </Button>
            ))}
          </div>
        </div>
        {list.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : list.isError ? (
          <p className="text-sm text-destructive">{apiErrorMessage(list.error, "Couldn't load conflicts.")}</p>
        ) : !list.data?.length ? (
          <p className="text-sm text-muted-foreground">Nothing {status}.</p>
        ) : (
          <ul className="divide-y">
            {list.data.map((c) => {
              const candidates = candidatesOf(c);
              return (
                <li key={c.id} className="space-y-2 py-3">
                  <div className="flex flex-wrap items-start gap-2">
                    <Badge variant="outline">{humanize(c.kind)}</Badge>
                    <p className="min-w-0 flex-1 text-sm">{c.summary}</p>
                    <span className="text-[11px] text-muted-foreground">{when(c.lastSeenAt)}</span>
                  </div>
                  {candidates.length ? (
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="text-muted-foreground">Link to:</span>
                      {candidates.map((cand) => (
                        <Button
                          key={cand.productId}
                          size="sm"
                          variant="outline"
                          disabled={update.isPending || status !== "open"}
                          onClick={() => act(c, "resolved", { productId: cand.productId })}
                        >
                          {cand.label}
                        </Button>
                      ))}
                    </div>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    {c.productId ? (
                      <Button size="sm" variant="ghost" onClick={() => setProductId(c.productId!)}>
                        Open design
                      </Button>
                    ) : null}
                    {status === "open" ? (
                      <>
                        <Button size="sm" variant="outline" disabled={update.isPending} onClick={() => act(c, "resolved")}>
                          <CheckCircle2 className="h-4 w-4" /> Resolve
                        </Button>
                        <Button size="sm" variant="ghost" disabled={update.isPending} onClick={() => act(c, "ignored")}>
                          Ignore
                        </Button>
                      </>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
      <ProductDetailDialog
        productId={productId}
        open={!!productId}
        onOpenChange={(o) => {
          if (!o) setProductId(null);
        }}
      />
    </Card>
  );
}

/** `gati_match_ambiguous` carries its candidate designs in `detail.candidates`. */
function candidatesOf(c: CatalogueConflictView): { productId: string; label: string }[] {
  const raw = (c.detail as { candidates?: unknown } | null | undefined)?.candidates;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => {
      if (typeof x === "string") return { productId: x, label: x };
      const o = x as Record<string, unknown>;
      const id = (o.productId ?? o.id) as string | undefined;
      if (!id) return null;
      return { productId: id, label: String(o.styleNumber ?? o.sku ?? o.name ?? id) };
    })
    .filter((x): x is { productId: string; label: string } => !!x);
}

// ---------------------------------------------------------------- helpers

function Panel({ title, icon, children }: { title: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          {icon ? <span className="text-muted-foreground">{icon}</span> : null}
          {title}
        </h3>
        <dl className="space-y-1.5">{children}</dl>
      </CardContent>
    </Card>
  );
}

function KV({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="num text-right font-medium">{children}</dd>
    </div>
  );
}

function State({ ok, okText, badText }: { ok: boolean; okText: string; badText: string }) {
  return (
    <p className={cn("flex items-center gap-1.5 text-sm font-medium", ok ? "text-success" : "text-warning")}>
      {ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
      {ok ? okText : badText}
    </p>
  );
}

function RunStatus({ status }: { status: string }) {
  const variant =
    status === "done" ? "success" : status === "running" ? "gold" : status === "partial" ? "warning" : "destructive";
  return <Badge variant={variant}>{humanize(status)}</Badge>;
}

function n(v: number | null | undefined): string {
  return v == null ? "—" : formatNumber(v);
}

function when(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

function humanize(key: string): string {
  const s = key.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
