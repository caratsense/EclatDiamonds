"use client";

import { AlertTriangle, Gem, Hourglass, ImageOff } from "lucide-react";

import { assetUrl } from "@/lib/api";
import { formatINR } from "@/lib/format";
import {
  CATEGORY_LABELS,
  imageSourceLabel,
  productDisplayName,
  type PriceRange,
  type Product,
} from "@/lib/mock/catalogue";

interface ProductCardProps {
  product: Product;
  onOpen: (product: Product) => void;
}

function range(r?: PriceRange | null): string | null {
  if (!r || (r.min == null && r.max == null)) return null;
  if (r.min == null || r.max == null || r.min === r.max) return formatINR((r.min ?? r.max)!);
  return `${formatINR(r.min)} – ${formatINR(r.max)}`;
}

/**
 * One design in the catalogue grid: its customer-facing name, its code, the
 * hero picture (CAD first), both price ranges, what is on hand, and what is
 * missing (no photo, no CAD, open conflicts, not yet searchable).
 */
export function ProductCard({ product, onOpen }: ProductCardProps) {
  const src = assetUrl(product.heroThumbUrl || product.heroImageUrl || product.imageUrl);
  const name = productDisplayName(product);
  const code = product.styleNumber || product.sku;
  const online = range(product.onlinePrice);
  const tag = range(product.tagPrice);
  const flags = product.flags;
  const onHand = product.onHand ?? product.stock?.totalCount;

  return (
    <button
      type="button"
      onClick={() => onOpen(product)}
      data-testid="product-card"
      className="group flex flex-col overflow-hidden rounded-xl border bg-card text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="relative flex aspect-square w-full items-center justify-center overflow-hidden bg-white">
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt=""
            loading="lazy"
            decoding="async"
            className="h-full w-full object-contain transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <Gem className="h-10 w-10 text-muted-foreground/40" />
        )}
        {product.heroSource ? (
          <span className="absolute left-1.5 top-1.5 rounded-full bg-background/85 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {imageSourceLabel(product.heroSource)}
          </span>
        ) : null}
        {flags ? (
          <span className="absolute right-1.5 top-1.5 flex gap-1">
            {flags.noImage ? (
              <Flag label="No photo">
                <ImageOff className="h-3 w-3" />
              </Flag>
            ) : null}
            {flags.noCad && !flags.noImage ? <Flag label="No CAD">CAD</Flag> : null}
            {flags.conflicts ? (
              <Flag label={`${flags.conflicts} conflict${flags.conflicts === 1 ? "" : "s"} to check`} warn>
                <AlertTriangle className="h-3 w-3" />
              </Flag>
            ) : null}
            {flags.indexing && flags.indexing !== "full" && !flags.noImage ? (
              <Flag label={flags.indexing === "none" ? "Not searchable by photo yet" : "Some photos still indexing"}>
                <Hourglass className="h-3 w-3" />
              </Flag>
            ) : null}
          </span>
        ) : null}
      </div>

      <div className="flex flex-1 flex-col gap-0.5 p-3">
        <p className="line-clamp-2 text-sm font-medium" title={name}>
          {name}
        </p>
        {code && code !== name ? (
          <p className="truncate font-mono text-[11px] text-muted-foreground">{code}</p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {product.categoryLabel || CATEGORY_LABELS[product.category]}
        </p>
        <dl className="mt-1 space-y-0.5 text-xs">
          {online ? <Price label="Online" value={online} /> : null}
          {tag ? <Price label="Tag" value={tag} /> : null}
          {!online && !tag ? <Price label="Price" value={product.price > 0 ? formatINR(product.price) : "—"} /> : null}
        </dl>
        {onHand != null ? (
          <p className="mt-auto pt-1 text-[11px] text-muted-foreground">
            {onHand > 0 ? (
              <>
                <span className="num font-medium text-foreground">{onHand}</span> on hand
              </>
            ) : (
              "None on hand"
            )}
          </p>
        ) : null}
      </div>
    </button>
  );
}

function Price({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="num truncate font-semibold">{value}</dd>
    </div>
  );
}

function Flag({ label, warn, children }: { label: string; warn?: boolean; children: React.ReactNode }) {
  return (
    <span
      title={label}
      aria-label={label}
      role="img"
      className={`flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[9px] font-semibold ${
        warn ? "bg-warning text-white" : "bg-background/90 text-muted-foreground ring-1 ring-border"
      }`}
    >
      {children}
    </span>
  );
}
