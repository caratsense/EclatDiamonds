"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, Clock, ImagePlus, Loader2, RefreshCw, Search, Sparkles, X } from "lucide-react";
import { toast } from "sonner";

import { ProductDetailDialog } from "@/components/catalogue/product-detail-dialog";
import { SimilarityResults } from "@/components/catalogue/similarity-results";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  MAX_QUERY_IMAGES,
  SIMILARITY_TOP_N,
  SearchBusyError,
  prepareQueryImage,
  useSimilaritySearch,
  type SimilaritySearchResult,
} from "@/lib/queries/jewelry-similarity";
import { cn, apiErrorMessage } from "@/lib/utils";

/** Before shrinking. After it every photo is ≤1 MB; this only stops absurd files. */
const MAX_PICK_BYTES = 25 * 1024 * 1024;

/** One prepared photo plus its preview URL, which has to be revoked by hand. */
interface Shot {
  file: File;
  url: string;
}

/**
 * What to photograph, in the order it helps most.
 *
 * The first shot does most of the work. The second earns its keep because the
 * catalogue picture was also taken from somewhere: a design photographed
 * flat-on cannot be matched well by a piece held at an angle, however good
 * either photo is. The third is for pieces whose shape reads differently in
 * profile — a ring, a pendant with depth.
 */
const SHOT_HINTS = [
  // No cropping needed: the service finds the piece in the photo (a pendant on
  // a velvet stand, a ring on a hand) and matches on that, not the backdrop.
  "Straight on — no need to crop, the piece is found automatically",
  "At an angle, as a customer holds it",
  "From the side, if it has depth",
];

/**
 * AI image search on the catalogue. Photograph a piece — up to three views of it
 * — and get the TOP 10 visually closest catalogue designs via the DINOv2 +
 * SigLIP 2 pipeline. Never fabricates matches.
 *
 * Photos are shrunk and oriented on the device (≤1600px, ≤1 MB) and all views
 * go in ONE request: the server scores each design on its best view against
 * the best of yours and returns one list.
 *
 * The detail of a match opens OVER this card: photos, results and scroll stay
 * exactly as they were, and closing it never searches again.
 */
