"use client";

import { useState } from "react";
import { Expand, Gem, Store, Tag } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { CustomAttributeList } from "@/components/common/custom-attributes";
import {
  useConfigBootstrap,
  useFieldVisible,
} from "@/lib/queries/tenant-config";
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
  SOURCE_LABELS,
  type Product,
} from "@/lib/mock/catalogue";
import { ImageLightbox } from "@/components/catalogue/image-lightbox";
import { ProductGallery } from "@/components/catalogue/product-gallery";
import { useProductImages, useProductPieces } from "@/lib/queries/products";
import { ROLE_RANK } from "@/lib/types";
import { useSession } from "@/store/use-session";

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
  /*
   * The same industry policy the create form obeys.
   *
   * Without it a pharmacy's paracetamol opened onto a spec list reading Metal:
   * 22K Gold, Purity: 22K, Gross weight — measurements nobody entered and that
   * describe nothing about the product.
   */
  const { data: config } = useConfigBootstrap();
  const fieldVisible = useFieldVisible(config);
  const showsMetal = fieldVisible("product", "metal");
  const showsKarat = fieldVisible("product", "purity");
  const showsWeight = fieldVisible("product", "grossWeight");
  // Real physical pieces (actual tag price + tracking); only while the dialog is open.
  const piecesQuery = useProductPieces(open && product ? product.id : null);
  // Same query (and cache) the gallery uses, so the full-screen viewer steps
  // through the photos in the order they are shown.
  const { data: gallery } = useProductImages(
    open && product ? product.id : null,
  );
  const [viewing, setViewing] = useState<number | null>(null);
  if (!product) return null;

  const pieces = piecesQuery.data ?? [];
  const tagPrices = pieces.map((p) => p.tagPrice || p.mrp).filter((v) => v > 0);
  const minTag = tagPrices.length ? Math.min(...tagPrices) : 0;
  const maxTag = tagPrices.length ? Math.max(...tagPrices) : 0;

  // Real gross weight: the design master's own weight, or — when the import left
  // it at 0 — a piece actually on hand carries the true weight.
  const pieceWeights = pieces.map((p) => p.grossWeight).filter((v) => v > 0);
  const grossWeight =
    product.weightGrams > 0 ? product.weightGrams : (pieceWeights[0] ?? 0);

  // Where it is actually held: the branches holding pieces, else the design's own store.
  const pieceStores = [
    ...new Set(pieces.map((p) => p.storeName).filter(Boolean)),
  ];
  const store =
    stores.find((s) => s.id === product.storeId)?.name ?? product.storeId;
  const heldAt = pieceStores.length ? pieceStores.join(", ") : store || "—";
  const src = assetUrl(product.imageUrl);
  const canEdit = ROLE_RANK[role] >= ROLE_RANK.store_manager;
  const photos = gallery?.length
    ? gallery.map((g) => ({ url: g.url, label: g.angle }))
    : product.imageUrl
      ? [{ url: product.imageUrl }]
      : [];
  const styleNo = product.styleNumber || product.sku;
  const stock = product.stock;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{product.name}</DialogTitle>
          <DialogDescription>
            Style {styleNo} · {CATEGORY_LABELS[product.category]}
            {product.source ? ` · ${SOURCE_LABELS[product.source]}` : ""}
          </DialogDescription>
        </DialogHeader>

        {/* The cover, whole: a Gati CAD sheet cropped to fill the frame loses
            the very dimensions it is shown for. Tap for full screen. Wrapped in a
            plain div: as a direct child of the dialog's grid, an aspect-ratio
            item got a zero-height row and the gallery was drawn over it. */}
        <div>
          <button
            type="button"
            disabled={!photos.length}
            onClick={() => setViewing(0)}
            className="group relative flex aspect-[16/9] w-full items-center justify-center overflow-hidden rounded-lg bg-white ring-1 ring-border enabled:cursor-zoom-in"
          >
            {src ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={src}
                alt={product.name}
                className="h-full w-full object-contain"
              />
            ) : (
              <Gem className="h-12 w-12 text-muted-foreground/40" />
            )}
            {src ? (
              <span className="absolute bottom-2 right-2 flex items-center gap-1 rounded-md bg-black/60 px-2 py-1 text-xs text-white">
                <Expand className="h-3.5 w-3.5" /> Full screen
              </span>
            ) : null}
          </button>
        </div>

        <ProductGallery
          productId={product.id}
          productName={product.name}
          canEdit={canEdit}
          onOpen={setViewing}
        />

        <ImageLightbox
          images={photos}
          index={viewing}
          onIndexChange={setViewing}
          onClose={() => setViewing(null)}
          title={product.name === styleNo ? styleNo : `${product.name} · ${styleNo}`}
        />

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
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          {showsMetal ? (
            <Spec label="Metal">{METAL_LABELS[product.metal]}</Spec>
          ) : product.materialLabel ? (
            /* The tenant's own word for what it is made of, when the jewellery
               metal enum has nothing true to say. */
            <Spec label="Material">{product.materialLabel}</Spec>
          ) : null}
          {!showsMetal && product.categoryLabel ? (
            <Spec label="Category">{product.categoryLabel}</Spec>
          ) : null}
          {!showsMetal && product.unitOfMeasure ? (
            <Spec label="Sold in">{product.unitOfMeasure}</Spec>
          ) : null}
          {showsKarat && product.karat > 0 ? (
            <Spec label="Purity">
              <span className="num">{formatPurity(product.karat)}</span>
            </Spec>
          ) : null}
          {showsWeight ? (
            <Spec label="Gross weight">
              {grossWeight > 0 ? (
                <span className="num">{formatGrams(grossWeight)}</span>
              ) : (
                "—"
              )}
            </Spec>
          ) : null}
          {showsWeight && product.caratWeight > 0 ? (
            <Spec label="Stones">
              <span className="num">{formatCarats(product.caratWeight)}</span>
            </Spec>
          ) : null}
          {stock ? null : <Spec label="Held at">{heldAt}</Spec>}
        </dl>

        {/* Where it can be had, with counts — "two in Surat, one in Mumbai"
            is what a salesperson says to a customer who wants it today. */}
        {stock ? (
          <div className="rounded-lg border p-3">
            <div className="mb-1.5 flex items-center gap-2">
              <Store className="h-4 w-4 text-muted-foreground" />
              <h4 className="text-sm font-semibold">Available at</h4>
            </div>
            {stock.where === "made" ? (
              <p className="text-sm text-muted-foreground">
                Not in stock at any store you can see — made to order.
              </p>
            ) : (
              <ul className="flex flex-wrap gap-2 text-sm">
                {stock.hereCount > 0 ? (
                  <li className="rounded-md bg-emerald-500/10 px-2 py-1 font-medium text-emerald-700 dark:text-emerald-400">
                    This store · {stock.hereCount}
                  </li>
                ) : null}
                {stock.elsewhere.map((e) => (
                  <li key={e.storeId} className="rounded-md bg-muted px-2 py-1">
                    {e.storeName} · <span className="num">{e.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}

        {/* Every number the design is known by, and where it came from. */}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg bg-muted/40 p-3 text-sm sm:grid-cols-3">
          <Spec label="Style no">
            <span className="font-mono">{styleNo}</span>
          </Spec>
          <Spec label="SKU">
            <span className="font-mono">{product.sku}</span>
          </Spec>
          {product.gatiId ? (
            <Spec label="Gati ID">
              <span className="font-mono">{product.gatiId}</span>
            </Spec>
          ) : null}
          {product.websiteCode ? (
            <Spec label="Website code">
              <span className="font-mono">{product.websiteCode}</span>
            </Spec>
          ) : null}
          <Spec label="Category">
            {product.categoryLabel || CATEGORY_LABELS[product.category]}
          </Spec>
          {product.source ? (
            <Spec label="Source">{SOURCE_LABELS[product.source]}</Spec>
          ) : null}
        </dl>

        {/* Whatever this business tracks beyond the built-in fields. Renders
            nothing for a tenant that has defined no custom attributes. */}
        <CustomAttributeList entity="product" values={product.attributes} />

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
                        {pc.diamondPieces > 0
                          ? ` · ${pc.diamondPieces} st`
                          : ""}
                      </span>
                    ) : null}
                    {pc.hallmarkNo ? (
                      <span>Hallmark {pc.hallmarkNo}</span>
                    ) : null}
                    {pc.certificateNo ? (
                      <span>Cert {pc.certificateNo}</span>
                    ) : null}
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
