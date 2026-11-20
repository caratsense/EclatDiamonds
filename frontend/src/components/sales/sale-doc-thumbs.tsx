"use client";

import { useRef } from "react";
import { FileText, ImagePlus, Upload } from "lucide-react";

import { assetUrl } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  SALE_DOC_META,
  saleDocUrl,
  type Sale,
  type SaleDocType,
} from "@/lib/mock/sales";

/**
 * The three counter photos (quotation / invoice / payment receipt) on a sale.
 *
 * - `variant="row"` (default) — compact inline thumbnails/links for the table.
 * - `variant="grid"` — labelled tiles for the detail dialog; when `onUpload`
 *   is supplied, empty tiles become touch-friendly upload dropzones so a
 *   missing photo can be added after the sale was created.
 */
interface SaleDocThumbsProps {
  sale: Pick<
    Sale,
    "id" | "quotationUrl" | "invoiceUrl" | "receiptUrl"
  >;
  variant?: "row" | "grid";
  /** When provided (grid variant), empty slots let the user upload a photo. */
  onUpload?: (doc: SaleDocType, file: File) => void;
  /** The doc currently uploading (disables its tile + shows a spinner state). */
  uploadingDoc?: SaleDocType | null;
}

export function SaleDocThumbs({
  sale,
  variant = "row",
  onUpload,
  uploadingDoc,
}: SaleDocThumbsProps) {
  if (variant === "row") {
    return (
      <div className="flex items-center gap-1.5">
        {SALE_DOC_META.map(({ type, label }) => {
          const src = assetUrl(saleDocUrl(sale as Sale, type) ?? undefined);
          const initial = label[0];
          return src ? (
            <a
              key={type}
              href={src}
              target="_blank"
              rel="noreferrer"
              title={`View ${label.toLowerCase()}`}
              onClick={(e) => e.stopPropagation()}
              className="relative block h-8 w-8 overflow-hidden rounded-md border transition-transform hover:scale-105"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={src}
                alt={label}
                className="h-full w-full object-cover"
              />
            </a>
          ) : (
            <span
              key={type}
              title={`${label} not uploaded`}
              className="flex h-8 w-8 items-center justify-center rounded-md border border-dashed border-muted-foreground/30 text-[11px] font-medium text-muted-foreground/50"
            >
              {initial}
            </span>
          );
        })}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-3 gap-3">
      {SALE_DOC_META.map(({ type, label, hint }) => (
        <DocTile
          key={type}
          doc={type}
          label={label}
          hint={hint}
          src={assetUrl(saleDocUrl(sale as Sale, type) ?? undefined)}
          onUpload={onUpload}
          uploading={uploadingDoc === type}
        />
      ))}
    </div>
  );
}

function DocTile({
  doc,
  label,
  hint,
  src,
  onUpload,
  uploading,
}: {
  doc: SaleDocType;
  label: string;
  hint: string;
  src?: string;
  onUpload?: (doc: SaleDocType, file: File) => void;
  uploading?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="space-y-1.5">
      {src ? (
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          className="group relative flex aspect-square items-center justify-center overflow-hidden rounded-lg border bg-muted/30"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={label} className="h-full w-full object-cover" />
        </a>
      ) : onUpload ? (
        <>
          <button
            type="button"
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
            className={cn(
              "flex aspect-square w-full flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-muted-foreground/25 text-center transition-colors hover:border-primary/50 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60",
            )}
          >
            {uploading ? (
              <Upload className="h-4 w-4 animate-pulse text-primary" />
            ) : (
              <ImagePlus className="h-4 w-4 text-muted-foreground" />
            )}
            <span className="text-[11px] text-muted-foreground">
              {uploading ? "Uploading…" : "Add photo"}
            </span>
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onUpload(doc, f);
              e.target.value = "";
            }}
          />
        </>
      ) : (
        <div className="flex aspect-square flex-col items-center justify-center gap-1 rounded-lg border border-dashed bg-muted/20 text-muted-foreground/50">
          <FileText className="h-4 w-4" />
          <span className="text-[11px]">Not uploaded</span>
        </div>
      )}
      <p className="text-center text-[11px] font-medium text-muted-foreground" title={hint}>
        {label}
      </p>
    </div>
  );
}
