"use client";

import { Gem } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { assetUrl } from "@/lib/api";
import { formatGrams, formatINR, formatPurity } from "@/lib/format";
import {
  CATEGORY_LABELS,
  METAL_LABELS,
  type Product,
} from "@/lib/mock/catalogue";

interface ProductCardProps {
  product: Product;
  onOpen: (product: Product) => void;
  /** Optional similarity score badge for AI image-search results. */
  similarity?: number;
}

export function ProductCard({ product, onOpen, similarity }: ProductCardProps) {
  const src = assetUrl(product.imageUrl);

  return (
    <button
      type="button"
      onClick={() => onOpen(product)}
      className="group flex flex-col overflow-hidden rounded-xl border bg-card text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
    >
      {/* Image (falls back to a gem glyph when no photo yet) */}
      <div className="relative flex aspect-square items-center justify-center overflow-hidden bg-muted">
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={product.name}
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <Gem className="h-10 w-10 text-muted-foreground/40" />
        )}
        {similarity !== undefined ? (
          <div className="absolute right-2 top-2">
            <Badge variant="default">
              <span className="num">{Math.round(similarity * 100)}%</span> match
            </Badge>
          </div>
        ) : null}
      </div>

      <div className="flex flex-1 flex-col gap-1 p-3">
        <p className="truncate text-sm font-medium">{product.name}</p>
        <p className="text-xs text-muted-foreground">
          {CATEGORY_LABELS[product.category]} · {METAL_LABELS[product.metal]}
        </p>
        <p className="text-xs text-muted-foreground">
          {product.karat > 0 ? (
            <>
              <span className="num">{formatPurity(product.karat)}</span> ·{" "}
            </>
          ) : null}
          <span className="num">{formatGrams(product.weightGrams, 1)}</span>
        </p>
        <p className="num mt-1 text-sm font-semibold">
          {formatINR(product.price)}
        </p>
      </div>
    </button>
  );
}
