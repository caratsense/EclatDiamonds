"use client";

import { useState, type ReactNode } from "react";
import { Gem, RefreshCw, ScanSearch, Sparkles } from "lucide-react";

import { MatchBadge } from "@/components/catalogue/match-badge";
import { Button } from "@/components/ui/button";
import { assetUrl } from "@/lib/api";
import { imageSourceLabel } from "@/lib/mock/catalogue";
import {
  useSimilarityFeedback,
  type IndexCoverage,
  type SimilarityHit,
  type SimilaritySearchResult,
  type SimilarityFeedbackValue,
} from "@/lib/queries/jewelry-similarity";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

const FEEDBACK_OPTIONS: { value: SimilarityFeedbackValue; label: string }[] = [
  { value: "very_close", label: "Very Close" },
  { value: "relevant", label: "Relevant" },
  { value: "somewhat", label: "Somewhat" },
  { value: "not_relevant", label: "Not Relevant" },
];

/**
 * THE single AI visual-search result surface (Module 5). Given one
 * SimilaritySearchResult (DINOv2 + SigLIP 2), it renders one flat,
 * closest-first list of the genuine matches — plus the honest empty /
 * unavailable / error / index-building states. No fabricated fallback.
 */
export function SimilarityResults({
  result,
  onRetry,
  onOpen,
  enableFeedback = true,
}: {
  result: SimilaritySearchResult;
  onRetry: () => void;
  /** Open the detail for the hit at `index` of `result.results`. */
  onOpen: (index: number) => void;
  enableFeedback?: boolean;
}) {
  const hits = result.results ?? [];

  // Nothing indexed yet: the server answered without calling inference. Show
  // how far the build has got, not a spinner that never ends.
  if (result.status === "CATALOGUE_INDEX_BUILD_REQUIRED") {
    return <IndexBuilding coverage={result.coverage} onRetry={onRetry} />;
  }

  // Provider not wired in this environment — configuration, not a search result.
  if (result.available === false) {
    return (
      <EmptyState
        icon={<ScanSearch className="h-8 w-8 text-muted-foreground" />}
        title="AI visual search isn't set up"
        body={
          result.reason ??
          "The image-recognition service isn't configured in this environment. Ask your administrator to enable it."
        }
      />
    );
  }

  if (result.status === "SEARCH_ERROR") {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/[0.03] py-10 text-center">
        <p className="text-sm font-semibold">Something went wrong</p>
        <p className="max-w-md text-xs text-muted-foreground">
          {result.reason ??
            "Visual search couldn't complete. Check your connection and try again."}
        </p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="h-4 w-4" /> Try again
        </Button>
      </div>
    );
  }

  if (result.status === "NOT_INDEXED") {
    return (
      <EmptyState
        icon={<ScanSearch className="h-8 w-8 text-muted-foreground" />}
        title="Catalogue not indexed for visual search"
        body={
          result.reason ??
          "This catalogue hasn't been indexed yet. Ask an administrator to run visual indexing, then try again."
        }
      />
    );
  }

  if (result.status === "NO_CLOSE_MATCH" || hits.length === 0) {
    return (
      <EmptyState
        icon={<Sparkles className="h-8 w-8 text-muted-foreground" />}
        title="No close matches found"
        body="We compared this image against the indexed catalogue, but nothing was visually similar enough."
      />
    );
  }

  // Already ordered closest → least close by the server; never re-sorted here.
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" aria-label="Closest designs">
      {hits.map((hit, i) => (
        <li key={hit.productId} className="flex">
          <ResultCard
            queryId={result.queryId ?? ""}
            hit={hit}
            onOpen={() => onOpen(i)}
            enableFeedback={enableFeedback && !!result.queryId}
          />
        </li>
      ))}
    </ul>
  );
}

/**
 * One match. The WHOLE card opens the detail: the main button covers image +
 * name (keyboard: Tab to it, Enter/Space), the card's own click handler takes
 * the padding around it, and "View details" says so in words. The rating chips
 * are the only other controls and stop their clicks from reaching the card.
 */
