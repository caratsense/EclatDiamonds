"use client";

import { useRef, useState } from "react";
import { Camera, Gem, ImagePlus, Loader2, Star, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { assetUrl } from "@/lib/api";
import {
  useAddProductImages,
  useDeleteProductImage,
  useProductImages,
  useSetPrimaryProductImage,
} from "@/lib/queries/products";
import { apiErrorMessage, cn } from "@/lib/utils";

/** Per-photo ceiling, matching the API's own limit on this route. */
const MAX_BYTES = 12 * 1024 * 1024;

/**
 * The views worth labelling, in the order a piece is usually shot.
 *
 * Offered rather than required: an unlabelled photo is still worth having and
 * still gets indexed — the label helps a person reading the gallery, and drives
 * the checklist below.
 */
const ANGLES = [
  "Front",
  "Side",
  "Back",
  "On model",
  "Detail",
  "CAD / design",
] as const;

/**
 * The three views that actually decide whether a design can be found.
 *
 * Both sides of a visual match are photographs taken from somewhere. A design
 * held only as a flat-on shot cannot be matched well by a customer holding the
 * piece at an angle, however good either photo is — so the front earns the
 * first shot, the angled view the second, and the profile the third for pieces
 * whose shape reads differently in depth.
 *
 * "CAD / design" is deliberately NOT here. A Gati sheet is searchable — the
 * index cuts each render out of it and matches them one by one — but they are
 * renders, lit and coloured like no real piece is. A photograph of the piece
 * itself is still the better thing to match a customer's photograph against.
 */
const SEARCH_ANGLES = ["Front", "Side", "On model"] as const;

/** "Not specified" as a Select value — Radix reserves the empty string. */
const NO_ANGLE = "__none__";

/**
 * Every photograph of a design, and the two ways new ones arrive on a shop iPad:
 * the camera, and the photo library.
 *
 * Multiple angles are the point. A catalogue holding one picture per design can
 * only be searched from the single view somebody happened to upload — which is
 * why a phone photo of a pendant on a velvet stand does not find the CAD render
 * of that same pendant sitting in the catalogue. Every photo here is indexed
 * separately, and a visual search matches a design on its closest view.
 */
export function ProductGallery({
  productId,
  productName,
  canEdit,
  onOpen,
}: {
  productId: string;
  productName: string;
  canEdit: boolean;
  /** Show photo `index` (in gallery order) full screen. */
  onOpen?: (index: number) => void;
}) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);
  const [angle, setAngle] = useState<string>(NO_ANGLE);

  const { data: images, isLoading } = useProductImages(productId);
  const add = useAddProductImages();
  const setPrimary = useSetPrimaryProductImage();
  const remove = useDeleteProductImage();
  const busy = add.isPending || setPrimary.isPending || remove.isPending;

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    // Clear immediately: without this, re-picking the same file fires no change
    // event and the second attempt looks like a dead button.
    e.target.value = "";
    if (!picked.length) return;

    const tooBig = picked.find((f) => f.size > MAX_BYTES);
    if (tooBig) {
      toast.error(`${tooBig.name} is over 12 MB — shrink it and try again.`);
      return;
    }

    add.mutate(
      {
        id: productId,
        files: picked,
        // One label per file, positionally. Everything in a batch shares the
        // chosen angle: they were taken together, in one pose, on purpose.
        angles:
          angle === NO_ANGLE ? undefined : picked.map(() => angle),
      },
      {
        onSuccess: (rows) =>
          toast.success(
            `${picked.length} photo${picked.length === 1 ? "" : "s"} added · ${rows.length} on this design`,
          ),
        onError: (err) =>
          toast.error(
            apiErrorMessage(err, "Upload failed — managers only, each photo ≤ 12 MB"),
          ),
      },
    );
  }

  const rows = images ?? [];
  const have = new Set(rows.map((i) => i.angle).filter(Boolean) as string[]);
  const missing = SEARCH_ANGLES.filter((a) => !have.has(a));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Photos</p>
          <p className="text-xs text-muted-foreground">
            {rows.length === 0
              ? "No photos yet"
              : `${rows.length} angle${rows.length === 1 ? "" : "s"} — all of them searchable`}
          </p>
        </div>

        {canEdit ? (
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1">
              <Label htmlFor="pg-angle" className="text-[11px]">
                Label these as
              </Label>
              <Select value={angle} onValueChange={setAngle}>
                <SelectTrigger id="pg-angle" className="h-9 w-[150px]">
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
            </div>

            {/*
              `capture` is the whole camera feature: on an iPad it opens the rear
              camera straight away instead of the photo picker. No getUserMedia,
              no canvas, no permission dance — and on a desktop browser that
              ignores the hint it degrades to an ordinary file chooser.
            */}
            <input
              ref={cameraRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={onPick}
            />
            <input
              ref={libraryRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={onPick}
            />

            <Button
              type="button"
              size="sm"
              variant="gold"
              disabled={busy}
              onClick={() => cameraRef.current?.click()}
            >
              {add.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Camera className="h-3.5 w-3.5" />
              )}
              Take photo
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => libraryRef.current?.click()}
            >
              <ImagePlus className="h-3.5 w-3.5" />
              Add photos
            </Button>
          </div>
        ) : null}
      </div>

      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading photos…</p>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-center">
          <Gem className="h-6 w-6 text-muted-foreground/40" />
          <p className="text-xs text-muted-foreground">
            {canEdit
              ? "Shoot the front, the side and one on the hand — each angle is indexed separately, so the design can be found from any of them."
              : "No photos on this design yet."}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {rows.map((img, index) => (
            <figure
              key={img.id}
              className={cn(
                "group relative overflow-hidden rounded-md border bg-muted",
                img.isPrimary && "ring-2 ring-[var(--gold)]",
              )}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={assetUrl(img.url)}
                alt={`${productName}${img.angle ? ` — ${img.angle}` : ""}`}
                className={cn(
                  "aspect-square w-full bg-white object-contain",
                  onOpen && "cursor-zoom-in",
                )}
                onClick={() => onOpen?.(index)}
              />

              {img.angle || img.isPrimary ? (
                <figcaption className="absolute inset-x-0 top-0 flex items-center justify-between gap-1 bg-gradient-to-b from-black/60 to-transparent px-1.5 py-1">
                  <span className="truncate text-[10px] font-medium text-white">
                    {img.angle ?? ""}
                  </span>
                  {img.isPrimary ? (
                    <Star className="h-3 w-3 shrink-0 fill-[var(--gold)] text-[var(--gold)]" />
                  ) : null}
                </figcaption>
              ) : null}

              {canEdit ? (
                <div className="absolute inset-x-0 bottom-0 flex justify-end gap-1 bg-gradient-to-t from-black/70 to-transparent p-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                  {img.isPrimary ? null : (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      className="h-6 px-1.5"
                      title="Make this the cover"
                      disabled={busy}
                      onClick={() =>
                        setPrimary.mutate(
                          { id: productId, imageId: img.id },
                          {
                            onSuccess: () => toast.success("Cover updated"),
                            onError: (err) =>
                              toast.error(apiErrorMessage(err, "Could not set the cover.")),
                          },
                        )
                      }
                    >
                      <Star className="h-3 w-3" />
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="h-6 px-1.5"
                    title="Remove this photo"
                    disabled={busy}
                    onClick={() =>
                      remove.mutate(
                        { id: productId, imageId: img.id },
                        {
                          onSuccess: () => toast.success("Photo removed"),
                          onError: (err) =>
                            toast.error(apiErrorMessage(err, "Could not remove the photo.")),
                        },
                      )
                    }
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ) : null}
            </figure>
          ))}
        </div>
      )}

      {canEdit && rows.length > 0 ? (
        <div className="space-y-1.5">
          {missing.length ? (
            <p className="text-[11px] text-muted-foreground">
              <span className="font-medium text-foreground">
                Still worth shooting:
              </span>{" "}
              {missing.join(" · ")} — a design found from only one view is a
              design a customer’s photo has to be lucky to match.
            </p>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              <span className="font-medium text-foreground">
                Well covered.
              </span>{" "}
              Front, side and on-model are all here, so this design can be found
              from whichever way a customer holds their camera.
            </p>
          )}
          <p className="text-[11px] text-muted-foreground">
            Indexing starts on its own when photos change — a new angle usually
            becomes searchable within a minute or two, and the upload itself
            never waits for it.
          </p>
        </div>
      ) : null}
    </div>
  );
}
