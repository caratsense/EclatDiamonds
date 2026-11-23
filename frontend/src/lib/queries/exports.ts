"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

/**
 * Everything the Excel dialog and the Export formats screen need.
 *
 * Two unrelated-looking things in one file because they are the same feature
 * seen twice: the dialog asks WHICH ROWS (a date range) and the screen decides
 * WHICH COLUMNS, and both are what the client asked for on 21 November —
 * "a pop-up should open when you click on Excel to ask from which to which date"
 * and "each tenant should set their own column format".
 */

// ================================================================ the range

/** A chosen window. Both ends absent is "all time", and is a legitimate answer. */
export interface ExportRange {
  from?: string;
  to?: string;
}

/** The quick choices offered beside the two date boxes. */
export type RangePreset = "this-month" | "last-month" | "last-90" | "all" | "custom";

export const RANGE_PRESET_LABELS: Record<Exclude<RangePreset, "custom">, string> = {
  "this-month": "This month",
  "last-month": "Last month",
  "last-90": "Last 90 days",
  all: "All time",
};

/**
 * A date as `YYYY-MM-DD` in the viewer's OWN day, not in UTC.
 *
 * `toISOString().slice(0, 10)` is the obvious way to do this and it is wrong
 * east of Greenwich: at 02:00 in Asia/Kolkata it returns yesterday, so "This
 * month" on the 1st of the month would have asked for a range starting in the
 * previous one. The three local getters cannot drift like that.
 */
export function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * The range a quick choice means, resolved against a given "today".
 *
 * `today` is a parameter rather than `new Date()` inside so the rule is
 * testable at a month boundary without waiting for one.
 *
 * `all` returns `{}` — not a pair of very wide dates. The server reads an absent
 * bound as no filter at all, which is both cheaper and honest: a file labelled
 * "1970 to 2099" claims a precision nobody asked for.
 */
export function presetRange(preset: RangePreset, today = new Date()): ExportRange {
  switch (preset) {
    case "this-month":
      return {
        from: ymd(new Date(today.getFullYear(), today.getMonth(), 1)),
        to: ymd(today),
      };
    case "last-month": {
      const first = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      // Day 0 of this month is the last day of the previous one, which handles
      // February and the 31sts without a table of month lengths.
      const last = new Date(today.getFullYear(), today.getMonth(), 0);
      return { from: ymd(first), to: ymd(last) };
    }
    case "last-90": {
      const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 89);
      // 89, not 90: the range is inclusive at both ends, so today is one of the
      // ninety days. Subtracting 90 would quietly make it a 91-day window.
      return { from: ymd(from), to: ymd(today) };
    }
    case "all":
      return {};
    case "custom":
      return {};
  }
}

/** What the chosen range covers, in the words the dialog and the toast use. */
export function describeRange(range: ExportRange): string {
  if (range.from && range.to) return `${range.from} to ${range.to}`;
  if (range.from) return `${range.from} onwards`;
  if (range.to) return `up to ${range.to}`;
  return "All time";
}

/**
 * Why the Download button is refusing, or null when it is not.
 *
 * All time is always allowed — that is the whole point of the preset. A custom
 * range with one end filled in is allowed too, because "everything since
 * 1 November" is a real question. Only a backwards range is refused, and it is
 * refused BEFORE the request so the reason arrives beside the boxes rather than
 * as a failed download.
 */
export function rangeProblem(range: ExportRange): string | null {
  if (range.from && range.to && range.to < range.from) {
    return "The second date is before the first.";
  }
  return null;
}

/** The range as query parameters, dropping the ends that were not chosen. */
export function rangeParams(range: ExportRange): Record<string, string> {
  const params: Record<string, string> = {};
  if (range.from) params.from = range.from;
  if (range.to) params.to = range.to;
  return params;
}

// ============================================================= the formats

/** The two exports a tenant may re-shape. */
export type ExportFormatKind = "leads" | "nps";

export interface ExportColumnFormat {
  field: string;
  header: string;
}

/** One column the export can actually fill, as offered in the chooser. */
export interface ExportFieldSpec {
  field: string;
  label: string;
  note: string;
}

export interface ExportFormatState {
  kind: ExportFormatKind;
  columns: ExportColumnFormat[];
  /** True while this tenant is still on the format we ship. */
  isDefault: boolean;
  /** The catalogue, served by the server so it cannot offer an unfillable column. */
  fields: ExportFieldSpec[];
  defaultColumns: ExportColumnFormat[];
}

export interface ExportFormats {
  leads: ExportFormatState;
  nps: ExportFormatState;
}

export const exportFormatsKey = ["export-formats"] as const;

/**
 * Both formats and both catalogues.
 *
 * The catalogue is fetched rather than hard-coded here on purpose: it is derived
 * from what the builder can produce, and a copy in the frontend would drift the
 * first time somebody added a column to one side only. The symptom of that drift
 * is a heading in a downloaded file with nothing underneath it, discovered by
 * whoever the file was forwarded to.
 */
export function useExportFormats(enabled = true) {
  return useQuery({
    queryKey: exportFormatsKey,
    enabled,
    queryFn: async () => {
      const { data } = await api.get<ExportFormats>("/crm/exports/formats");
      return data;
    },
  });
}

/** Save one format, or pass no columns to go back to the standard one. */
export function useSaveExportFormat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { kind: ExportFormatKind; columns: ExportColumnFormat[] | null }) => {
      const { data } = await api.put<{ kind: ExportFormatKind; columns: ExportColumnFormat[] }>(
        `/crm/exports/formats/${input.kind}`,
        // Omitted, not null: the server reads an absent list as "use ours" and
        // an empty one as a sheet with no columns, which it refuses.
        input.columns === null ? {} : { columns: input.columns },
      );
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: exportFormatsKey }),
  });
}
