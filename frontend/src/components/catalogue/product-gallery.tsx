"use client";

import { useRef, useState } from "react";
import { Camera, Expand, Gem, ImagePlus, Loader2, Pin, PinOff, Star, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { assetUrl } from "@/lib/api";
import { imageSourceLabel, type ProductImage } from "@/lib/mock/catalogue";
import { prepareQueryImage } from "@/lib/queries/jewelry-similarity";
import {
  useAddProductImages,
  useDeleteProductImage,
  useSetPrimaryProductImage,
  useUnpinPrimaryProductImage,
} from "@/lib/queries/products";
import { apiErrorMessage, cn } from "@/lib/utils";

/** Per-photo ceiling, matching the API's own limit on this route. */
const MAX_BYTES = 12 * 1024 * 1024;

/** The views worth labelling, in the order a piece is usually shot. */
const ANGLES = ["Front", "Side", "Back", "On model", "Detail", "CAD / design"] as const;

/**
 * The views that let a customer's photo find the design, whichever way they
 * hold the camera. Not "CAD / design": a render is lit like no real piece.
 */
const SEARCH_ANGLES = ["Front", "Side", "On model"] as const;

/** "Not specified" as a Select value — Radix reserves the empty string. */
const NO_ANGLE = "__none__";

/** What a picture shows, in words: colour · angle · shape. */
export function imageCaption(img: ProductImage): string {
  return [img.colour, img.angle, img.shape].filter(Boolean).join(" · ");
}

/**
 * Every photograph of a design: the selected one large (the only full-size
 * download), the rest as thumbnails. Each carries where it came from (CAD /
 * Website / Manual / Inventory) and which one is Primary. Head office can pin
 * a different primary; managers can add photos and remove ones added by hand.
 */
export function ProductGallery({
  productId,
  productName,
  images,
  selectedId,
  onSelect,
  matchedImageId,
  canEdit,
  canPin,
  onOpenFull,
}: {
  productId: string;
  productName: string;
  /** Display order, primary first. */
  images: ProductImage[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** The photo a visual search matched on, badged as such. */
  matchedImageId?: string | null;
  canEdit: boolean;
  canPin: boolean;
  /** Show photo `index` full screen. */
  onOpenFull: (index: number) => void;
}) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);
  const [angle, setAngle] = useState<string>(NO_ANGLE);
  const [preparing, setPreparing] = useState(false);

  const add = useAddProductImages();
  const pin = useSetPrimaryProductImage();
  const unpin = useUnpinPrimaryProductImage();
  const remove = useDeleteProductImage();
  const busy = preparing || add.isPending || pin.isPending || unpin.isPending || remove.isPending;

  const index = Math.max(0, images.findIndex((i) => i.id === selectedId));
  const selected = images[index];
  const primary = images.find((i) => i.isPrimary);
  // Only while photographs are few: a website set of seven arrives unlabelled,
  // and nagging about its angles would be noise.
  const photos = images.filter((i) => i.source !== "gati_cad");
  const have = new Set(images.map((i) => i.angle).filter(Boolean) as string[]);
  const missing = photos.length < 3 ? SEARCH_ANGLES.filter((a) => !have.has(a)) : [];

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(e.target.files ?? []);
    // Clear immediately: re-picking the same file otherwise fires no change event.
    e.target.value = "";
    if (!chosen.length) return;
    // Shrunk here to a ≤1600 px JPEG: an iPad photo is several MB over shop
    // wifi, and its HEIC (which Safari decodes) would show nowhere else. A CAD
    // sheet keeps full resolution for its dimension callouts.
    setPreparing(true);
    const picked = angle === "CAD / design" ? chosen : await Promise.all(chosen.map(prepareQueryImage));
    setPreparing(false);
    const tooBig = picked.find((f) => f.size > MAX_BYTES);
    if (tooBig) {
      toast.error(`${tooBig.name} is over 12 MB — shrink it and try again.`);
      return;
    }
    add.mutate(
      {
        id: productId,
        files: picked,
        angles: angle === NO_ANGLE ? undefined : picked.map(() => angle),
      },
      {
        onSuccess: () =>
          toast.success(`${picked.length} photo${picked.length === 1 ? "" : "s"} added`),
        onError: (err) =>
          toast.error(apiErrorMessage(err, "Upload failed — managers only, each photo ≤ 12 MB")),
      },
    );
  }

  const feedback = (ok: string, fail: string) => ({
    onSuccess: () => toast.success(ok),
    onError: (err: unknown) => toast.error(apiErrorMessage(err, fail)),
  });

  return (
    <section className="space-y-2" aria-label="Photos">
      {selected ? (
        <div className="relative">
          <button
            type="button"
            onClick={() => onOpenFull(index)}
            aria-label={`Show ${productName} full screen`}
            className="flex aspect-[4/3] w-full cursor-zoom-in items-center justify-center overflow-hidden rounded-lg bg-white ring-1 ring-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:aspect-[16/9]"
          >
            {/* Full resolution for the selected picture only: a CAD sheet's
                dimension callouts are unreadable in a thumbnail. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              key={selected.id}
              src={assetUrl(selected.url)}
              alt={`${productName}${imageCaption(selected) ? ` — ${imageCaption(selected)}` : ""}`}
              data-testid="gallery-selected"
              data-image-id={selected.id}
              className="h-full w-full object-contain"
            />
          </button>
          <div className="pointer-events-none absolute left-2 top-2 flex flex-wrap gap-1">
            <ImageBadges img={selected} matched={selected.id === matchedImageId} />
          </div>
          <span className="pointer-events-none absolute bottom-2 right-2 flex items-center gap-1 rounded-md bg-black/60 px-2 py-1 text-xs text-white">
            <Expand className="h-3.5 w-3.5" /> Full screen
          </span>
          {imageCaption(selected) ? (
            <span className="pointer-events-none absolute bottom-2 left-2 max-w-[60%] truncate rounded-md bg-black/60 px-2 py-1 text-xs text-white">
              {imageCaption(selected)}
            </span>
          ) : null}
        </div>
      ) : (
        <div className="flex aspect-[16/9] w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-muted/30 text-center">
          <Gem className="h-8 w-8 text-muted-foreground/40" />
          <p className="px-6 text-xs text-muted-foreground">
            {canEdit
              ? "No photos yet. Shoot the front, the side and one on the hand — each is indexed separately."
              : "No photos on this design yet."}
          </p>
        </div>
      )}

      {images.length > 1 ? (
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
          {images.map((img, i) => (
            <button
              key={img.id}
              type="button"
              aria-label={`Photo ${i + 1}: ${[imageSourceLabel(img.source), imageCaption(img), img.isPrimary ? "primary" : ""]
                .filter(Boolean)
                .join(", ")}`}
              aria-current={img.id === selected?.id ? "true" : undefined}
              data-testid="gallery-thumb"
              data-image-id={img.id}
              data-primary={img.isPrimary ? "true" : undefined}
              data-source={img.source}
              onClick={() => onSelect(img.id)}
              className={cn(
                "relative h-16 w-16 shrink-0 overflow-hidden rounded-md border bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                img.id === selected?.id && "ring-2 ring-[var(--gold)]",
              )}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={assetUrl(img.thumbUrl || img.url)}
                alt=""
                loading="lazy"
                className="h-full w-full object-contain"
              />
              {img.source ? (
                <span className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-0.5 text-center text-[9px] font-medium text-white">
                  {imageSourceLabel(img.source)}
                </span>
              ) : null}
              {img.isPrimary ? (
                <Star className="absolute right-0.5 top-0.5 h-3 w-3 fill-[var(--gold)] text-[var(--gold)]" />
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      {selected && !selected.isPrimary && primary ? (
        <p className="text-xs text-muted-foreground" data-testid="primary-note">
          <Star className="mr-1 inline h-3 w-3 fill-[var(--gold)] text-[var(--gold)]" />
          Primary photo: {imageSourceLabel(primary.source) ?? "photo"}
          {primary.pinned ? " (pinned by head office)" : ""} — shown first in the catalogue.
        </p>
      ) : null}

      {selected && (canPin || canEdit) ? (
        <div className="flex flex-wrap items-center gap-2">
          {canPin ? (
            selected.pinned ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  unpin.mutate(
                    { id: productId, imageId: selected.id },
                    feedback("Pin removed — the default order applies", "Could not remove the pin."),
                  )
                }
              >
                <PinOff className="h-3.5 w-3.5" /> Unpin primary
              </Button>
            ) : selected.isPrimary ? null : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  pin.mutate(
                    { id: productId, imageId: selected.id },
                    feedback("Pinned as primary", "Could not pin this photo."),
                  )
                }
              >
                <Pin className="h-3.5 w-3.5" /> Pin as primary
              </Button>
            )
          ) : null}
          {/* Synced pictures come back with the next sync; only a hand-added
              one can really be removed. */}
          {canEdit && (!selected.source || selected.source === "manual") ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                remove.mutate(
                  { id: productId, imageId: selected.id },
                  feedback("Photo removed", "Could not remove the photo."),
                )
              }
            >
              <Trash2 className="h-3.5 w-3.5" /> Remove photo
            </Button>
          ) : null}
        </div>
      ) : null}

      {canEdit && missing.length ? (
        <p className="text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground">Still worth shooting:</span> {missing.join(" · ")} — a design
          found from only one view is a design a customer’s photo has to be lucky to match.
        </p>
      ) : null}

      {canEdit ? (
        <div className="flex flex-wrap items-center gap-2 border-t pt-2">
          <Select value={angle} onValueChange={setAngle}>
            <SelectTrigger aria-label="Label new photos as" className="h-9 w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_ANGLE}>No label</SelectItem>
              {ANGLES.map((a) => (
                <SelectItem key={a} value={a}>
                  {a}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onPick} />
          <input ref={libraryRef} type="file" accept="image/*" multiple className="hidden" onChange={onPick} />
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => cameraRef.current?.click()}>
            {add.isPending || preparing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Camera className="h-3.5 w-3.5" />}
            Take photo
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => libraryRef.current?.click()}>
            <ImagePlus className="h-3.5 w-3.5" />
            Add photos
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function ImageBadges({ img, matched }: { img: ProductImage; matched: boolean }) {
  return (
    <>
      {img.isPrimary ? (
        <Badge variant="gold" className="bg-background/90" data-testid="badge-primary">
          <Star className="mr-1 h-3 w-3 fill-current" /> Primary
        </Badge>
      ) : null}
      {img.source ? (
        <Badge variant="outline" className="bg-background/90" data-testid="badge-source">
          {imageSourceLabel(img.source)}
        </Badge>
      ) : null}
      {img.pinned ? (
        <Badge variant="outline" className="bg-background/90">
          Pinned
        </Badge>
      ) : null}
      {matched ? (
        <Badge variant="success" className="bg-background/90" data-testid="badge-matched">
          Matched photo
        </Badge>
      ) : null}
    </>
  );
}
