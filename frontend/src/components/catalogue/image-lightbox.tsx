"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { assetUrl } from "@/lib/api";
import { cn } from "@/lib/utils";

export interface LightboxImage {
  url: string;
  label?: string;
}

/**
 * A design's photos at screen size — for turning the iPad round to a customer.
 *
 * Made for the Gati CAD sheet above all: it carries the exact dimensions
 * (0.60 INCH, 4.00 MM…) in small print, which a thumbnail cannot show. "Fit"
 * shows the whole sheet; tapping it (or the zoom button) switches to the
 * sheet's real pixel size, scrollable, so the callouts are readable.
 */
export function ImageLightbox({
  images,
  index,
  onIndexChange,
  onClose,
  title,
}: {
  images: LightboxImage[];
  /** Open on this image; null = closed. */
  index: number | null;
  onIndexChange: (i: number) => void;
  onClose: () => void;
  title: string;
}) {
  const [zoomed, setZoomed] = useState(false);
  const open = index !== null && images.length > 0;
  const i = open ? Math.min(index, images.length - 1) : 0;
  const img = images[i];
  const step = (d: number) => {
    setZoomed(false);
    onIndexChange((i + d + images.length) % images.length);
  };

  useEffect(() => {
    if (!open || images.length < 2) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") step(1);
      if (e.key === "ArrowLeft") step(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setZoomed(false);
          onClose();
        }
      }}
    >
      <DialogContent className="flex h-[92vh] w-[96vw] max-w-[96vw] flex-col gap-2 p-3 sm:max-w-[96vw]">
        <div className="flex items-center gap-2 pr-8">
          <DialogTitle className="truncate text-sm font-medium">
            {title}
            {img?.label ? <span className="text-muted-foreground"> · {img.label}</span> : null}
          </DialogTitle>
          {images.length > 1 ? (
            <span className="text-xs text-muted-foreground">
              {i + 1} / {images.length}
            </span>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="ml-auto h-8"
            onClick={() => setZoomed((z) => !z)}
          >
            {zoomed ? <ZoomOut className="h-4 w-4" /> : <ZoomIn className="h-4 w-4" />}
            {zoomed ? "Fit to screen" : "Actual size"}
          </Button>
        </div>

        <div
          className={cn(
            "relative min-h-0 flex-1 rounded-md bg-white",
            zoomed ? "overflow-auto" : "flex items-center justify-center overflow-hidden",
          )}
        >
          {img ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={assetUrl(img.url)}
              alt={img.label ? `${title} — ${img.label}` : title}
              onClick={() => setZoomed((z) => !z)}
              className={cn(
                zoomed
                  ? "max-w-none cursor-zoom-out"
                  : "max-h-full max-w-full cursor-zoom-in object-contain",
              )}
            />
          ) : null}

          {images.length > 1 ? (
            <>
              <Button
                type="button"
                size="icon"
                variant="secondary"
                aria-label="Previous photo"
                className="absolute left-2 top-1/2 -translate-y-1/2 shadow"
                onClick={() => step(-1)}
              >
                <ChevronLeft className="h-5 w-5" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="secondary"
                aria-label="Next photo"
                className="absolute right-2 top-1/2 -translate-y-1/2 shadow"
                onClick={() => step(1)}
              >
                <ChevronRight className="h-5 w-5" />
              </Button>
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
