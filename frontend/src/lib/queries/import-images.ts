"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

/**
 * A folder of product photographs, and a column mapping that does not have to be
 * worked out again every month.
 *
 * Both halves preview before they write. The preview is not a courtesy: an
 * archive of 1,500 files against a catalogue of 40,000 products will always have
 * some that match nothing, and the only useful moment to see which is before
 * anything is uploaded.
 */

export type MatchBy = "sku" | "legacyId" | "name";

export const MATCH_BY_OPTIONS: { value: MatchBy; label: string; hint: string }[] = [
  { value: "sku", label: "SKU / design code", hint: "RING-101.jpg matches the product with SKU RING-101" },
  { value: "legacyId", label: "Source system id", hint: "The id the supplier’s own system uses" },
  { value: "name", label: "Product name", hint: "Only when the catalogue has no codes" },
];

export interface ImageZipEntryResult {
  filename: string;
  key: string;
  status:
    | "matched"
    | "uploaded"
    | "unmatched"
    | "ambiguous"
    | "skipped_has_image"
    | "not_an_image"
    | "too_large"
    | "failed";
  productId?: string;
  productSku?: string;
  detail?: string;
}

export interface ImageZipOutcome {
  entries: number;
  matched: number;
  uploaded: number;
  unmatched: number;
  ambiguous: number;
  skipped: number;
  ignored: number;
  failed: number;
  results: ImageZipEntryResult[];
  batchId?: string;
}

export interface ImageZipOptions {
  matchBy: MatchBy;
  stripPrefix?: string;
  stripSuffix?: string;
  stripNumericSuffix?: boolean;
  storeId?: string;
  overwriteExisting?: boolean;
}

function toForm(file: File, opts: ImageZipOptions): FormData {
  const form = new FormData();
  form.append("file", file);
  form.append("matchBy", opts.matchBy);
  if (opts.stripPrefix) form.append("stripPrefix", opts.stripPrefix);
  if (opts.stripSuffix) form.append("stripSuffix", opts.stripSuffix);
  if (opts.storeId) form.append("storeId", opts.storeId);
  // Sent as literal "true"/"false": the server compares rather than coerces, so
  // an unchecked box must arrive as something that is not merely falsy-in-JS.
  form.append("stripNumericSuffix", String(Boolean(opts.stripNumericSuffix)));
  form.append("overwriteExisting", String(Boolean(opts.overwriteExisting)));
  return form;
}

/** Dry run. Nothing reaches storage or the catalogue. */
export function usePreviewImageZip() {
  return useMutation({
    mutationFn: async ({ file, ...opts }: ImageZipOptions & { file: File }) => {
      const { data } = await api.post<ImageZipOutcome>(
        "/import-images/preview",
        toForm(file, opts),
        // Long: decompressing and matching a few thousand files is not a 15s job.
        { timeout: 180_000 },
      );
      return data;
    },
  });
}

export function useRunImageZip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ file, ...opts }: ImageZipOptions & { file: File }) => {
      const { data } = await api.post<ImageZipOutcome>(
        "/import-images/run",
        toForm(file, opts),
        { timeout: 300_000 },
      );
      return data;
    },
    onSuccess: () => {
      // The catalogue now has photographs it did not have a moment ago.
      void qc.invalidateQueries({ queryKey: ["products"] });
    },
  });
}

/* ------------------------------------------------------------------------- */

export interface FieldMapping {
  sourceColumn: string;
  canonicalField: string;
}

export interface MappingProfile {
  id: string;
  name: string;
  entity: string;
  mappings: FieldMapping[];
  /** The header row it was built from — what makes a rename detectable. */
  sourceHeaders: string[];
  lastUsedAt: string | null;
  useCount: number;
  createdAt: string;
}

export interface ProfileFit {
  profile: MappingProfile;
  applicable: FieldMapping[];
  missingColumns: string[];
  unknownColumns: string[];
  exact: boolean;
  warning: string | null;
}

const PROFILE_KEY = ["import-mappings"] as const;

export function useMappingProfiles(entity?: string) {
  return useQuery({
    queryKey: [...PROFILE_KEY, entity ?? "all"],
    queryFn: async () => {
      const { data } = await api.get<MappingProfile[]>("/import-mappings", {
        params: entity ? { entity } : undefined,
      });
      return data;
    },
    staleTime: 5 * 60_000,
  });
}

export function useSaveMappingProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      name: string;
      entity: string;
      mappings: FieldMapping[];
      sourceHeaders?: string[];
    }) => {
      const { data } = await api.post<MappingProfile>("/import-mappings", input);
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: PROFILE_KEY });
    },
  });
}

/**
 * Fit a saved mapping to the file in hand.
 *
 * Takes the headers discovery already read, not the file: re-uploading a large
 * workbook to ask "does my saved mapping still fit" would be the slowest
 * possible way to ask.
 */
export function useApplyMappingProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, headers }: { id: string; headers: string[] }) => {
      const { data } = await api.post<ProfileFit>(`/import-mappings/${id}/apply`, { headers });
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: PROFILE_KEY });
    },
  });
}

export function useDeleteMappingProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.delete<{ deleted: boolean }>(`/import-mappings/${id}`);
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: PROFILE_KEY });
    },
  });
}

/** What a per-file outcome means, said so a person can act on it. */
export const ENTRY_STATUS: Record<
  ImageZipEntryResult["status"],
  { label: string; tone: "good" | "bad" | "wait" | "mute" }
> = {
  uploaded: { label: "Uploaded", tone: "good" },
  matched: { label: "Will upload", tone: "good" },
  unmatched: { label: "No product", tone: "bad" },
  ambiguous: { label: "More than one match", tone: "bad" },
  skipped_has_image: { label: "Already has a photo", tone: "wait" },
  not_an_image: { label: "Not an image", tone: "mute" },
  too_large: { label: "Too large", tone: "bad" },
  failed: { label: "Failed", tone: "bad" },
};
