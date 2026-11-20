"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { ProductCategory } from "@/lib/mock/catalogue";

/**
 * What the two letters in a design code mean.
 *
 * The connected system (Gati) files a design's group as a two-letter code
 * inside its design number — `10880RG` is a ring, `SDNK01033` a necklace. The
 * codes somebody worked out are built into the server; the rest live here,
 * because only head office has the group master they come from.
 */

export interface ProductGroupCode {
  code: string;
  category: ProductCategory;
  label: string | null;
}

/** One code with what still carries it, which is what makes the list answerable. */
export interface ProductGroupCodeUsage extends ProductGroupCode {
  category: ProductCategory;
  /** `unmapped` is a code nobody has explained — the question for head office. */
  source: "tenant" | "built_in" | "unmapped";
  products: number;
  pieces: number;
  productsUnclassified: number;
  piecesUnclassified: number;
  examples: string[];
}

export interface ProductGroups {
  codes: ProductGroupCode[];
  usage: ProductGroupCodeUsage[];
  categories: ProductCategory[];
}

const KEY = ["product-groups"] as const;

export function useProductGroups() {
  return useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const { data } = await api.get<ProductGroups>("/product-groups");
      return data;
    },
  });
}

/**
 * Save the whole list.
 *
 * The response says which codes are being re-read, because that is the part
 * that takes a moment and the part the person saving actually cares about: a
 * correction is worth nothing until the designs already in the catalogue move.
 */
export function useSaveProductGroups() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (codes: ProductGroupCode[]) => {
      const { data } = await api.post<{ codes: ProductGroupCode[]; reclassifying: string[] }>(
        "/product-groups",
        { codes },
      );
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      // The catalogue and the stock lists filter on the column this just
      // rewrote; leaving their caches alone shows the old filters until a
      // reload, which reads as "the save did nothing".
      void qc.invalidateQueries({ queryKey: ["products"] });
      void qc.invalidateQueries({ queryKey: ["stock"] });
    },
  });
}
