"use client";

import { useRef, useState } from "react";
import { ImagePlus, Loader2, Sparkles, X } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ProductCard } from "@/components/catalogue/product-card";
import { CATEGORY_LABELS, METAL_LABELS, type Product } from "@/lib/mock/catalogue";
import { useImageSearch, type ImageSearchResult } from "@/lib/queries/products";
import { cn, apiErrorMessage } from "@/lib/utils";

interface ImageSearchProps {
  onOpenProduct: (product: Product) => void;
}

/**
 * AI image-based search (Module 5). Upload / drop a design image; Claude vision
 * tags it (category / metal / style keywords) and the catalogue is matched
 * rule-based, server-side. Falls back to a rule-based "best matches" view when
 * no AI key is configured.
 */
export function ImageSearch({ onOpenProduct }: ImageSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [result, setResult] = useState<ImageSearchResult | null>(null);
  const search = useImageSearch();

  function onFiles(files: FileList | null) {
    const f = files?.[0];
    if (!f) return;
    setFileName(f.name);
    search.mutate(f, {
      onSuccess: (data) => {
        setResult(data);
        toast.success(
          data.aiUsed ? "Found similar designs" : "Showing closest catalogue matches",
          { description: `${data.results.length} matches for "${f.name}"` },
        );
      },
      onError: (err) => toast.error(apiErrorMessage(err, "Image search failed — try another image.")),
    });
  }

  function reset() {
    setFileName(null);
    setResult(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  const detected = result?.detected;

  return (
    <Card className="border-primary/30 bg-primary/[0.03]">
      <CardContent className="space-y-4 p-4">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold">AI image search</h2>
          <span className="text-xs text-muted-foreground">
            Upload a design photo or sketch to find similar pieces
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
          {search.isPending ? (
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          ) : (
            <ImagePlus className="h-6 w-6 text-muted-foreground" />
          )}
          <p className="text-sm font-medium">
            {search.isPending
              ? "Analysing image…"
              : fileName ?? "Drop an image here or click to upload"}
          </p>
          <p className="text-xs text-muted-foreground">
            JPG / PNG · Pinterest screenshots and hand sketches welcome
          </p>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => onFiles(e.target.files)}
          />
        </div>

        {result ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <p className="text-xs font-medium text-muted-foreground">
                  {result.aiUsed ? "Similar designs in the catalogue" : "Closest matches"}
                </p>
                {detected ? (
                  <>
                    <Badge variant="secondary" className="text-[11px]">
                      {CATEGORY_LABELS[detected.category as Product["category"]] ?? detected.category}
                    </Badge>
                    <Badge variant="secondary" className="text-[11px]">
                      {METAL_LABELS[detected.metal as Product["metal"]] ?? detected.metal}
                    </Badge>
                    {detected.keywords.slice(0, 4).map((k) => (
                      <Badge key={k} variant="outline" className="text-[11px]">
                        {k}
                      </Badge>
                    ))}
                  </>
                ) : null}
              </div>
              <Button variant="ghost" size="sm" onClick={reset}>
                <X className="h-4 w-4" /> Clear
              </Button>
            </div>
            {result.results.length === 0 ? (
              <p className="rounded-lg border border-dashed py-6 text-center text-xs text-muted-foreground">
                No catalogue matches for this image.
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {result.results.map((p) => (
                  <ProductCard
                    key={p.id}
                    product={p}
                    similarity={p.similarity}
                    onOpen={onOpenProduct}
                  />
                ))}
              </div>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
