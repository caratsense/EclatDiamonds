"use client";

import { useState } from "react";
import { Download, FileArchive } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  useCatalogueExport,
  useCatalogueExports,
  useCreateCatalogueExport,
  useDownloadCatalogueExport,
  type CatalogueExport,
  type CatalogueExportFilters,
} from "@/lib/queries/catalogue-exports";
import { STOCK_CATEGORIES, STOCK_CLASS_OPTIONS, type StockClass } from "@/lib/queries/dead-stock";
import { apiErrorMessage } from "@/lib/utils";
import { useSession } from "@/store/use-session";

const SELECT = "h-9 w-full rounded-md border bg-background px-3 text-sm";

/**
 * The catalogue's photographs as one ZIP, for head office.
 *
 * It says what it did and did not do: a pending export says pending, a failed one
 * shows the reason, a completed one shows how many photographs were skipped and
 * why, and an email that was not configured is shown as not sent.
 */
export function CatalogueExportCard() {
  const stores = useSession((s) => s.stores).filter((s) => !s.isAggregate);
  const exports = useCatalogueExports(true);
  const create = useCreateCatalogueExport();
  const download = useDownloadCatalogueExport();

  const [filters, setFilters] = useState<CatalogueExportFilters>({});
  const [emailMe, setEmailMe] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const set = <K extends keyof CatalogueExportFilters>(key: K, value: string) =>
    setFilters((f) => ({ ...f, [key]: value || undefined }));

  const onCreate = () =>
    create.mutate(
      { ...filters, emailMe },
      {
        onSuccess: () =>
          toast.success("Export queued", {
            description: "It is built in the background. This list updates when it is ready.",
          }),
        onError: (e) => toast.error(apiErrorMessage(e, "Could not start that export.")),
      },
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FileArchive className="size-4" /> Export catalogue photographs
        </CardTitle>
        <CardDescription>
          A ZIP of product photographs with a manifest mapping each file to its SKU, style number,
          piece numbers and name. Photographs that could not be included are listed with the
          reason. Archives are kept for 7 days.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1.5">
            <Label htmlFor="cx-store">Branch</Label>
            <select
              id="cx-store"
              className={SELECT}
              value={filters.storeId ?? ""}
              onChange={(e) => set("storeId", e.target.value)}
            >
              <option value="">Every branch</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cx-category">Category</Label>
            <select
              id="cx-category"
              className={`${SELECT} capitalize`}
              value={filters.category ?? ""}
              onChange={(e) => set("category", e.target.value)}
            >
              <option value="">Every category</option>
              {STOCK_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cx-code">Style number or SKU</Label>
            <Input
              id="cx-code"
              placeholder="ST-9001"
              value={filters.code ?? ""}
              onChange={(e) => set("code", e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cx-status">Catalogue status</Label>
            <select
              id="cx-status"
              className={SELECT}
              value={filters.availability ?? ""}
              onChange={(e) => set("availability", e.target.value)}
            >
              <option value="">Any status</option>
              <option value="in_stock">In stock</option>
              <option value="lead_time">Made on order (lead time)</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cx-from">Updated from</Label>
            <Input
              id="cx-from"
              type="date"
              value={filters.updatedFrom ?? ""}
              onChange={(e) => set("updatedFrom", e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cx-to">Updated to</Label>
            <Input
              id="cx-to"
              type="date"
              value={filters.updatedTo ?? ""}
              onChange={(e) => set("updatedTo", e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cx-class">Classification</Label>
            <select
              id="cx-class"
              className={SELECT}
              value={filters.stockClass ?? ""}
              onChange={(e) => set("stockClass", e.target.value as StockClass)}
            >
              <option value="">Any classification</option>
              {STOCK_CLASS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={emailMe} onChange={(e) => setEmailMe(e.target.checked)} />
            Email it to me when it is ready
          </label>
          <Button onClick={onCreate} disabled={create.isPending}>
            <FileArchive className="size-4" />
            {create.isPending ? "Queuing…" : "Create export"}
          </Button>
        </div>

        {(exports.data ?? []).length > 0 ? (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Requested</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Photographs</TableHead>
                  <TableHead className="text-right">Skipped</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(exports.data ?? []).map((e) => (
                  <ExportRow
                    key={e.id}
                    row={e}
                    open={openId === e.id}
                    onToggle={() => setOpenId(openId === e.id ? null : e.id)}
                    downloading={download.isPending && download.variables === e.id}
                    onDownload={() =>
                      download.mutate(e.id, {
                        onError: (err) =>
                          toast.error(apiErrorMessage(err, "Could not download that archive.")),
                      })
                    }
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ExportRow({
  row,
  open,
  onToggle,
  downloading,
  onDownload,
}: {
  row: CatalogueExport;
  open: boolean;
  onToggle: () => void;
  downloading: boolean;
  onDownload: () => void;
}) {
  const detail = useCatalogueExport(open ? row.id : null);
  const tone = row.status === "completed" ? "good" : row.status === "failed" ? "bad" : "wait";
  const label =
    row.status === "pending"
      ? row.running
        ? "Building…"
        : "Queued"
      : row.status === "completed"
        ? "Ready"
        : "Failed";

  return (
    <>
      <TableRow>
        <TableCell>
          <div className="text-sm">{new Date(row.createdAt).toLocaleString("en-IN")}</div>
          <div className="text-xs text-muted-foreground">{row.requestedBy?.name ?? ""}</div>
        </TableCell>
        <TableCell>
          <StatusPill tone={tone}>{label}</StatusPill>
          {row.error ? (
            <div className="mt-1 max-w-sm text-xs text-rose-600 dark:text-rose-400">{row.error}</div>
          ) : null}
        </TableCell>
        <TableCell className="num text-right">
          {row.archive ? (
            <>
              {row.archive.files}
              <div className="text-xs text-muted-foreground">
                {(row.archive.bytes / (1024 * 1024)).toFixed(1)}MB
              </div>
            </>
          ) : (
            "—"
          )}
        </TableCell>
        <TableCell className="num text-right">
          {row.archive ? (
            row.archive.skippedCount > 0 ? (
              <button type="button" className="underline underline-offset-2" onClick={onToggle}>
                {row.archive.skippedCount}
              </button>
            ) : (
              0
            )
          ) : (
            "—"
          )}
        </TableCell>
        <TableCell className="max-w-56 text-xs text-muted-foreground">
          {/* Never "sent" before the job says so: pending reads as a promise to
              try, and a completed job shows exactly what the mail server did. */}
          {!row.emailRequested
            ? "—"
            : row.email
              ? row.email.detail
              : row.status === "failed"
                ? "Not sent"
                : "Will be tried when it is ready"}
        </TableCell>
        <TableCell className="text-right">
          {row.archive && !row.archive.expired ? (
            <Button size="sm" variant="outline" onClick={onDownload} disabled={downloading}>
              <Download className="size-4" />
              {downloading ? "Downloading…" : "Download"}
            </Button>
          ) : row.archive?.expired ? (
            <span className="text-xs text-muted-foreground">Expired</span>
          ) : null}
        </TableCell>
      </TableRow>
      {open ? (
        <TableRow>
          <TableCell colSpan={6} className="bg-muted/30">
            {detail.isLoading ? (
              <span className="text-xs text-muted-foreground">Loading…</span>
            ) : (
              <ul className="space-y-1 text-xs">
                {(detail.data?.skipped ?? []).map((s) => (
                  <li key={`${s.sku}-${s.reason}`}>
                    <span className="num font-medium">{s.sku}</span>{" "}
                    <span className="text-muted-foreground">
                      {s.productName} — {s.detail}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}
