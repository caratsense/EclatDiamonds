"use client";

import { useState, type ReactNode } from "react";
import { Gem, RefreshCw, ScanSearch, Sparkles } from "lucide-react";

import { MatchBadge } from "@/components/catalogue/match-badge";
import { Button } from "@/components/ui/button";
import { assetUrl } from "@/lib/api";
import {
  useSimilarityFeedback,
  type SimilarityHit,
  type SimilaritySearchResult,
  type SimilarityFeedbackValue,
} from "@/lib/queries/jewelry-similarity";
import { cn } from "@/lib/utils";

const FEEDBACK_OPTIONS: { value: SimilarityFeedbackValue; label: string }[] = [
  { value: "very_close", label: "Very Close" },
  { value: "relevant", label: "Relevant" },
  { value: "somewhat", label: "Somewhat" },
  { value: "not_relevant", label: "Not Relevant" },
];

/**
 * THE single AI visual-search result surface (Module 5). Given one
 * SimilaritySearchResult from JewelrySimilarityService (DINOv2 + SigLIP), it
 * renders exactly one flat, closest-first list of the genuine matches — plus the
 * honest empty/unavailable/error/not-indexed states. No spotlight/alternatives
 * split, no fabricated fallback. Reused by every entry point so there is one
 * experience and one result set.
 */
export function SimilarityResults({
  result,
  onRetry,
  enableFeedback = true,
}: {
  result: SimilaritySearchResult;
  onRetry: () => void;
  enableFeedback?: boolean;
}) {
  // 1. Provider not wired in this environment — configuration, not a search result.
  if (!result.available) {
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

  // 2. The service errored / timed out — offer a retry.
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

  // 3. Catalogue not embedded yet — actionable, distinct from a genuine no-match.
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

  // 4. Real embeddings compared, nothing close enough — a genuine outcome.
  if (result.status === "NO_CLOSE_MATCH" || result.results.length === 0) {
    return (
      <EmptyState
        icon={<Sparkles className="h-8 w-8 text-muted-foreground" />}
        title="No close matches found"
        body="We compared this image against the indexed catalogue, but nothing was visually similar enough."
      />
    );
  }

  // 5. MATCHES_FOUND — one flat list, already ordered closest → least close by the
  // server (never re-sorted here, never padded to a fixed count).
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {result.results.map((hit) => (
        <ResultCard
          key={hit.productId}
          queryId={result.queryId}
          hit={hit}
          enableFeedback={enableFeedback}
        />
      ))}
    </div>
  );
}

function ResultCard({
  queryId,
  hit,
  enableFeedback,
}: {
  queryId: string;
  hit: SimilarityHit;
  enableFeedback: boolean;
}) {
  const src = hit.imageUrl ? assetUrl(hit.imageUrl) : null;
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="relative flex aspect-square items-center justify-center overflow-hidden bg-muted">
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={hit.productName || "Matching product"}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <Gem className="h-9 w-9 text-muted-foreground/40" />
        )}
        <span className="absolute left-1.5 top-1.5 rounded-full bg-background/85 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground backdrop-blur">
          #<span className="num">{hit.rank}</span>
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-3">
        <p className="truncate text-sm font-medium" title={hit.productName}>
          {hit.productName || "Unnamed piece"}
        </p>
        {hit.sku ? (
          <p className="truncate text-[11px] text-muted-foreground" title={hit.sku}>
            {hit.sku}
          </p>
        ) : null}
        {hit.storeName ? (
          <p className="truncate text-[11px] text-muted-foreground">{hit.storeName}</p>
        ) : null}
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <MatchBadge level={hit.matchLevel} />
          <span className="num text-xs font-semibold text-foreground">
            {Math.round(hit.closenessScore)}%
          </span>
        </div>
        {enableFeedback ? (
          <div className="mt-1">
            <FeedbackRow queryId={queryId} hit={hit} />
          </div>
        ) : null}
      </div>
    </div>
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
    <div className="flex flex-wrap items-center gap-1">
      <span className="mr-0.5 text-[11px] text-muted-foreground">Rate:</span>
      {FEEDBACK_OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
          onClick={() => {
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
