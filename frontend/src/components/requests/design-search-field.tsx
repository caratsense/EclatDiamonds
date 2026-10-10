"use client";

import * as React from "react";
import { Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useProducts } from "@/lib/queries/products";
import type { Product } from "@/lib/mock/catalogue";

/**
 * Pick ONE design (Product) by style number, SKU or name.
 *
 * Reuses GET /products — the same unified catalogue search the grid runs on
 * (`q` matches style number, SKU, name, Gati id and website code) — so a
 * reorder is raised against a real design, never free text. The catalogue is
 * org-wide on purpose: a design whose only piece sits unsold at ANOTHER branch
 * is exactly the one a well-selling store wants more of.
 */
export function DesignSearchField({
  value,
  onChange,
  inputId,
}: {
  value: Product | null;
  onChange: (product: Product | null) => void;
  inputId?: string;
}) {
  const [q, setQ] = React.useState("");
  const { data, isLoading, isError } = useProducts({
    page: 1,
    pageSize: 8,
    q: q.trim() || undefined,
  });
  const designs = data?.items ?? [];

  if (value) {
    return (
      <div className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{value.name}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {value.sku}
            {value.styleNumber ? ` · Style ${value.styleNumber}` : ""}
          </span>
        </span>
        <Button variant="ghost" size="sm" onClick={() => onChange(null)}>
          <X className="h-4 w-4" />
          Change
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-1.5">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          id={inputId}
          placeholder="Search style number, SKU or name…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="pl-8"
        />
      </div>
      <div className="max-h-56 overflow-y-auto rounded-lg border">
        {isLoading ? (
          <div className="space-y-2 p-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : isError ? (
          <p className="p-4 text-center text-sm text-muted-foreground">
            Couldn&apos;t search the catalogue.
          </p>
        ) : designs.length === 0 ? (
          <p className="p-4 text-center text-sm text-muted-foreground">
            No designs match that search.
          </p>
        ) : (
          <ul className="divide-y">
            {designs.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => onChange(p)}
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {p.name}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {p.sku}
                      {p.styleNumber ? ` · Style ${p.styleNumber}` : ""}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
