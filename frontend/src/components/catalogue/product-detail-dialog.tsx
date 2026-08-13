"use client";

import { useRef } from "react";
import { Gem, Tag, Upload } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  formatCarats,
  formatGrams,
  formatINR,
  formatPurity,
} from "@/lib/format";
import { assetUrl } from "@/lib/api";
import {
  CATEGORY_LABELS,
  METAL_LABELS,
  type Product,
} from "@/lib/mock/catalogue";
import { useProductPieces, useUploadProductImage } from "@/lib/queries/products";
import { ROLE_RANK } from "@/lib/types";
import { useSession } from "@/store/use-session";
import { apiErrorMessage } from "@/lib/utils";

interface ProductDetailDialogProps {
  product: Product | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ProductDetailDialog({
  product,
  open,
  onOpenChange,
}: ProductDetailDialogProps) {
  const { stores, role } = useSession();
  const fileRef = useRef<HTMLInputElement>(null);
  const upload = useUploadProductImage();
  // Real physical pieces (actual tag price + tracking); only while the dialog is open.
  const piecesQuery = useProductPieces(open && product ? product.id : null);
  if (!product) return null;

  const pieces = piecesQuery.data ?? [];
  const tagPrices = pieces.map((p) => p.tagPrice || p.mrp).filter((v) => v > 0);
  const minTag = tagPrices.length ? Math.min(...tagPrices) : 0;
  const maxTag = tagPrices.length ? Math.max(...tagPrices) : 0;

  // Real gross weight: the design master's own weight, or — when the import left
  // it at 0 — a piece actually on hand carries the true weight.
  const pieceWeights = pieces.map((p) => p.grossWeight).filter((v) => v > 0);
  const grossWeight = product.weightGrams > 0 ? product.weightGrams : pieceWeights[0] ?? 0;

  const inStock = product.availability === "in_stock";
  // The lead time is only meaningful when a positive number of days was recorded.
  const leadDays = product.leadTimeDays && product.leadTimeDays > 0 ? product.leadTimeDays : 0;
  // Where it is actually held: the branches holding pieces, else the design's own store.
  const pieceStores = [...new Set(pieces.map((p) => p.storeName).filter(Boolean))];
  const store = stores.find((s) => s.id === product.storeId)?.name ?? product.storeId;
  const heldAt = pieceStores.length ? pieceStores.join(", ") : store || "—";
  const src = assetUrl(product.imageUrl);
  const canEdit = ROLE_RANK[role] >= ROLE_RANK.store_manager;

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !product) return;
    upload.mutate(
      { id: product.id, file },
      {
        onSuccess: () => toast.success("Photo uploaded"),
        onError: (err) => toast.error(apiErrorMessage(err, "Upload failed — managers only, image ≤ 8MB")),
      },
    );
    e.target.value = "";
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{product.name}</DialogTitle>
          <DialogDescription>
            {product.sku} · {CATEGORY_LABELS[product.category]}
          </DialogDescription>
        </DialogHeader>

        <div className="group relative flex aspect-[16/9] items-center justify-center overflow-hidden rounded-lg bg-muted">
          {src ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={src} alt={product.name} className="h-full w-full object-cover" />
          ) : (
            <Gem className="h-12 w-12 text-muted-foreground/40" />
          )}
          {canEdit ? (
            <>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={onPick}
              />
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={upload.isPending}
                onClick={() => fileRef.current?.click()}
                className="absolute bottom-2 right-2 shadow-sm"
              >
                <Upload className="h-3.5 w-3.5" />
                {upload.isPending ? "Uploading…" : src ? "Replace" : "Upload photo"}
              </Button>
            </>
          ) : null}
        </div>

        <div className="flex items-center justify-between">
          {/* Actual tagged price of the pieces on hand — falls back to the
              design's indicative price only when nothing is in stock. */}
          <div>
            {tagPrices.length ? (
              <>
                <span className="num text-lg font-semibold">
                  {minTag === maxTag
                    ? formatINR(minTag)
                    : `${formatINR(minTag)} – ${formatINR(maxTag)}`}
                </span>
                <span className="ml-2 text-xs text-muted-foreground">
                  tag price · {pieces.length} on hand
                </span>
              </>
            ) : (
              <>
                <span className="num text-lg font-semibold">
                  {formatINR(product.price)}
                </span>
                <span className="ml-2 text-xs text-muted-foreground">
                  indicative
                </span>
              </>
            )}
          </div>
          <Badge variant={inStock ? "success" : "secondary"}>
            {inStock ? (
              "In-Stock"
            ) : leadDays > 0 ? (
              <>
                Lead-Time · <span className="num">{leadDays} days</span>
              </>
            ) : (
              "Made to order"
            )}
          </Badge>
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <Spec label="Metal">{METAL_LABELS[product.metal]}</Spec>
          {product.karat > 0 ? (
            <Spec label="Purity">
              <span className="num">{formatPurity(product.karat)}</span>
            </Spec>
          ) : null}
          <Spec label="Gross weight">
            {grossWeight > 0 ? (
              <span className="num">{formatGrams(grossWeight)}</span>
            ) : (
              "—"
            )}
          </Spec>
          {product.caratWeight > 0 ? (
            <Spec label="Stones">
              <span className="num">{formatCarats(product.caratWeight)}</span>
            </Spec>
          ) : null}
          <Spec label="Held at">{heldAt}</Spec>
        </dl>

        {/* Physical pieces — the real per-piece tag price + tracking (tag / batch
            no, hallmark, certificate) the single design price cannot show. */}
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Tag className="h-4 w-4 text-muted-foreground" />
            <h4 className="text-sm font-semibold">Pieces on hand</h4>
            {!piecesQuery.isLoading ? (
              <Badge variant="secondary">{pieces.length}</Badge>
            ) : null}
          </div>
          {piecesQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading pieces…</p>
          ) : pieces.length === 0 ? (
            <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
              No pieces in stock in your scope — this design is made to order.
            </p>
          ) : (
            <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
              {pieces.map((pc) => (
                <div key={pc.id} className="rounded-lg border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs font-medium">
                      Tag {pc.tagNo || "—"}
                    </span>
                    <span className="num text-sm font-semibold">
                      {pc.tagPrice > 0
                        ? formatINR(pc.tagPrice)
                        : pc.mrp > 0
                          ? formatINR(pc.mrp)
                          : "—"}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                    <span>{pc.storeName}</span>
                    {pc.grossWeight > 0 ? (
                      <span className="num">{formatGrams(pc.grossWeight)}</span>
                    ) : null}
                    {pc.diamondWeightCt > 0 ? (
                      <span className="num">
                        {formatCarats(pc.diamondWeightCt)}
                        {pc.diamondPieces > 0 ? ` · ${pc.diamondPieces} st` : ""}
                      </span>
                    ) : null}
                    {pc.hallmarkNo ? <span>Hallmark {pc.hallmarkNo}</span> : null}
                    {pc.certificateNo ? <span>Cert {pc.certificateNo}</span> : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {product.description ? (
          <p className="text-sm text-muted-foreground">{product.description}</p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function Spec({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}
