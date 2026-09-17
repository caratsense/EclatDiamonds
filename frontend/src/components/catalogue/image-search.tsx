"use client";

import { useRef, useState } from "react";
import { Camera, ImagePlus, Loader2, Sparkles, X } from "lucide-react";
import { toast } from "sonner";

import { SimilarityResults } from "@/components/catalogue/similarity-results";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  SIMILARITY_TOP_N,
  useSimilaritySearch,
  type SimilaritySearchResult,
} from "@/lib/queries/jewelry-similarity";
import { cn, apiErrorMessage } from "@/lib/utils";

const MAX_BYTES = 8 * 1024 * 1024; // ~8 MB

/**
 * AI image search on the catalogue. Upload a design photo → the TOP 10 visually
 * closest catalogue pieces via the DINOv2 + SigLIP 2 pipeline. Same engine, same
 * result set and same {@link SimilarityResults} presentation as the Find-Similar
 * page — one experience, never a parallel one. Never fabricates matches.
 */
export function ImageSearch() {
  const inputRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [lastFile, setLastFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [result, setResult] = useState<SimilaritySearchResult | null>(null);
  const search = useSimilaritySearch();

  function run(file: File) {
    setResult(null);
    search.mutate(
      { file, limit: SIMILARITY_TOP_N },
      {
        onSuccess: (data) => {
          setResult(data);
          if (data.status === "MATCHES_FOUND") {
            toast.success(
              `Found ${data.results.length} similar design${data.results.length === 1 ? "" : "s"}`,
            );
          }
        },
        onError: (err) =>
          toast.error(apiErrorMessage(err, "Image search failed — try another image.")),
      },
    );
  }

  function onFiles(files: FileList | null) {
    const f = files?.[0];
    if (!f) return;
    if (!f.type.startsWith("image/")) {
      toast.error("That's not an image — drop a JPG or PNG design photo.");
      return;
    }
    if (f.size > MAX_BYTES) {
      toast.error("Image is too large — keep it under 8 MB.");
      return;
    }
    setFileName(f.name);
    setLastFile(f);
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(f);
    });
    run(f);
  }

  function reset() {
    setFileName(null);
    setLastFile(null);
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setResult(null);
    if (inputRef.current) inputRef.current.value = "";
    if (cameraRef.current) cameraRef.current.value = "";
  }

  return (
    <Card className="border-primary/30 bg-primary/[0.03]">
      <CardContent className="space-y-4 p-4">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold">AI image search</h2>
          <span className="text-xs text-muted-foreground">
            Upload a design photo or sketch to find the closest catalogue pieces
          </span>
        </div>

        <div
          role="button"
          tabIndex={0}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
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
          {previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={previewUrl}
              alt={fileName ?? "Uploaded design"}
              className="max-h-32 w-auto rounded-md object-contain"
            />
          ) : null}
          {search.isPending ? (
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          ) : previewUrl ? null : (
            <ImagePlus className="h-6 w-6 text-muted-foreground" />
          )}
          <p className="text-sm font-medium">
            {search.isPending
              ? "Searching the catalogue with AI…"
              : fileName ?? "Drop an image here or click to upload"}
          </p>
          <p className="text-xs text-muted-foreground">
            Any image · Pinterest screenshots, phone photos and hand sketches welcome
          </p>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => onFiles(e.target.files)}
          />
        </div>

        {/*
          Photograph the piece in front of you rather than finding it in a photo
          roll. `capture` opens the iPad’s rear camera directly; a desktop
          browser ignores the hint and shows an ordinary file chooser, so this
          is one control everywhere. stopPropagation keeps the click off the drop
          zone wrapping it, which would open the picker as well.
        */}
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => onFiles(e.target.files)}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full"
          disabled={search.isPending}
          onClick={(e) => {
            e.stopPropagation();
            cameraRef.current?.click();
          }}
        >
          <Camera className="h-4 w-4" />
          Take a photo
        </Button>

        {result ? (
          <div className="space-y-3 pt-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-muted-foreground">
                Closest catalogue matches (ranked best-first by DINOv2 + SigLIP 2)
              </p>
              <Button variant="ghost" size="sm" onClick={reset}>
                <X className="h-4 w-4" /> Clear
              </Button>
            </div>
            <SimilarityResults result={result} onRetry={() => lastFile && run(lastFile)} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
