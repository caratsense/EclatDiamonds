"use client";

import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

/** Sale rate per carat: by per-stone weight band [min, max, rate], or by size group. */
export interface SaleRates {
  bands?: [number, number, number][];
  groups?: Record<string, number>;
}

export interface MaterialOption {
  code: string;
  name: string;
  kind: string;
  groupCode: string | null;
  groupName: string | null;
  karat: number | null;
  tone: string | null;
  shape: string | null;
  quality: string | null;
  saleRates: SaleRates | null;
}

export interface MaterialSizeOption {
  code: string;
  mm: string | null;
  /** Weight of one stone of this size, in carats. */
  caratPerPiece: number | null;
  sizeGroup: string | null;
}

export interface MaterialMaster {
  itemTypes: { code: string; name: string }[];
  metals: MaterialOption[];
  diamonds: MaterialOption[];
  stones: MaterialOption[];
  sizes: MaterialSizeOption[];
}

export interface StyleBom {
  styleCode: string;
  itemType: string | null;
  itemSize: string | null;
  lines: { code: string; size?: string; pieces?: number; weight: number }[];
}

/** GET /materials — the item master behind the quote builder's dropdowns. */
export function useMaterials() {
  return useQuery({
    queryKey: ["materials"],
    queryFn: async () => (await api.get<MaterialMaster>("/materials")).data,
    staleTime: 30 * 60 * 1000,
  });
}

/** GET /materials/styles?q= — style numbers starting with what was typed. */
export function useStyleSearch(q: string) {
  const term = q.trim();
  return useQuery({
    queryKey: ["materials", "styles", term.toUpperCase()],
    queryFn: async () =>
      (await api.get<{ styleCode: string; itemType: string | null }[]>("/materials/styles", { params: { q: term } })).data,
    enabled: term.length >= 2,
    staleTime: 5 * 60 * 1000,
  });
}

/** GET /materials/styles/:code — a design's default materials. */
export async function fetchStyle(code: string): Promise<StyleBom> {
  return (await api.get<StyleBom>(`/materials/styles/${encodeURIComponent(code.trim())}`)).data;
}

/**
 * The chart's sale rate for a stone, to prefill the rate per carat: the band
 * its per-stone weight falls in, else its size group's rate. Null when the
 * chart has neither — the salesperson enters it.
 */
export function saleRateFor(
  material: MaterialOption | undefined,
  size: MaterialSizeOption | undefined,
  perStoneCarats: number | undefined,
): number | null {
  const rates = material?.saleRates;
  if (!rates) return null;
  if (perStoneCarats != null && perStoneCarats > 0 && rates.bands?.length) {
    const band = rates.bands.find(([min, max]) => perStoneCarats > min && perStoneCarats <= max);
    if (band) return band[2];
  }
  const byGroup = size?.sizeGroup ? rates.groups?.[size.sizeGroup] : undefined;
  return byGroup ?? null;
}
