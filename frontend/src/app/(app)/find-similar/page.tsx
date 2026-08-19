"use client";

import { useRef, useState, type ReactNode } from "react";
import {
  Gem,
  ImagePlus,
  Loader2,
  RefreshCw,
  ScanSearch,
  Sparkles,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { SectionHeader } from "@/components/section/section-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { assetUrl } from "@/lib/api";
import { getNavItem } from "@/lib/navigation";
import {
  useSimilarityFeedback,
  useSimilaritySearch,
  type MatchLevel,
  type SimilarityFeedbackValue,
  type SimilarityHit,
  type SimilaritySearchResult,
} from "@/lib/queries/jewelry-similarity";
import { apiErrorMessage, cn } from "@/lib/utils";

const nav = getNavItem("find-similar")!;

const MAX_BYTES = 8 * 1024 * 1024; // ~8 MB, per spec

/** Match-level → label + colour-coded Badge variant. */
const MATCH_LEVEL: Record<
  MatchLevel,
  { label: string; variant: "success" | "gold" | "default" | "outline" }
> = {
  VERY_CLOSE: { label: "Very Close", variant: "success" },
  CLOSE: { label: "Close", variant: "gold" },
  SIMILAR: { label: "Similar", variant: "default" },
  WEAK: { label: "Weak", variant: "outline" },
  NO_CLOSE_MATCH: { label: "No Close Match", variant: "outline" },
};

const FEEDBACK_OPTIONS: { value: SimilarityFeedbackValue; label: string }[] = [
  { value: "very_close", label: "Very Close" },
  { value: "relevant", label: "Relevant" },
  { value: "somewhat", label: "Somewhat" },
  { value: "not_relevant", label: "Not Relevant" },
];

function MatchBadge({ level }: { level: MatchLevel }) {
  const m = MATCH_LEVEL[level];
  return <Badge variant={m.variant}>{m.label}</Badge>;
}

export default function FindSimilarPage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [result, setResult] = useState<SimilaritySearchResult | null>(null);
  const search = useSimilaritySearch();

  function pickFile(f: File | undefined | null) {
    if (!f) return;
    // Drag-drop bypasses the accept filter — guard type + size client-side.
    if (!f.type.startsWith("image/")) {
      toast.error("That's not an image — drop a JPG or PNG photo.");
      return;
    }
    if (f.size > MAX_BYTES) {
      toast.error("Image is too large — keep it under 8 MB.");
      return;
    }
    setFile(f);
    setFileName(f.name);
    setResult(null);
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(f);
    });
  }

  function runSearch() {
    if (!file) return;
    search.mutate(
      { file },
      {
        onSuccess: (data) => setResult(data),
        onError: (err) =>
          toast.error(apiErrorMessage(err, "Visual search failed — try again.")),
      },
    );
  }

  function reset() {
    setFile(null);
    setFileName(null);
    setResult(null);
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <>
      <SectionHeader title={nav.title} purpose={nav.purpose} />

      <div className="mx-auto max-w-4xl space-y-6">
        {/* Upload */}
        <Card className="border-primary/30 bg-primary/[0.03]">
          <CardContent className="space-y-4 p-4">
            <div className="flex items-center gap-2">
              <ScanSearch className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold">Visual search</h2>
              <span className="text-xs text-muted-foreground">
                Upload a reference or inspiration photo to find similar pieces
              </span>
            </div>

            <div
              role="button"
              tabIndex={0}
              aria-label="Upload a reference photo"
              onClick={() => inputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  inputRef.current?.click();
                }
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                pickFile(e.dataTransfer.files?.[0]);
              }}
              className={cn(
                "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 text-center transition-colors",
                dragging
                  ? "border-primary bg-primary/5"
                  : "border-muted-foreground/25 hover:border-primary/50",
              )}
            >
              {previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={previewUrl}
                  alt={fileName ?? "Reference photo"}
                  className="max-h-40 w-auto rounded-md object-contain"
                />
              ) : (
                <ImagePlus className="h-6 w-6 text-muted-foreground" />
              )}
              <p className="text-sm font-medium">
                {fileName ?? "Drop a photo here or click to upload"}
              </p>
              <p className="text-xs text-muted-foreground">
                JPG / PNG · up to 8 MB · Pinterest screenshots and customer photos welcome
              </p>
              <input
                ref={inputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => pickFile(e.target.files?.[0])}
              />
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="gold"
                onClick={runSearch}
                disabled={!file || search.isPending}
              >
                {search.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ScanSearch className="h-4 w-4" />
                )}
                {search.isPending ? "Searching…" : "Search Similar Jewellery"}
              </Button>
              {file ? (
                <Button variant="ghost" size="sm" onClick={reset}>
                  <X className="h-4 w-4" /> Clear
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>

        {/* Loading */}
        {search.isPending ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-12 text-center">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm font-medium">Finding visually similar jewellery…</p>
            <p className="text-xs text-muted-foreground">
              Matching your photo against the catalogue.
            </p>
          </div>
        ) : null}

        {/* Results / states */}
        {!search.isPending && result ? (
          <SearchOutcome result={result} onRetry={runSearch} />
        ) : null}
      </div>
    </>
  );
}

