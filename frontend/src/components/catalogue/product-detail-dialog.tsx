"use client";

import { useRef } from "react";
import { Gem, Upload } from "lucide-react";
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
import { useUploadProductImage } from "@/lib/queries/products";
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
  if (!product) return null;

  const inStock = product.availability === "in_stock";
  const store = stores.find((s) => s.id === product.storeId)?.name ?? product.storeId;
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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
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
          <span className="num text-lg font-semibold">
            {formatINR(product.price)}
          </span>
          <Badge variant={inStock ? "success" : "secondary"}>
            {inStock ? (
              "In-Stock"
            ) : (
              <>
                Lead-Time ·{" "}
                <span className="num">{product.leadTimeDays} days</span>
              </>
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
            <span className="num">{formatGrams(product.weightGrams)}</span>
          </Spec>
          {product.caratWeight > 0 ? (
            <Spec label="Stones">
              <span className="num">{formatCarats(product.caratWeight)}</span>
            </Spec>
          ) : null}
          <Spec label="Held at">{store}</Spec>
        </dl>

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
