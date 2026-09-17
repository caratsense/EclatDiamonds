"use client";

import { useRef, useState } from "react";
import { Camera, ImagePlus, Loader2, Search, Sparkles, X } from "lucide-react";
import { toast } from "sonner";

import { SimilarityResults } from "@/components/catalogue/similarity-results";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  MAX_QUERY_IMAGES,
  SIMILARITY_TOP_N,
  useSimilaritySearch,
  type SimilaritySearchResult,
} from "@/lib/queries/jewelry-similarity";
import { cn, apiErrorMessage } from "@/lib/utils";

const MAX_BYTES = 8 * 1024 * 1024; // ~8 MB

/** One picked photo plus its preview URL, which has to be revoked by hand. */
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
  "Straight on, filling the frame",
  "At an angle, as a customer holds it",
  "From the side, if it has depth",
];

/**
 * AI image search on the catalogue. Photograph a piece — up to three views of it
 * — and get the TOP 10 visually closest catalogue designs via the DINOv3 +
 * SigLIP 2 pipeline. Same engine, result set and {@link SimilarityResults}
 * presentation as the Find-Similar page. Never fabricates matches.
 *
 * Several views are not several searches. Both sides of the comparison are
 * photographs taken from somewhere, so one of each is a single guess at which
 * two angles happen to correspond; the server scores each design on its best
 * view against the best of yours and returns one list of designs.
 */
export function ImageSearch() {
  const libraryRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [shots, setShots] = useState<Shot[]>([]);
  const [dragging, setDragging] = useState(false);
  const [result, setResult] = useState<SimilaritySearchResult | null>(null);
  /** How many photos produced the result on screen, so "search again" is honest. */
  const [searchedWith, setSearchedWith] = useState(0);
  const search = useSimilaritySearch();

  function run(next: Shot[]) {
    if (!next.length) return;
    setResult(null);
    search.mutate(
      { files: next.map((s) => s.file), limit: SIMILARITY_TOP_N },
      {
        onSuccess: (data) => {
          setResult(data);
          setSearchedWith(next.length);
          if (data.status === "MATCHES_FOUND") {
            toast.success(
              `Found ${data.results.length} similar design${data.results.length === 1 ? "" : "s"}`,
            );
          }
        },
        onError: (err) =>
          toast.error(apiErrorMessage(err, "Image search failed — try another photo.")),
      },
    );
  }

  function onFiles(list: FileList | null) {
    const picked = Array.from(list ?? []);
    if (!picked.length) return;

    const room = MAX_QUERY_IMAGES - shots.length;
    if (room <= 0) {
      toast.error(`That's the limit — ${MAX_QUERY_IMAGES} views of one piece.`);
      return;
    }
    const usable = picked.filter((f) => {
      if (!f.type.startsWith("image/")) {
        toast.error(`${f.name} isn't an image.`);
        return false;
      }
      if (f.size > MAX_BYTES) {
        toast.error(`${f.name} is over 8 MB — shrink it and try again.`);
        return false;
      }
      return true;
    });
    if (!usable.length) return;
    if (usable.length > room) {
      toast.error(`Only ${room} more photo${room === 1 ? "" : "s"} fit — keeping the first.`);
    }

    const added = usable.slice(0, room).map((file) => ({
      file,
      url: URL.createObjectURL(file),
    }));
    const next = [...shots, ...added];
    setShots(next);
    // The first photo searches immediately, the way one-shot search always has.
    // Adding a second or third does NOT re-run on its own: each extra view is
    // another embedding call on a rate-limited endpoint, so that is the
    // salesperson's call to make, not a side effect of picking a file.
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
    setSearchedWith(0);
    if (libraryRef.current) libraryRef.current.value = "";
    if (cameraRef.current) cameraRef.current.value = "";
  }

  const canSearchAgain = shots.length > 0 && shots.length !== searchedWith;

  return (
    <Card className="border-primary/30 bg-primary/[0.03]">
      <CardContent className="space-y-4 p-4">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold">AI image search</h2>
          <span className="text-xs text-muted-foreground">
            Photograph a piece to find the closest catalogue designs
          </span>
        </div>

        <div
          role="button"
          tabIndex={0}
          onClick={() => libraryRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") libraryRef.current?.click();
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            onFiles(e.dataTransfer.files);
          }}
          className={cn(
            "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 text-center transition-colors",
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
                    className="absolute -right-1.5 -top-1.5 rounded-full bg-background p-0.5 shadow-sm ring-1 ring-border"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeShot(i);
                    }}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </figure>
              ))}
            </div>
          ) : null}

          {search.isPending ? (
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          ) : shots.length ? null : (
            <ImagePlus className="h-6 w-6 text-muted-foreground" />
          )}

          <p className="text-sm font-medium">
            {search.isPending
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
            onChange={(e) => onFiles(e.target.files)}
          />
        </div>

        {/*
          `capture` opens the iPad's rear camera directly instead of the photo
          roll; a desktop browser ignores the hint and shows a file chooser, so
          this is one control everywhere. stopPropagation keeps the click off the
          drop zone above, which would open the picker as well.
        */}
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => onFiles(e.target.files)}
        />

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="flex-1"
            disabled={search.isPending || shots.length >= MAX_QUERY_IMAGES}
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
              size="sm"
              className="flex-1"
              disabled={search.isPending}
              onClick={() => run(shots)}
            >
              <Search className="h-4 w-4" />
              Search with {shots.length} view{shots.length === 1 ? "" : "s"}
            </Button>
          ) : null}
        </div>

        {result ? (
          <div className="space-y-3 pt-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-muted-foreground">
                Closest matches from {searchedWith} view
                {searchedWith === 1 ? "" : "s"} (ranked by DINOv3 + SigLIP 2)
              </p>
              <Button variant="ghost" size="sm" onClick={reset}>
                <X className="h-4 w-4" /> Clear
              </Button>
            </div>
            {result.status !== "MATCHES_FOUND" && shots.length < MAX_QUERY_IMAGES ? (
              <p className="text-xs text-muted-foreground">
                Nothing matched closely. A second view — held at an angle rather
                than flat on — often finds a design the first one misses.
              </p>
            ) : null}
            <SimilarityResults result={result} onRetry={() => run(shots)} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