/** Renders the correct state for a completed search: unavailable / error / no-match / matches. */
function SearchOutcome({
  result,
  onRetry,
}: {
  result: SimilaritySearchResult;
  onRetry: () => void;
}) {
  // Feature not wired in this env — distinct from an error.
  if (!result.available) {
    return (
      <EmptyState
        icon={<ScanSearch className="h-8 w-8 text-muted-foreground" />}
        title="Visual search isn't configured yet"
        body={
          result.reason ??
          "The image-recognition service isn't set up in this environment. Ask your administrator to enable it."
        }
      />
    );
  }

  // Real failure — offer a retry.
  if (result.status === "SEARCH_ERROR") {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/[0.03] py-10 text-center">
        <X className="h-8 w-8 text-destructive" />
        <p className="text-sm font-semibold">Something went wrong</p>
        <p className="max-w-md text-xs text-muted-foreground">
          {result.reason ??
            "The visual search couldn't complete. Check your connection and try again."}
        </p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="h-4 w-4" /> Try again
        </Button>
      </div>
    );
  }

  // No hit cleared the close-match threshold — NOT an error, NOT "no products".
  if (result.status === "NO_CLOSE_MATCH" || result.results.length === 0) {
    return (
      <EmptyState
        icon={<Sparkles className="h-8 w-8 text-muted-foreground" />}
        title="No sufficiently close match found"
        body="We found visually related products, but none passed the close-match threshold."
      />
    );
  }

  // MATCHES_FOUND — closest match spotlight + alternatives grid.
  const [closest, ...alternatives] = result.results;
  return (
    <div className="space-y-5">
      <ClosestMatch queryId={result.queryId} hit={closest} />

      {alternatives.length > 0 ? (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">Similar Alternatives</h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {alternatives.map((hit) => (
              <AlternativeCard
                key={hit.productId}
                queryId={result.queryId}
                hit={hit}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ThumbImage({
  hit,
  className,
}: {
  hit: SimilarityHit;
  className?: string;
}) {
  const src = assetUrl(hit.imageUrl ?? undefined);
  return (
    <div
      className={cn(
        "relative flex items-center justify-center overflow-hidden bg-muted",
        className,
      )}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={hit.productName || "Matching product"}
          loading="lazy"
          className="h-full w-full object-cover"
        />
      ) : (
        <Gem className="h-10 w-10 text-muted-foreground/40" />
      )}
    </div>
  );
}

function ClosestMatch({ queryId, hit }: { queryId: string; hit: SimilarityHit }) {
  return (
    <Card className="overflow-hidden border-primary/40">
      <CardContent className="flex flex-col gap-4 p-4 sm:flex-row">
        <ThumbImage hit={hit} className="aspect-square w-full shrink-0 rounded-lg sm:w-48" />
        <div className="flex flex-1 flex-col gap-2">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <span className="text-xs font-medium uppercase tracking-wide text-primary">
              Closest Match
            </span>
          </div>
          <p className="text-base font-semibold">{hit.productName || "Unnamed piece"}</p>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">
              Closeness{" "}
              <span className="num font-semibold text-foreground">
                {Math.round(hit.closenessScore)}
              </span>{" "}
              / 100
            </span>
            <MatchBadge level={hit.matchLevel} />
          </div>
          <div className="mt-auto pt-2">
            <FeedbackRow queryId={queryId} hit={hit} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function AlternativeCard({
  queryId,
  hit,
}: {
  queryId: string;
  hit: SimilarityHit;
}) {
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border bg-card shadow-sm">
      <ThumbImage hit={hit} className="aspect-square" />
      <div className="flex flex-1 flex-col gap-1.5 p-3">
        <p className="truncate text-sm font-medium" title={hit.productName}>
          {hit.productName || "Unnamed piece"}
        </p>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            <span className="num font-medium text-foreground">
              {Math.round(hit.closenessScore)}
            </span>{" "}
            / 100
          </span>
          <span className="text-xs text-muted-foreground">
            #<span className="num">{hit.rank}</span>
          </span>
        </div>
        <MatchBadge level={hit.matchLevel} />
        <div className="mt-1">
          <FeedbackRow queryId={queryId} hit={hit} />
        </div>
      </div>
    </div>
  );
}

/** Subtle, fire-and-forget relevance controls. Once given, they don't nag. */
function FeedbackRow({ queryId, hit }: { queryId: string; hit: SimilarityHit }) {
  const [given, setGiven] = useState<SimilarityFeedbackValue | null>(null);
  const feedback = useSimilarityFeedback();

  if (given) {
    const label =
      FEEDBACK_OPTIONS.find((o) => o.value === given)?.label ?? "Thanks";
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
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-12 text-center">
      {icon}
      <p className="text-sm font-semibold">{title}</p>
      <p className="max-w-md text-xs text-muted-foreground">{body}</p>
    </div>
  );
}