export function ImageSearch() {
  const libraryRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [shots, setShots] = useState<Shot[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [result, setResult] = useState<SimilaritySearchResult | null>(null);
  /** How many photos produced the result on screen, so "search again" is honest. */
  const [searchedWith, setSearchedWith] = useState(0);
  /** Server said "busy" — epoch ms when a retry is worth it. */
  const [busyUntil, setBusyUntil] = useState<number | null>(null);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const search = useSimilaritySearch();

  function run(next: Shot[]) {
    if (!next.length || search.isPending) return;
    setBusyUntil(null);
    search.mutate(
      { files: next.map((s) => s.file), limit: SIMILARITY_TOP_N },
      {
        onSuccess: (data) => {
          setResult(data);
          setOpenIndex(null);
          setSearchedWith(next.length);
          if (data.status === "MATCHES_FOUND" && data.results?.length) {
            toast.success(
              `Found ${data.results.length} similar design${data.results.length === 1 ? "" : "s"}`,
            );
          }
        },
        onError: (err) => {
          if (err instanceof SearchBusyError) {
            setBusyUntil(Date.now() + err.retryAfterSec * 1000);
            return;
          }
          toast.error(apiErrorMessage(err, "Image search failed — try another photo."));
        },
      },
    );
  }

  async function onFiles(list: FileList | null) {
    const picked = Array.from(list ?? []);
    if (!picked.length) return;

    const room = MAX_QUERY_IMAGES - shots.length;
    if (room <= 0) {
      toast.error(`That's the limit — ${MAX_QUERY_IMAGES} views of one piece.`);
      return;
    }
    const usable = picked.filter((f) => {
      if (!f.type.startsWith("image/") && !/\.(heic|heif)$/i.test(f.name)) {
        toast.error(`${f.name} isn't an image.`);
        return false;
      }
      if (f.size > MAX_PICK_BYTES) {
        toast.error(`${f.name} is over 25 MB — choose a smaller photo.`);
        return false;
      }
      return true;
    });
    if (!usable.length) return;
    if (usable.length > room) {
      toast.error(`Only ${room} more photo${room === 1 ? "" : "s"} fit — keeping the first.`);
    }

    setPreparing(true);
    const prepared = await Promise.all(usable.slice(0, room).map(prepareQueryImage));
    setPreparing(false);
    const added = prepared.map((file) => ({ file, url: URL.createObjectURL(file) }));
    const next = [...shots, ...added];
    setShots(next);
    // The first photo searches immediately. Adding a second or third does NOT
    // re-run on its own: that is the salesperson's call, not a side effect of
    // picking a file.
    if (shots.length === 0) run(next);
  }

  function removeShot(i: number) {
    setShots((prev) => {
      URL.revokeObjectURL(prev[i].url);
      return prev.filter((_, n) => n !== i);
    });
  }

  function reset() {
    for (const s of shots) URL.revokeObjectURL(s.url);
    setShots([]);
    setResult(null);
    setOpenIndex(null);
    setSearchedWith(0);
    setBusyUntil(null);
    if (libraryRef.current) libraryRef.current.value = "";
    if (cameraRef.current) cameraRef.current.value = "";
  }

  const hits = result?.results ?? [];
  const openHit = openIndex !== null ? hits[openIndex] : undefined;
  const canSearchAgain = shots.length > 0 && shots.length !== searchedWith;
  const busy = search.isPending || preparing;

  return (
    <Card className="border-primary/30 bg-primary/[0.03]">
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Sparkles className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold">AI image search</h2>
          <span className="text-xs text-muted-foreground">
            Photograph a piece to find the closest catalogue designs
          </span>
        </div>

        <div
          role="button"
          tabIndex={0}
          aria-label="Choose photos to search with"
          onClick={() => libraryRef.current?.click()}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              libraryRef.current?.click();
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
            void onFiles(e.dataTransfer.files);
          }}
          className={cn(
            "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            dragging
              ? "border-primary bg-primary/5"
              : "border-muted-foreground/25 hover:border-primary/50",
          )}
        >
          {shots.length ? (
            <div className="flex flex-wrap items-center justify-center gap-2">
              {shots.map((s, i) => (
                <figure key={s.url} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={s.url}
                    alt={`View ${i + 1}`}
                    className="h-24 w-24 rounded-md object-cover"
                  />
                  <button
                    type="button"
                    aria-label={`Remove view ${i + 1}`}
                    disabled={busy}
                    className="absolute -right-2 -top-2 flex h-7 w-7 items-center justify-center rounded-full bg-background shadow-sm ring-1 ring-border"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeShot(i);
                    }}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </figure>
              ))}
            </div>
          ) : null}

          {busy ? (
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          ) : shots.length ? null : (
            <ImagePlus className="h-6 w-6 text-muted-foreground" />
          )}

          <p className="text-sm font-medium" aria-live="polite">
            {preparing
              ? "Preparing photo…"
              : search.isPending
                ? `Searching the catalogue with ${shots.length} view${shots.length === 1 ? "" : "s"}…`
                : shots.length
                  ? `${shots.length} of ${MAX_QUERY_IMAGES} views`
                  : "Drop an image here or click to choose"}
          </p>
          <p className="text-xs text-muted-foreground">
            {shots.length < MAX_QUERY_IMAGES
              ? SHOT_HINTS[shots.length]
              : "Any image · Pinterest screenshots, phone photos and hand sketches welcome"}
          </p>

          <input
            ref={libraryRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            data-testid="image-search-input"
            onChange={(e) => void onFiles(e.target.files)}
          />
        </div>

        {/*
          `capture` opens the iPad's rear camera directly; a desktop browser
          ignores the hint and shows a file chooser, so this is one control
          everywhere.
        */}
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => void onFiles(e.target.files)}
        />

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            className="h-11 flex-1"
            disabled={busy || shots.length >= MAX_QUERY_IMAGES}
            onClick={(e) => {
              e.stopPropagation();
              cameraRef.current?.click();
            }}
          >
            <Camera className="h-4 w-4" />
            {shots.length ? "Another angle" : "Take a photo"}
          </Button>

          {canSearchAgain ? (
            <Button
              type="button"
              variant="gold"
              className="h-11 flex-1"
              disabled={busy}
              onClick={() => run(shots)}
            >
              <Search className="h-4 w-4" />
              Search with {shots.length} view{shots.length === 1 ? "" : "s"}
            </Button>
          ) : null}
        </div>

        {busyUntil ? <BusyNotice until={busyUntil} onRetry={() => run(shots)} /> : null}

        {result ? (
          <div className="space-y-3 pt-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium text-muted-foreground">
                {result.status === "MATCHES_FOUND" || result.status === "NO_CLOSE_MATCH"
                  ? `Closest matches from ${searchedWith} view${searchedWith === 1 ? "" : "s"} (ranked by DINOv2 + SigLIP 2)`
                  : "Visual search"}
              </p>
              <Button variant="ghost" size="sm" onClick={reset}>
                <X className="h-4 w-4" /> Clear
              </Button>
            </div>
            {result.status === "NO_CLOSE_MATCH" && shots.length < MAX_QUERY_IMAGES ? (
              <p className="text-xs text-muted-foreground">
                Nothing matched closely. A second view — held at an angle rather
                than flat on — often finds a design the first one misses.
              </p>
            ) : null}
            <SimilarityResults
              result={result}
              onRetry={() => run(shots)}
              onOpen={setOpenIndex}
            />
          </div>
        ) : null}

        <ProductDetailDialog
          productId={openHit?.productId ?? null}
          seed={
            openHit
              ? { name: openHit.productName, sku: openHit.sku ?? undefined, imageUrl: openHit.imageUrl ?? undefined }
              : undefined
          }
          initialImageId={openHit?.matchedImageId ?? null}
          open={!!openHit}
          onOpenChange={(o) => {
            if (!o) setOpenIndex(null);
          }}
          nav={
            openIndex !== null && hits.length > 1
              ? {
                  index: openIndex,
                  count: hits.length,
                  onStep: (d) => setOpenIndex((i) => (i === null ? i : (i + d + hits.length) % hits.length)),
                }
              : undefined
          }
        />
      </CardContent>
    </Card>
  );
}

/** 429 from the search: say when a retry is worth it, then offer one. */
function BusyNotice({ until, onRetry }: { until: number; onRetry: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  const left = Math.max(0, Math.ceil((until - now) / 1000));
  useEffect(() => {
    if (left <= 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [left]);
  return (
    <div
      role="status"
      data-testid="search-busy"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[color-mix(in_srgb,var(--warning)_40%,transparent)] bg-[color-mix(in_srgb,var(--warning)_8%,transparent)] p-3"
    >
      <p className="flex items-center gap-2 text-sm">
        <Clock className="h-4 w-4 shrink-0 text-warning" />
        {left > 0
          ? `Visual search is busy with other searches. Try again in ${left}s.`
          : "Visual search should have room now."}
      </p>
      <Button size="sm" variant="outline" disabled={left > 0} onClick={onRetry}>
        <RefreshCw className="h-4 w-4" /> Try again
      </Button>
    </div>
  );
}
