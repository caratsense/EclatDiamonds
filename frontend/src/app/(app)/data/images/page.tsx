"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, FileArchive, Images, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";

import { CatalogueExportCard } from "@/components/data/catalogue-export-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { STAT_LABEL, STAT_VALUE_SM } from "@/components/ui/stat";
import { StatusPill } from "@/components/ui/status-pill";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ENTRY_STATUS,
  MATCH_BY_OPTIONS,
  useDeleteMappingProfile,
  useMappingProfiles,
  usePreviewImageZip,
  useRunImageZip,
  type ImageZipOutcome,
  type MatchBy,
} from "@/lib/queries/import-images";
import { apiErrorMessage } from "@/lib/utils";
import { useSession } from "@/store/use-session";

/**
 * Product photographs, a folder at a time.
 *
 * The screen exists to make one thing unavoidable: seeing what did NOT match
 * before anything is uploaded. A summary that reports "1,412 uploaded" and says
 * nothing about the other 88 is a number nobody can act on, so every entry is
 * listed by name with the reason it went where it went.
 */
export default function ImageImportPage() {
  const stores = useSession((s) => s.stores);
  const isHo = useSession((s) => s.role) === "head_office";
  const fileRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [matchBy, setMatchBy] = useState<MatchBy>("sku");
  const [stripPrefix, setStripPrefix] = useState("");
  const [stripSuffix, setStripSuffix] = useState("");
  const [stripNumericSuffix, setStripNumericSuffix] = useState(false);
  const [overwriteExisting, setOverwriteExisting] = useState(false);
  const [storeId, setStoreId] = useState("");
  const [outcome, setOutcome] = useState<ImageZipOutcome | null>(null);
  const [committed, setCommitted] = useState(false);

  const preview = usePreviewImageZip();
  const run = useRunImageZip();
  const profiles = useMappingProfiles();
  const deleteProfile = useDeleteMappingProfile();

  const options = {
    matchBy,
    stripPrefix: stripPrefix || undefined,
    stripSuffix: stripSuffix || undefined,
    stripNumericSuffix,
    overwriteExisting,
    storeId: storeId || undefined,
  };

  const onPreview = () => {
    if (!file) return;
    setCommitted(false);
    preview.mutate(
      { file, ...options },
      {
        onSuccess: (res) => setOutcome(res),
        onError: (e) => toast.error(apiErrorMessage(e, "Could not read that archive.")),
      },
    );
  };

  const onRun = () => {
    if (!file) return;
    run.mutate(
      { file, ...options },
      {
        onSuccess: (res) => {
          setOutcome(res);
          setCommitted(true);
          toast.success(`${res.uploaded} photograph(s) attached`, {
            description:
              res.unmatched + res.ambiguous + res.failed > 0
                ? `${res.unmatched} matched nothing, ${res.ambiguous} were ambiguous, ${res.failed} failed. They are listed below.`
                : "Every image in the archive found its product.",
          });
        },
        onError: (e) => toast.error(apiErrorMessage(e, "The import did not finish.")),
      },
    );
  };

  const busy = preview.isPending || run.isPending;

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Link
          href="/data"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" /> Data
        </Link>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Images className="size-5" /> Product photographs
        </h1>
        <p className="text-sm text-muted-foreground">
          Upload a ZIP of images named after your design codes. Nothing is written until you have
          seen what matched.
        </p>
      </div>

      {/* ---------------------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">The archive</CardTitle>
          <CardDescription>
            Tell us what the filenames are. Nothing is guessed — a name that could be a code or a
            product title would otherwise attach a photograph to the wrong piece.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={fileRef}
              id="zip"
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setOutcome(null);
              }}
            />
            <Button variant="outline" onClick={() => fileRef.current?.click()}>
              <FileArchive className="size-4" /> Choose ZIP
            </Button>
            <span className="text-sm text-muted-foreground">
              {file ? `${file.name} — ${(file.size / (1024 * 1024)).toFixed(1)}MB` : "No file chosen"}
            </span>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1.5">
              <Label htmlFor="match-by">The filename is the…</Label>
              <select
                id="match-by"
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={matchBy}
                onChange={(e) => setMatchBy(e.target.value as MatchBy)}
              >
                {MATCH_BY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                {MATCH_BY_OPTIONS.find((o) => o.value === matchBy)?.hint}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="strip-prefix">Ignore this at the start</Label>
              <Input
                id="strip-prefix"
                placeholder="IMG_"
                value={stripPrefix}
                onChange={(e) => setStripPrefix(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="strip-suffix">Ignore this at the end</Label>
              <Input
                id="strip-suffix"
                placeholder="_main"
                value={stripSuffix}
                onChange={(e) => setStripSuffix(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="store">Branch</Label>
              <select
                id="store"
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={storeId}
                onChange={(e) => setStoreId(e.target.value)}
              >
                <option value="">Every branch</option>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-2">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={stripNumericSuffix}
                onChange={(e) => setStripNumericSuffix(e.target.checked)}
              />
              <span>
                Treat <span className="num">RING-101-2.jpg</span> as another photo of{" "}
                <span className="num">RING-101</span>
                <span className="block text-xs text-muted-foreground">
                  Leave this off if your codes genuinely end in -2.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={overwriteExisting}
                onChange={(e) => setOverwriteExisting(e.target.checked)}
              />
              <span>
                Replace photographs products already have
                <span className="block text-xs text-muted-foreground">
                  Off by default. Your own photography is usually better than a supplier&rsquo;s.
                </span>
              </span>
            </label>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={onPreview} disabled={!file || busy}>
              {preview.isPending ? "Reading…" : "Preview"}
            </Button>
            <Button onClick={onRun} disabled={!file || busy || !outcome}>
              <Upload className="size-4" />
              {run.isPending ? "Uploading…" : "Import"}
            </Button>
            {!outcome && file ? (
              <p className="self-center text-xs text-muted-foreground">
                Preview first — the import button turns on once you have seen what matched.
              </p>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {/* ---------------------------------------------------------------- */}
      {outcome ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Tile label="Files" value={outcome.entries} />
            <Tile
              label={committed ? "Uploaded" : "Will upload"}
              value={committed ? outcome.uploaded : outcome.matched}
              tone="text-emerald-600 dark:text-emerald-400"
            />
            <Tile
              label="No product"
              value={outcome.unmatched}
              tone={outcome.unmatched > 0 ? "text-rose-600 dark:text-rose-400" : undefined}
            />
            <Tile
              label="Ambiguous"
              value={outcome.ambiguous}
              tone={outcome.ambiguous > 0 ? "text-rose-600 dark:text-rose-400" : undefined}
            />
            <Tile label="Already had one" value={outcome.skipped} />
            <Tile
              label="Failed"
              value={outcome.failed}
              tone={outcome.failed > 0 ? "text-rose-600 dark:text-rose-400" : undefined}
            />
          </div>

          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>File</TableHead>
                  <TableHead>Matched on</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Why</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {outcome.results.map((r) => (
                  <TableRow key={r.filename}>
                    <TableCell className="font-medium">{r.filename}</TableCell>
                    <TableCell className="num text-muted-foreground">{r.key || "—"}</TableCell>
                    <TableCell className="num text-muted-foreground">
                      {r.productSku ?? "—"}
                    </TableCell>
                    <TableCell>
                      <StatusPill tone={ENTRY_STATUS[r.status].tone}>
                        {ENTRY_STATUS[r.status].label}
                      </StatusPill>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {r.detail ?? ""}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {/* The other direction: head office taking the photographs away. */}
      {isHo ? <CatalogueExportCard /> : null}

      {/* ---------------------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Saved column mappings</CardTitle>
          <CardDescription>
            For the spreadsheet half of an import. A saved mapping remembers the columns it was
            built from, so a supplier renaming one is reported instead of silently mapped.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {(profiles.data ?? []).length === 0 ? (
            <EmptyState
              icon={FileArchive}
              title="No saved mappings"
              description="Map a file once on the import screen and save it. Next month it is one click."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>For</TableHead>
                  <TableHead className="text-right">Columns</TableHead>
                  <TableHead className="text-right">Used</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(profiles.data ?? []).map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell className="capitalize text-muted-foreground">{p.entity}</TableCell>
                    <TableCell className="num text-right">{p.mappings.length}</TableCell>
                    <TableCell className="num text-right text-muted-foreground">
                      {p.useCount}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          deleteProfile.mutate(p.id, {
                            onSuccess: () => toast.success(`Deleted “${p.name}”`),
                            onError: (e) =>
                              toast.error(apiErrorMessage(e, "Could not delete it.")),
                          })
                        }
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-lg border p-3">
      <div className={STAT_LABEL}>{label}</div>
      <div className={tone ? `${STAT_VALUE_SM} ${tone}` : STAT_VALUE_SM}>{value}</div>
    </div>
  );
}