function ResultCard({
  queryId,
  hit,
  onOpen,
  enableFeedback,
}: {
  queryId: string;
  hit: SimilarityHit;
  onOpen: () => void;
  enableFeedback: boolean;
}) {
  // The design's own photo that matched — the reason it is on this list.
  const src = assetUrl(hit.matchedImageUrl || hit.imageUrl || hit.heroImageUrl);
  const name = hit.productName || "Unnamed piece";
  const matchedMeta = [
    imageSourceLabel(hit.matchedImageSource),
    hit.matchedColour,
    hit.matchedAngle,
  ].filter(Boolean);

  return (
    <article
      data-testid="similarity-result"
      onClick={onOpen}
      className="flex w-full cursor-pointer flex-col overflow-hidden rounded-xl border bg-card shadow-sm transition-shadow hover:border-primary/40 hover:shadow-md"
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
        aria-label={`Open ${name}, match #${hit.rank}`}
        className="group flex flex-col text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <span className="relative flex aspect-square w-full items-center justify-center overflow-hidden bg-white">
          {src ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={src}
              alt=""
              loading="lazy"
              className="h-full w-full object-contain"
            />
          ) : (
            <Gem className="h-9 w-9 text-muted-foreground/40" />
          )}
          {/* Decorative overlays never take a click. */}
          <span className="pointer-events-none absolute left-1.5 top-1.5 rounded-full bg-background/85 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground backdrop-blur">
            #<span className="num">{hit.rank}</span>
          </span>
          {matchedMeta.length ? (
            <span className="pointer-events-none absolute inset-x-1.5 bottom-1.5 truncate rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
              Matched: {matchedMeta.join(" · ")}
            </span>
          ) : null}
        </span>
        <span className="flex flex-col gap-1 px-3 pt-3">
          <span className="truncate text-sm font-medium" title={name}>
            {name}
          </span>
          {hit.sku ? (
            <span className="truncate font-mono text-[11px] text-muted-foreground" title={hit.sku}>
              {hit.sku}
            </span>
          ) : null}
          {hit.storeName ? (
            <span className="truncate text-[11px] text-muted-foreground">{hit.storeName}</span>
          ) : null}
          <span className="mt-0.5 flex items-center justify-between gap-2">
            <MatchBadge level={hit.matchLevel} />
            <span className="num text-xs font-semibold text-foreground">
              {Math.round(hit.closenessScore)}%
            </span>
          </span>
        </span>
      </button>
      <div className="mt-auto flex flex-col gap-2 p-3 pt-2">
        {enableFeedback ? <FeedbackRow queryId={queryId} hit={hit} /> : null}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-9 w-full"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          View details
        </Button>
      </div>
    </article>
  );
}

/** Subtle, fire-and-forget relevance controls. Once given, they don't nag. */
function FeedbackRow({ queryId, hit }: { queryId: string; hit: SimilarityHit }) {
  const [given, setGiven] = useState<SimilarityFeedbackValue | null>(null);
  const feedback = useSimilarityFeedback();

  if (given) {
    const label = FEEDBACK_OPTIONS.find((o) => o.value === given)?.label ?? "Thanks";
    return (
      <p className="text-[11px] text-muted-foreground" aria-live="polite">
        Thanks — marked “{label}”.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1" onClick={(e) => e.stopPropagation()}>
      <span className="mr-0.5 text-[11px] text-muted-foreground">Rate:</span>
      {FEEDBACK_OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={(e) => {
            e.stopPropagation();
            setGiven(o.value);
            feedback.mutate({
              queryId,
              productId: hit.productId,
              rank: hit.rank,
              feedback: o.value,
            });
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function IndexBuilding({
  coverage,
  onRetry,
}: {
  coverage?: IndexCoverage;
  onRetry: () => void;
}) {
  const total = coverage?.total ?? 0;
  const indexed = coverage?.indexed ?? 0;
  const pct = total ? Math.round((indexed / total) * 100) : 0;
  return (
    <div className="space-y-3 rounded-xl border border-dashed p-5" data-testid="index-building">
      <div className="flex items-start gap-3">
        <ScanSearch className="mt-0.5 h-6 w-6 shrink-0 text-muted-foreground" />
        <div className="space-y-1">
          <p className="text-sm font-semibold">Visual search is still being built</p>
          <p className="text-xs text-muted-foreground">
            None of the catalogue photos are searchable yet. Your photo was not
            compared with anything — search again once some are indexed.
          </p>
        </div>
      </div>
      {coverage ? (
        <>
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            aria-label="Photos indexed for visual search"
          >
            <div className="h-full rounded-full bg-[var(--gold)]" style={{ width: `${pct}%` }} />
          </div>
          <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <Count label="Indexed" value={`${formatNumber(indexed)} of ${formatNumber(total)}`} />
            <Count label="Waiting" value={formatNumber(coverage.queued ?? 0)} />
            <Count label="Failed" value={formatNumber(coverage.failed ?? 0)} />
            <Count label="Done" value={`${pct}%`} />
          </dl>
        </>
      ) : null}
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RefreshCw className="h-4 w-4" /> Check again
      </Button>
    </div>
  );
}

function Count({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="num font-medium">{value}</dd>
    </div>
  );
}

function EmptyState({
  icon,
  title,
  body,
}: {
  icon: ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 rounded-xl border border-dashed py-10 text-center",
      )}
    >
      {icon}
      <p className="text-sm font-semibold">{title}</p>
      <p className="max-w-md text-xs text-muted-foreground">{body}</p>
    </div>
  );
}
