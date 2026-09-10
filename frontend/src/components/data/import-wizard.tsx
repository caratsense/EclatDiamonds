"use client";

import { useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Loader2,
  Upload,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StoreScopeField, useStoreScope } from "@/components/common/store-scope-field";
import {
  downloadTemplate,
  useDiscoverImport,
  usePreviewImport,
  useRunImport,
  type DiscoverResult,
  type FieldMapping,
  type FileImportOrigin,
  type PreviewResult,
  type RunResult,
} from "@/lib/queries/imports";
import { apiErrorMessage } from "@/lib/utils";

/**
 * The file-import wizard: choose → map → preview → import.
 *
 * TWO THINGS THIS SCREEN REFUSES TO DO, both of which would look tidier:
 *
 *   1. It does not import on a guess. Suggested mappings are pre-selected but
 *      every one is editable, and a required field left unmapped blocks the run
 *      with the field named — rather than importing rows that silently lose it.
 *   2. It does not hide warnings. Duplicate, skipped and failed rows are shown
 *      with their reasons after the run. An import that reports only its
 *      successes is how a business discovers six months later that a third of
 *      its customers never arrived.
 *
 * The same file is re-sent at every step because the server holds no
 * cross-request state — see `lib/queries/imports.ts`.
 */

const STEPS = ["Choose file", "Map columns", "Preview", "Import"] as const;

/** Sentinel for "leave this column out" — Radix Select cannot hold an empty value. */
const SKIP = "__skip__";

const SOURCE_OPTIONS: { value: FileImportOrigin; label: string; note: string }[] = [
  {
    value: "spreadsheet",
    label: "Spreadsheet / other software",
    note: "Use a CSV or XLSX made manually or exported from any other system.",
  },
  {
    value: "tally",
    label: "Tally export",
    note: "Direct sync is not configured; this import will retain Tally as its source.",
  },
  {
    value: "busy",
    label: "BUSY export",
    note: "Direct sync is not configured; this import will retain BUSY as its source.",
  },
  {
    value: "gati",
    label: "Gati export",
    note: "Direct sync is not configured; this import will retain Gati as its source.",
  },
  {
    value: "odbc",
    label: "ODBC / database export",
    note: "A direct connection is not configured; this import will retain the database as its source.",
  },
];

export function ImportWizard({
  entities,
  initialEntity,
  initialSourceSystem = "spreadsheet",
}: {
  /** Importable entities, from the connector registry — not a hardcoded list. */
  entities: string[];
  initialEntity?: string;
  initialSourceSystem?: FileImportOrigin;
}) {
  const [entity, setEntity] = useState(initialEntity ?? entities[0] ?? "customers");
  const [sourceSystem, setSourceSystem] = useState<FileImportOrigin>(initialSourceSystem);
  const [file, setFile] = useState<File | null>(null);
  const [discovery, setDiscovery] = useState<DiscoverResult | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const scope = useStoreScope();
  const discover = useDiscoverImport();
  const runPreview = usePreviewImport();
  const runImport = useRunImport();

  const step = result ? 3 : preview ? 2 : discovery ? 1 : 0;

  const mappings: FieldMapping[] = useMemo(
    () =>
      Object.entries(mapping)
        .filter(([, field]) => field && field !== SKIP)
        .map(([sourceColumn, canonicalField]) => ({ sourceColumn, canonicalField })),
    [mapping],
  );

  /**
   * Recomputed from the CURRENT mapping, not from the server's first answer —
   * the user can unmap a required field after discovery, and the block has to
   * follow what they actually chose.
   */
  const missingRequired = useMemo(() => {
    if (!discovery) return [];
    const chosen = new Set(mappings.map((m) => m.canonicalField));
    return discovery.canonicalFields.filter((f) => f.required && !chosen.has(f.field));
  }, [discovery, mappings]);

  function reset() {
    setFile(null);
    setDiscovery(null);
    setMapping({});
    setPreview(null);
    setResult(null);
    if (fileInput.current) fileInput.current.value = "";
  }

  async function onFile(picked: File | null) {
    if (!picked) return;
    setFile(picked);
    setPreview(null);
    setResult(null);
    try {
      const d = await discover.mutateAsync({ entity, file: picked });
      setDiscovery(d);
      // Pre-select the server's suggestions; everything else starts unmapped so
      // an unrecognised column is visibly the user's decision, not a silent drop.
      setMapping(
        Object.fromEntries(d.suggestions.map((s) => [s.sourceColumn, s.canonicalField])),
      );
    } catch (e) {
      toast.error(apiErrorMessage(e, "Could not read that file."));
      reset();
    }
  }

  async function onPreview() {
    if (!file) return;
    try {
      setPreview(await runPreview.mutateAsync({ entity, file, mappings }));
    } catch (e) {
      toast.error(apiErrorMessage(e, "Preview failed."));
    }
  }

  async function onRun() {
    if (!file) return;
    if (scope.isAggregate && !scope.targetStoreId && entity !== "stores") {
      toast.error("Pick which store these records belong to before importing.");
      return;
    }
    try {
      const r = await runImport.mutateAsync({
        entity,
        file,
        mappings,
        storeId: scope.targetStoreId || undefined,
        sourceSystem: sourceSystem === "spreadsheet" ? undefined : sourceSystem,
      });
      setResult(r);
      toast.success(`${r.counts.imported} imported, ${r.counts.updated} updated.`);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Import failed."));
    }
  }

  return (
    <div className="space-y-4">
      <ol className="flex flex-wrap items-center gap-2 text-xs">
        {STEPS.map((s, i) => (
          <li key={s} className="flex items-center gap-2">
            <span
              className={`inline-flex h-6 items-center rounded-full px-2.5 font-medium ${
                i === step
                  ? "bg-primary text-primary-foreground"
                  : i < step
                    ? "bg-muted text-foreground"
                    : "bg-muted/50 text-muted-foreground"
              }`}
            >
              {i + 1}. {s}
            </span>
            {i < STEPS.length - 1 && <span className="text-muted-foreground">→</span>}
          </li>
        ))}
      </ol>

      {/* ---------------------------------------------------- 1. choose file */}
      {!discovery && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">What are you importing?</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label>File came from</Label>
                <Select
                  value={sourceSystem}
                  onValueChange={(value) => setSourceSystem(value as FileImportOrigin)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SOURCE_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {SOURCE_OPTIONS.find((option) => option.value === sourceSystem)?.note}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label>Record type</Label>
                <Select value={entity} onValueChange={setEntity}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {entities.map((e) => (
                      <SelectItem key={e} value={e}>
                        {e.charAt(0).toUpperCase() + e.slice(1)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Starter file</Label>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() =>
                    void downloadTemplate(entity).catch((e) =>
                      toast.error(apiErrorMessage(e, "Could not download the template.")),
                    )
                  }
                >
                  <Download className="h-4 w-4" />
                  Download {entity} template
                </Button>
              </div>
            </div>

            <label
              className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-muted/20 px-6 py-12 text-center transition-colors hover:bg-muted/40"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                void onFile(e.dataTransfer.files?.[0] ?? null);
              }}
            >
              <input
                ref={fileInput}
                type="file"
                accept=".csv,.xlsx,text/csv"
                className="sr-only"
                onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
              />
              {discover.isPending ? (
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              ) : (
                <Upload className="h-6 w-6 text-muted-foreground" />
              )}
              <span className="text-sm font-medium">
                {discover.isPending ? "Reading your file…" : "Drop a CSV or XLSX here, or click to choose"}
              </span>
              <span className="text-xs text-muted-foreground">
                Up to 8 MB. Legacy .xls is not supported — re-save it as .xlsx or CSV.
              </span>
              <span className="text-xs text-muted-foreground">
                PDF and Word files are documents, not row data. Export their records to CSV/XLSX first.
              </span>
            </label>
          </CardContent>
        </Card>
      )}

      {/* ----------------------------------------------------- 2. map columns */}
      {discovery && !result && (
        <Card>
          <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
            <div>
              <CardTitle className="text-base">
                {file?.name} · {discovery.rowCount} row{discovery.rowCount === 1 ? "" : "s"}
              </CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">
                Check each column below. Anything left as “Don’t import” is ignored.
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={reset}>
              <ArrowLeft className="h-4 w-4" />
              Different file
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            {missingRequired.length > 0 && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <p>
                  <span className="font-medium">Map these before importing: </span>
                  {missingRequired.map((f) => f.label).join(", ")}. Without them a row
                  cannot be identified.
                </p>
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="w-full min-w-[540px] text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="pb-2 pr-4 font-medium">Column in your file</th>
                    <th className="pb-2 pr-4 font-medium">Example values</th>
                    <th className="pb-2 font-medium">Import as</th>
                  </tr>
                </thead>
                <tbody>
                  {discovery.columns.map((col) => (
                    <tr key={col.name} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-medium">{col.name}</td>
                      <td className="max-w-[220px] truncate py-2 pr-4 text-xs text-muted-foreground">
                        {col.samples.join(" · ") || "—"}
                      </td>
                      <td className="py-2">
                        <Select
                          value={mapping[col.name] ?? SKIP}
                          onValueChange={(v) =>
                            setMapping((m) => ({ ...m, [col.name]: v }))
                          }
                        >
                          <SelectTrigger className="h-8 w-[200px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={SKIP}>Don’t import</SelectItem>
                            {discovery.canonicalFields.map((f) => (
                              <SelectItem key={f.field} value={f.field}>
                                {f.label}
                                {f.required ? " *" : ""}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {scope.isAggregate && entity !== "stores" && (
              <div className="max-w-xs">
                <StoreScopeField
                  value={scope.pickedStoreId}
                  onChange={scope.setPickedStoreId}
                  label="Attribute these records to"
                />
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => void onPreview()}
                disabled={missingRequired.length > 0 || runPreview.isPending}
              >
                {runPreview.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                Check the data
              </Button>
              {preview && (
                <Button
                  variant="gold"
                  onClick={() => void onRun()}
                  disabled={runImport.isPending || preview.valid + preview.warning === 0}
                >
                  {runImport.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                  Import {preview.valid + preview.warning} row
                  {preview.valid + preview.warning === 1 ? "" : "s"}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* -------------------------------------------------------- 3. preview */}
      {preview && !result && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">What will happen</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Tally label="Rows found" value={preview.total} />
              <Tally label="Ready" value={preview.valid} tone="good" />
              <Tally label="With warnings" value={preview.warning} tone="warn" />
              <Tally label="Cannot import" value={preview.error} tone="bad" />
            </div>
            {preview.error > 0 && (
              <p className="text-xs text-muted-foreground">
                Rows that cannot be imported are skipped — the rest still import. Fix them
                in your file and re-upload to bring them in.
              </p>
            )}
            <div className="space-y-1.5">
              {preview.sampleRows.map((r) => (
                <div
                  key={r.row}
                  className="flex flex-wrap items-start gap-2 rounded-md border px-3 py-1.5 text-xs"
                >
                  <StatusDot status={r.status} />
                  <span className="font-medium">Row {r.row}</span>
                  <span className="text-muted-foreground">
                    {r.issues.length
                      ? r.issues.map((i) => i.message).join("; ")
                      : "No problems found."}
                  </span>
                </div>
              ))}
              {preview.total > preview.sampleRows.length && (
                <p className="pt-1 text-xs text-muted-foreground">
                  Showing the first {preview.sampleRows.length} of {preview.total} rows. The
                  counts above cover every row.
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* --------------------------------------------------------- 4. result */}
      {result && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              Import finished
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <Tally label="New" value={result.counts.imported} tone="good" />
              <Tally label="Updated" value={result.counts.updated} />
              <Tally label="Duplicates" value={result.counts.duplicate} tone="warn" />
              <Tally label="Skipped" value={result.counts.skipped} />
              <Tally label="Failed" value={result.counts.failed} tone="bad" />
            </div>
            <p className="text-xs text-muted-foreground">
              Source: <span className="font-medium uppercase">{result.sourceSystem}</span>. Every
              record created by this run is tagged with batch{" "}
              <code className="rounded bg-muted px-1 py-0.5">{result.batchId.slice(0, 12)}</code>,
              so it can always be told apart from data entered by hand.
            </p>
            {result.issues.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-sm font-medium">
                  {result.issues.length} row{result.issues.length === 1 ? "" : "s"} need
                  attention
                </p>
                <div className="max-h-64 space-y-1 overflow-y-auto">
                  {result.issues.map((i) => (
                    <div
                      key={i.row}
                      className="flex gap-2 rounded-md border px-3 py-1.5 text-xs"
                    >
                      <span className="font-medium">Row {i.row}</span>
                      <span className="text-muted-foreground">{i.reason}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <Button variant="outline" onClick={reset}>
              <FileSpreadsheet className="h-4 w-4" />
              Import another file
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Tally({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "good" | "warn" | "bad";
}) {
  const colour =
    tone === "good"
      ? "text-emerald-600"
      : tone === "warn"
        ? "text-amber-600"
        : tone === "bad" && value > 0
          ? "text-destructive"
          : "text-foreground";
  return (
    <div className="rounded-lg border px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`num text-lg font-semibold ${colour}`}>{value}</p>
    </div>
  );
}

function StatusDot({ status }: { status: "valid" | "warning" | "error" }) {
  if (status === "error") return <XCircle className="mt-0.5 h-3.5 w-3.5 text-destructive" />;
  if (status === "warning")
    return <AlertTriangle className="mt-0.5 h-3.5 w-3.5 text-amber-600" />;
  return <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 text-emerald-600" />;
}

export function IntakeBadge({ mode }: { mode: string }) {
  const copy: Record<string, string> = {
    push: "Pushed to us",
    pull: "We fetch it",
    file_upload: "File upload",
  };
  return <Badge variant="outline">{copy[mode] ?? mode}</Badge>;
}
