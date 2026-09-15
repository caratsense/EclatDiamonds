"use client";

import { useEffect, useState } from "react";
import {
  ArrowLeftRight,
  ArrowRight,
  Download,
  FileSpreadsheet,
  Flame,
  PackageSearch,
  Search,
  Upload,
  X,
} from "lucide-react";
import * as XLSX from "xlsx";
import { toast } from "sonner";

import { SectionHeader } from "@/components/section/section-header";
import { AgingChart } from "@/components/inventory/aging-chart";
import { CreateTransferDialog } from "@/components/inventory/create-transfer-dialog";
import { KpiCard } from "@/components/dashboards/kpi-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PaginationBar } from "@/components/ui/pagination-bar";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatGrams, formatINR, formatPurity } from "@/lib/format";
import { CATEGORY_LABELS, METAL_LABELS, type Metal } from "@/lib/mock/catalogue";
import {
  DEAD_STOCK_THRESHOLD_DAYS,
  type StockStatus,
  type StockItem,
} from "@/lib/mock/inventory";
import {
  useAdjustStock,
  useBulkAdjustStock,
  useBulkImportStock,
  useCreateStock,
  useStock,
  useStockSummary,
  ADJUST_REASON_OPTIONS,
  type AdjustReason,
  type ImportStockRow,
  type StockStatusValue,
} from "@/lib/queries/stock";
import { ROLE_RANK } from "@/lib/types";
import { useSession } from "@/store/use-session";
import {
  StoreScopeField,
  useStoreScope,
} from "@/components/common/store-scope-field";
import { apiErrorMessage, isRealName } from "@/lib/utils";

const STATUS_VARIANT: Record<
  StockStatus,
  "secondary" | "success" | "destructive" | "outline"
> = {
  "In stock": "success",
  Aging: "secondary",
  "Dead stock": "destructive",
  Reserved: "outline",
};

/** Age buckets — keys match the backend (inwardDate ranges) + the aging chart. */
const AGE_BUCKETS: { value: string; label: string }[] = [
  { value: "0-30", label: "0–30 days" },
  { value: "31-90", label: "31–90 days" },
  { value: "91-180", label: "91–180 days" },
  { value: "181-365", label: "181–365 days" },
  { value: "365+", label: "365+ days" },
];

/** The four ledger statuses a piece can be filtered to (sold/melted/transferred drop out). */
const STATUS_FILTERS: { value: StockStatusValue; label: string }[] = [
  { value: "in_stock", label: "In stock" },
  { value: "aging", label: "Aging" },
  { value: "dead_stock", label: "Dead stock" },
  { value: "reserved", label: "Reserved" },
];

/** Columns for the bulk-import spreadsheet (order used by the template + parser). */
const IMPORT_COLUMNS = [
  "sku",
  "metal",
  "name",
  "karat",
  "grossWeight",
  "netWeight",
  "diamondPieces",
  "diamondWeightCt",
  "tagPrice",
  "huid",
  "hallmarkNo",
  "certificateNo",
] as const;

/** Build + download an .xlsx of the current stock rows (SheetJS, client-side). */
function exportStockXlsx(rows: StockItem[]) {
  const data = rows.map((s) => ({
    SKU: s.sku,
    Name: s.name,
    Category: s.category,
    Store: s.storeName,
    "Purity (K)": s.karat,
    "Gross weight (g)": s.grossGrams,
    "Tag price (INR)": s.tagPrice,
    "Age (days)": s.ageDays,
    Status: s.status,
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Stock");
  XLSX.writeFile(wb, `stock-${new Date().toISOString().slice(0, 10)}.xlsx`);
}

export default function InventoryPage() {
  const { currentStore, stores, role } = useSession();
  const canManage = ROLE_RANK[role] >= ROLE_RANK.store_manager;
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [adjustItem, setAdjustItem] = useState<StockItem | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);

  // Table search + facet filters (all server-side, over the whole store-scoped
  // set — not just the current page). Any change resets to page 1.
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("all");
  const [metal, setMetal] = useState("all");
  const [status, setStatus] = useState("all");
  const [ageBucket, setAgeBucket] = useState("all");
  const [storeFilter, setStoreFilter] = useState("all");

  // Multi-select for bulk actions (within the loaded page — cleared on nav).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkAdjustOpen, setBulkAdjustOpen] = useState(false);
  const [bulkTransfer, setBulkTransfer] = useState<{
    ids: string[];
    sourceStoreId: string;
  } | null>(null);

  // Aging chart metric toggle.
  const [agingMetric, setAgingMetric] = useState<"items" | "value">("items");

  // Debounce the search box so we don't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const realStores = stores.filter((s) => !s.isAggregate);
  const showStoreFilter = realStores.length > 1;

  function clearSelection() {
    setSelected(new Set());
  }

  function onFilterChange(setter: (v: string) => void) {
    return (v: string) => {
      setter(v);
      setPage(1);
      clearSelection();
    };
  }

  // Stock ledger comes live + store-scoped and server-paginated from the API.
  const { data, isLoading, isError, refetch } = useStock({
    page,
    pageSize,
    q,
    category: category === "all" ? undefined : category,
    metal: metal === "all" ? undefined : metal,
    status: status === "all" ? undefined : status,
    ageBucket: ageBucket === "all" ? undefined : ageBucket,
    storeId: showStoreFilter && storeFilter !== "all" ? storeFilter : undefined,
  });
  const rows = data?.items ?? [];
  const total = data?.total ?? 0;

  // KPI cards + aging distribution are computed server-side over the WHOLE
  // store-scoped set, so they never reflect only the current page or mock data.
  const { data: summary } = useStockSummary();

  const selectedRows = rows.filter((r) => selected.has(r.id));

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => {
      if (rows.every((r) => prev.has(r.id))) return new Set();
      return new Set(rows.map((r) => r.id));
    });
  }

  function openBulkTransfer() {
    const storeIds = new Set(selectedRows.map((r) => r.storeId));
    if (storeIds.size > 1) {
      toast.error(
        "Bulk transfer moves pieces from ONE store. Select pieces from a single store.",
      );
      return;
    }
    setBulkTransfer({
      ids: selectedRows.map((r) => r.id),
      sourceStoreId: [...storeIds][0] ?? "",
    });
  }

  return (
    <>
      <SectionHeader
        title="Inventory & Stock"
        purpose="Stock levels, aging lines and scrap recovery."
        // No single store to write to on the "All Stores" aggregate — hide the
        // add button there (read-only view); it works on a concrete store.
        primaryAction={
          currentStore.isAggregate || !(canManage || role === "storeperson") ? undefined : "Stock Entry"
        }
        onPrimaryAction={() => setAddOpen(true)}
      />

      {/* Top KPI cards — pieces · gold weight · value at today's rate · dead stock */}
      <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Total pieces"
          value={summary?.totalPieces ?? 0}
          format="number"
          delta={null}
          index={0}
        />
        <KpiCard
          label="Gold weight (g)"
          value={summary?.totalGoldGrams ?? 0}
          format="number"
          delta={null}
          index={1}
        />
        <KpiCard
          label="Stock value"
          value={summary?.totalStockValue ?? 0}
          format="inr"
          delta={null}
          index={2}
        />
        <KpiCard
          label="Dead-stock items"
          value={summary?.deadStock ?? 0}
          format="number"
          delta={null}
          index={3}
        />
      </div>

      <StockEntryDialog open={addOpen} onOpenChange={setAddOpen} />
      {/* key remounts each dialog fresh on open, so state resets without an effect. */}
      <ImportStockDialog
        key={importOpen ? "import-open" : "import-closed"}
        open={importOpen}
        onOpenChange={setImportOpen}
      />
      <StockAdjustDialog
        key={adjustItem?.id ?? "adjust-closed"}
        item={adjustItem}
        onOpenChange={(open) => {
          if (!open) setAdjustItem(null);
        }}
      />
      <BulkAdjustDialog
        key={bulkAdjustOpen ? "bulk-open" : "bulk-closed"}
        open={bulkAdjustOpen}
        ids={[...selected]}
        onOpenChange={setBulkAdjustOpen}
        onDone={clearSelection}
      />
      <CreateTransferDialog
        key={bulkTransfer ? bulkTransfer.ids.join(",") : "transfer-closed"}
        open={!!bulkTransfer}
        onOpenChange={(open) => {
          if (!open) {
            setBulkTransfer(null);
            clearSelection();
          }
        }}
        initialStockItemIds={bulkTransfer?.ids}
        initialSourceStoreId={bulkTransfer?.sourceStoreId || undefined}
      />

      {/* Aging distribution */}
      <Card className="mb-4">
        <CardHeader className="flex flex-row items-start justify-between gap-2 pb-2">
          <div>
            <CardTitle className="text-base">Aging distribution</CardTitle>
            <CardDescription>
              Stock {agingMetric === "value" ? "value" : "count"} by days-in-inventory
              bucket. Items past {DEAD_STOCK_THRESHOLD_DAYS} days are treated as
              dead stock.
            </CardDescription>
          </div>
          {/* Toggle piece count vs value. */}
          <div className="flex shrink-0 rounded-md border p-0.5">
            <Button
              variant={agingMetric === "items" ? "secondary" : "ghost"}
              size="sm"
              className="h-7"
              onClick={() => setAgingMetric("items")}
            >
              Pieces
            </Button>
            <Button
              variant={agingMetric === "value" ? "secondary" : "ghost"}
              size="sm"
              className="h-7"
              onClick={() => setAgingMetric("value")}
            >
              Value
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <AgingChart data={summary?.aging ?? []} metric={agingMetric} />
        </CardContent>
      </Card>

      {/* Store-wise breakdown — only when more than one store is in scope. */}
      {summary?.byStore && summary.byStore.length > 0 ? (
        <Card className="mb-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Store-wise stock</CardTitle>
            <CardDescription>
              Pieces and value held at each branch in scope.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Store</TableHead>
                  <TableHead className="text-right">Pieces</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.byStore.map((s) => (
                  <TableRow key={s.storeId}>
                    <TableCell className="font-medium">{s.storeName}</TableCell>
                    <TableCell className="text-right">
                      <span className="num">{s.pieces}</span>
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="num">{formatINR(s.value)}</span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      <Tabs defaultValue="stock">
        <TabsList>
          <TabsTrigger value="stock">Stock</TabsTrigger>
          <TabsTrigger value="rotation">Rotation</TabsTrigger>
          <TabsTrigger value="melt">Melting &amp; Scrap</TabsTrigger>
          <TabsTrigger value="reorder">Reorder</TabsTrigger>
        </TabsList>

        <TabsContent value="stock">
          <Card>
            <CardContent className="pt-6">
              {/* Search + facet filters + export/import — all drive the server query. */}
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Search name or SKU…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="w-[220px] pl-8"
                  />
                </div>

                <Select value={category} onValueChange={onFilterChange(setCategory)}>
                  <SelectTrigger className="w-[150px]">
                    <SelectValue placeholder="Category" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All categories</SelectItem>
                    {Object.entries(CATEGORY_LABELS).map(([id, label]) => (
                      <SelectItem key={id} value={id}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select value={metal} onValueChange={onFilterChange(setMetal)}>
                  <SelectTrigger className="w-[150px]">
                    <SelectValue placeholder="Purity" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All purities</SelectItem>
                    {Object.entries(METAL_LABELS).map(([id, label]) => (
                      <SelectItem key={id} value={id}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select value={status} onValueChange={onFilterChange(setStatus)}>
                  <SelectTrigger className="w-[140px]">
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    {STATUS_FILTERS.map((s) => (
                      <SelectItem key={s.value} value={s.value}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select value={ageBucket} onValueChange={onFilterChange(setAgeBucket)}>
                  <SelectTrigger className="w-[150px]">
                    <SelectValue placeholder="Age" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All ages</SelectItem>
                    {AGE_BUCKETS.map((b) => (
                      <SelectItem key={b.value} value={b.value}>
                        {b.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {showStoreFilter ? (
                  <Select
                    value={storeFilter}
                    onValueChange={onFilterChange(setStoreFilter)}
                  >
                    <SelectTrigger className="w-[170px]">
                      <SelectValue placeholder="Store" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All stores</SelectItem>
                      {realStores.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}

                <div className="ml-auto flex items-center gap-2">
                  {canManage ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setImportOpen(true)}
                    >
                      <Upload className="h-4 w-4" />
                      Import from Excel
                    </Button>
                  ) : null}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => exportStockXlsx(rows)}
                    disabled={rows.length === 0}
                  >
                    <Download className="h-4 w-4" />
                    Export to Excel
                  </Button>
                </div>
              </div>

              {/* Bulk action bar — appears when pieces are selected. */}
              {canManage && selected.size > 0 ? (
                <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
                  <span className="text-sm font-medium">
                    <span className="num">{selected.size}</span> selected
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setBulkAdjustOpen(true)}
                  >
                    Bulk update status
                  </Button>
                  <Button variant="outline" size="sm" onClick={openBulkTransfer}>
                    Bulk transfer
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    onClick={clearSelection}
                  >
                    <X className="h-4 w-4" /> Clear
                  </Button>
                </div>
              ) : null}

              <Table>
                <TableHeader>
                  <TableRow>
                    {canManage ? (
                      <TableHead className="w-8">
                        <input
                          type="checkbox"
                          aria-label="Select all on this page"
                          className="h-4 w-4 accent-[var(--gold)]"
                          checked={
                            rows.length > 0 &&
                            rows.every((r) => selected.has(r.id))
                          }
                          onChange={toggleAll}
                        />
                      </TableHead>
                    ) : null}
                    <TableHead>Item</TableHead>
                    <TableHead>Store</TableHead>
                    <TableHead>Purity</TableHead>
                    <TableHead className="text-right">Weight</TableHead>
                    <TableHead className="text-right">Tag price</TableHead>
                    <TableHead className="text-right">Age</TableHead>
                    <TableHead className="text-right">Status</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    <TableRow>
                      <TableCell colSpan={canManage ? 9 : 8} className="py-6">
                        <Skeleton className="h-24 w-full" />
                      </TableCell>
                    </TableRow>
                  ) : isError ? (
                    <TableRow>
                      <TableCell colSpan={canManage ? 9 : 8} className="py-10">
                        <div className="mx-auto max-w-md rounded-lg border bg-muted/30 p-4 text-center">
                          <p className="text-sm font-medium">
                            Couldn&apos;t load the stock ledger.
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            The connection may have dropped. Check your network
                            and try again.
                          </p>
                          <Button
                            variant="outline"
                            size="sm"
                            className="mt-3"
                            onClick={() => refetch()}
                          >
                            Retry
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : rows.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={canManage ? 9 : 8}
                        className="py-10 text-center text-muted-foreground"
                      >
                        No stock entries yet. Add a piece to begin.
                      </TableCell>
                    </TableRow>
                  ) : null}
                  {rows.map((s) => {
                    const isDead = s.ageDays > DEAD_STOCK_THRESHOLD_DAYS;
                    return (
                      <TableRow
                        key={s.id}
                        className={isDead ? "bg-destructive/5" : undefined}
                      >
                        {canManage ? (
                          <TableCell>
                            <input
                              type="checkbox"
                              aria-label={`Select ${s.sku}`}
                              className="h-4 w-4 accent-[var(--gold)]"
                              checked={selected.has(s.id)}
                              onChange={() => toggleRow(s.id)}
                            />
                          </TableCell>
                        ) : null}
                        <TableCell>
                          <div className="font-medium">{s.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {s.sku} · {s.category}
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {s.storeName}
                        </TableCell>
                        <TableCell>
                          <span className="num">{formatPurity(s.karat)}</span>
                        </TableCell>
                        <TableCell className="text-right">
                          <span className="num">
                            {formatGrams(s.grossGrams, 2)}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          <span className="num">{formatINR(s.tagPrice)}</span>
                        </TableCell>
                        <TableCell
                          className={
                            isDead
                              ? "text-right font-medium text-destructive"
                              : "text-right"
                          }
                        >
                          <span className="num">{s.ageDays}d</span>
                        </TableCell>
                        <TableCell className="text-right">
                          <Badge variant={STATUS_VARIANT[s.status]}>
                            {s.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          {canManage ? (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setAdjustItem(s)}
                            >
                              Update Status
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              —
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>

              {!isLoading && total > 0 ? (
                <PaginationBar
                  page={page}
                  pageSize={pageSize}
                  total={total}
                  onPageChange={(p) => {
                    setPage(p);
                    clearSelection();
                  }}
                  onPageSizeChange={(size) => {
                    setPageSize(size);
                    setPage(1);
                    clearSelection();
                  }}
                  className="border-t"
                />
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>

        <RotationTab />

        <TabsContent value="melt">
          <MeltingTab />
        </TabsContent>

        <TabsContent value="reorder">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                Auto-reorder alerts
              </CardTitle>
              <CardDescription>
                On-hand below a reorder point, with a suggested purchase quantity.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {/* No reorder points are recorded anywhere in the system, so there
                  is nothing to compare on-hand against. This used to show
                  invented items and quantities, which is worse than showing
                  nothing: a manager acting on them would order stock against
                  numbers no one set. */}
              <EmptyState
                icon={PackageSearch}
                title="Reorder points are not set up yet"
                description="Once a minimum quantity is recorded against your items, anything that falls below it will be listed here with a suggested order. Until then no recommendation can be made."
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </>
  );
}

/**
 * Stock rotation — the oldest idle pieces in scope, driven from the live stock
 * ledger (GET /stock is sorted age-desc). Shows the real idle age from each
 * piece's ageDays and its value, so the section reflects actual inventory.
 */
function RotationTab() {
  const { role } = useSession();
  const canManage = ROLE_RANK[role] >= ROLE_RANK.store_manager;
  const { data, isLoading, isError } = useStock({ page: 1, pageSize: 10 });
  const idle = (data?.items ?? []).filter(
    (p) => p.ageDays > 90 && p.status !== "Reserved",
  );
  // Reuse the Stock Transfer workflow — a "Raise Transfer" prefills this dialog
  // with the idle piece + its holding store; no separate transfer API.
  const [transferItem, setTransferItem] = useState<StockItem | null>(null);

  return (
    <TabsContent value="rotation">
      <CreateTransferDialog
        key={transferItem?.id ?? "rotation-transfer-closed"}
        open={!!transferItem}
        onOpenChange={(open) => {
          if (!open) setTransferItem(null);
        }}
        initialStockItemIds={transferItem ? [transferItem.id] : undefined}
        initialSourceStoreId={transferItem?.storeId || undefined}
      />
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Slow-moving stock</CardTitle>
          <CardDescription>
            The oldest pieces in stock by idle age — candidates to rotate to a
            higher-demand branch. Use Raise Transfer to move a piece to another
            store.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : isError ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Couldn&apos;t load the stock ledger.
            </p>
          ) : idle.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No slow-moving stock — nothing has been idle past 90 days.
            </p>
          ) : (
            idle.map((r) => (
              <div
                key={r.id}
                className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {r.name}
                    <span className="text-xs font-normal text-muted-foreground">
                      {r.sku}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>{r.storeName}</span>
                    <ArrowRight className="h-3.5 w-3.5" />
                    <Badge
                      variant={
                        r.ageDays > DEAD_STOCK_THRESHOLD_DAYS
                          ? "destructive"
                          : "secondary"
                      }
                    >
                      <span className="num">{r.ageDays}d</span> idle
                    </Badge>
                    <span>·</span>
                    <span className="num">{formatINR(r.tagPrice)}</span>
                  </div>
                </div>
                {canManage ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() => setTransferItem(r)}
                  >
                    <ArrowLeftRight className="h-4 w-4" />
                    Raise Transfer
                  </Button>
                ) : null}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </TabsContent>
  );
}

function StockEntryDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { isAggregate, targetStoreId, storeLabel, pickedStoreId, setPickedStoreId } =
    useStoreScope();
  const createStock = useCreateStock();
  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [metal, setMetal] = useState<Metal>("gold_22k");
  const [karat, setKarat] = useState("");
  const [grossWeight, setGrossWeight] = useState("");
  const [netWeight, setNetWeight] = useState("");
  const [pureWeight, setPureWeight] = useState("");
  const [diamondPieces, setDiamondPieces] = useState("");
  const [diamondWeightCt, setDiamondWeightCt] = useState("");
  const [stoneWeightCt, setStoneWeightCt] = useState("");
  const [tagPrice, setTagPrice] = useState("");
  const [mrp, setMrp] = useState("");
  const [huid, setHuid] = useState("");
  const [hallmarkNo, setHallmarkNo] = useState("");
  const [certificateNo, setCertificateNo] = useState("");
  // Inline validation errors, keyed by field. Cleared per-field on change.
  const [errors, setErrors] = useState<Record<string, string>>({});

  function clearError(field: string) {
    setErrors((prev) => (prev[field] ? { ...prev, [field]: "" } : prev));
  }

  // On "All Stores" the user MUST pick a concrete store first (backend rejects
  // 'all'); show it inline rather than only as a toast on submit.
  const needsStore = isAggregate && !targetStoreId;

  const num = (v: string) => (v.trim() ? Number(v) : undefined);

  function save() {
    if (!targetStoreId) {
      toast.error("Select a store to add this stock to.");
      return;
    }
    const next: Record<string, string> = {};
    // SKU is required but is NOT a name — only require it be non-empty.
    if (!sku.trim()) next.sku = "SKU / tag number is required.";
    // Name is optional; when supplied it must read like a real name (backend
    // @IsRealName only fires when a value is present).
    if (name.trim() && !isRealName(name))
      next.name = "Enter a real name (letters, not just a number).";
    // Weights / prices / counts can't be negative (backend @Min(0)).
    const numericFields: [string, string][] = [
      [karat, "karat"],
      [grossWeight, "grossWeight"],
      [netWeight, "netWeight"],
      [pureWeight, "pureWeight"],
      [diamondPieces, "diamondPieces"],
      [diamondWeightCt, "diamondWeightCt"],
      [stoneWeightCt, "stoneWeightCt"],
      [tagPrice, "tagPrice"],
      [mrp, "mrp"],
    ];
    for (const [val, key] of numericFields) {
      if (val.trim() && Number(val) < 0) next[key] = "Cannot be negative.";
    }
    if (Object.keys(next).length > 0) {
      setErrors(next);
      toast.error("Please fix the highlighted fields.");
      return;
    }
    createStock.mutate(
      {
        storeId: targetStoreId,
        sku: sku.trim(),
        name: name.trim() || undefined,
        metal,
        karat: num(karat),
        grossWeight: num(grossWeight),
        netWeight: num(netWeight),
        pureWeight: num(pureWeight),
        diamondPieces: num(diamondPieces),
        diamondWeightCt: num(diamondWeightCt),
        stoneWeightCt: num(stoneWeightCt),
        tagPrice: num(tagPrice),
        mrp: num(mrp),
        huid: huid.trim() || undefined,
        hallmarkNo: hallmarkNo.trim() || undefined,
        certificateNo: certificateNo.trim() || undefined,
      },
      {
        onSuccess: () => {
          toast.success("Stock item added");
          setSku("");
          setName("");
          setMetal("gold_22k");
          setKarat("");
          setGrossWeight("");
          setNetWeight("");
          setPureWeight("");
          setDiamondPieces("");
          setDiamondWeightCt("");
          setStoneWeightCt("");
          setTagPrice("");
          setMrp("");
          setHuid("");
          setHallmarkNo("");
          setCertificateNo("");
          setErrors({});
          onOpenChange(false);
        },
        onError: (err) =>
          toast.error(apiErrorMessage(err, "Could not add stock item.")),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Stock entry</DialogTitle>
          <DialogDescription>
            New pieces are added to {storeLabel}.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <StoreScopeField value={pickedStoreId} onChange={setPickedStoreId} />
          {needsStore ? (
            <p className="text-xs text-destructive">
              Choose a specific store before adding stock — you&apos;re on the
              All Stores view.
            </p>
          ) : null}

          <div className="grid gap-1.5">
            <Label htmlFor="sku">
              SKU / tag number <span className="text-destructive">*</span>
            </Label>
            <Input
              id="sku"
              placeholder="e.g. NK-22K-0142"
              value={sku}
              aria-invalid={!!errors.sku}
              onChange={(e) => {
                setSku(e.target.value);
                clearError("sku");
              }}
            />
            {errors.sku ? (
              <p className="mt-1 text-xs text-destructive">{errors.sku}</p>
            ) : null}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              placeholder="e.g. Antique bridal necklace"
              value={name}
              aria-invalid={!!errors.name}
              onChange={(e) => {
                setName(e.target.value);
                clearError("name");
              }}
            />
            {errors.name ? (
              <p className="mt-1 text-xs text-destructive">{errors.name}</p>
            ) : null}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="metal">Metal / purity</Label>
            <Select value={metal} onValueChange={(v) => setMetal(v as Metal)}>
              <SelectTrigger id="metal">
                <SelectValue placeholder="Metal" />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(METAL_LABELS).map(([id, label]) => (
                  <SelectItem key={id} value={id}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="karat">Karat</Label>
              <Input
                id="karat"
                type="number"
                min={0}
                placeholder="e.g. 22"
                value={karat}
                aria-invalid={!!errors.karat}
                onChange={(e) => {
                  setKarat(e.target.value);
                  clearError("karat");
                }}
              />
              {errors.karat ? (
                <p className="mt-1 text-xs text-destructive">{errors.karat}</p>
              ) : null}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="gross">Gross weight (g)</Label>
              <Input
                id="gross"
                type="number"
                min={0}
                step="0.001"
                placeholder="e.g. 18.420"
                value={grossWeight}
                aria-invalid={!!errors.grossWeight}
                onChange={(e) => {
                  setGrossWeight(e.target.value);
                  clearError("grossWeight");
                }}
              />
              {errors.grossWeight ? (
                <p className="mt-1 text-xs text-destructive">
                  {errors.grossWeight}
                </p>
              ) : null}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="net">Net weight (g)</Label>
              <Input
                id="net"
                type="number"
                min={0}
                step="0.001"
                placeholder="e.g. 17.900"
                value={netWeight}
                aria-invalid={!!errors.netWeight}
                onChange={(e) => {
                  setNetWeight(e.target.value);
                  clearError("netWeight");
                }}
              />
              {errors.netWeight ? (
                <p className="mt-1 text-xs text-destructive">
                  {errors.netWeight}
                </p>
              ) : null}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="pure">Pure weight (g)</Label>
              <Input
                id="pure"
                type="number"
                min={0}
                step="0.001"
                placeholder="e.g. 16.400"
                value={pureWeight}
                aria-invalid={!!errors.pureWeight}
                onChange={(e) => {
                  setPureWeight(e.target.value);
                  clearError("pureWeight");
                }}
              />
              {errors.pureWeight ? (
                <p className="mt-1 text-xs text-destructive">
                  {errors.pureWeight}
                </p>
              ) : null}
            </div>
          </div>

          {/* Diamond / stone details */}
          <div className="grid grid-cols-3 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="dia-count">Diamond count</Label>
              <Input
                id="dia-count"
                type="number"
                min={0}
                placeholder="e.g. 12"
                value={diamondPieces}
                aria-invalid={!!errors.diamondPieces}
                onChange={(e) => {
                  setDiamondPieces(e.target.value);
                  clearError("diamondPieces");
                }}
              />
              {errors.diamondPieces ? (
                <p className="mt-1 text-xs text-destructive">
                  {errors.diamondPieces}
                </p>
              ) : null}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="dia-wt">Diamond wt (ct)</Label>
              <Input
                id="dia-wt"
                type="number"
                min={0}
                step="0.01"
                placeholder="e.g. 1.05"
                value={diamondWeightCt}
                aria-invalid={!!errors.diamondWeightCt}
                onChange={(e) => {
                  setDiamondWeightCt(e.target.value);
                  clearError("diamondWeightCt");
                }}
              />
              {errors.diamondWeightCt ? (
                <p className="mt-1 text-xs text-destructive">
                  {errors.diamondWeightCt}
                </p>
              ) : null}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="stone-wt">Stone wt (ct)</Label>
              <Input
                id="stone-wt"
                type="number"
                min={0}
                step="0.01"
                placeholder="e.g. 0.50"
                value={stoneWeightCt}
                aria-invalid={!!errors.stoneWeightCt}
                onChange={(e) => {
                  setStoneWeightCt(e.target.value);
                  clearError("stoneWeightCt");
                }}
              />
              {errors.stoneWeightCt ? (
                <p className="mt-1 text-xs text-destructive">
                  {errors.stoneWeightCt}
                </p>
              ) : null}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="tag">Tag price (₹)</Label>
              <Input
                id="tag"
                type="number"
                min={0}
                placeholder="e.g. 185000"
                value={tagPrice}
                aria-invalid={!!errors.tagPrice}
                onChange={(e) => {
                  setTagPrice(e.target.value);
                  clearError("tagPrice");
                }}
              />
              {errors.tagPrice ? (
                <p className="mt-1 text-xs text-destructive">
                  {errors.tagPrice}
                </p>
              ) : null}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="mrp">MRP (₹)</Label>
              <Input
                id="mrp"
                type="number"
                min={0}
                placeholder="e.g. 199000"
                value={mrp}
                aria-invalid={!!errors.mrp}
                onChange={(e) => {
                  setMrp(e.target.value);
                  clearError("mrp");
                }}
              />
              {errors.mrp ? (
                <p className="mt-1 text-xs text-destructive">{errors.mrp}</p>
              ) : null}
            </div>
          </div>

          {/* Hallmarking / certification */}
          <div className="grid gap-1.5">
            <Label htmlFor="huid">HUID (BIS Hallmark Unique ID)</Label>
            <Input
              id="huid"
              placeholder="e.g. AZ4567"
              value={huid}
              onChange={(e) => setHuid(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="hallmark">Hallmark no.</Label>
              <Input
                id="hallmark"
                value={hallmarkNo}
                onChange={(e) => setHallmarkNo(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="cert">Certificate no.</Label>
              <Input
                id="cert"
                value={certificateNo}
                onChange={(e) => setCertificateNo(e.target.value)}
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={save}
            disabled={createStock.isPending || needsStore}
          >
            {createStock.isPending ? "Saving…" : "Add to stock"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Adjust Status — a mandatory reason (which maps to the new status server-side)
 * and an optional note. Cross-store moves are NOT done here (that's the Stock
 * Transfer workflow). A piece's photo comes from Gati (synced), not uploaded here.
 */
function StockAdjustDialog({
  item,
  onOpenChange,
}: {
  item: StockItem | null;
  onOpenChange: (open: boolean) => void;
}) {
  const adjust = useAdjustStock();
  const [reason, setReason] = useState<AdjustReason | "">("");
  const [note, setNote] = useState("");

  function save() {
    if (!item) return;
    if (!reason) {
      toast.error("Choose a reason for this change.");
      return;
    }
    adjust.mutate(
      {
        id: item.id,
        reason,
        note: note.trim() || undefined,
      },
      {
        onSuccess: () => {
          toast.success("Stock updated");
          onOpenChange(false);
        },
        onError: (err) =>
          toast.error(
            apiErrorMessage(err, "Could not update the stock item. Please try again."),
          ),
      },
    );
  }

  return (
    <Dialog open={!!item} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Update Status</DialogTitle>
          <DialogDescription>
            {item ? (
              <>
                {item.name} · {item.sku} — {item.storeName}
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="adjust-reason">
              Reason <span className="text-destructive">*</span>
            </Label>
            <Select
              value={reason}
              onValueChange={(v) => setReason(v as AdjustReason)}
            >
              <SelectTrigger id="adjust-reason" aria-invalid={!reason}>
                <SelectValue placeholder="Select a reason…" />
              </SelectTrigger>
              <SelectContent>
                {ADJUST_REASON_OPTIONS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="adjust-note">Note</Label>
            <Textarea
              id="adjust-note"
              placeholder="e.g. Reserved for Priya Sharma, or flagged for melting"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={adjust.isPending || !reason}>
            {adjust.isPending ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Apply one reason/status to every selected piece (POST /stock/bulk-adjust). */
function BulkAdjustDialog({
  open,
  ids,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  ids: string[];
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const bulk = useBulkAdjustStock();
  const [reason, setReason] = useState<AdjustReason | "">("");
  const [note, setNote] = useState("");

  function save() {
    if (!reason) {
      toast.error("Choose a reason for this change.");
      return;
    }
    bulk.mutate(
      { ids, reason, note: note.trim() || undefined },
      {
        onSuccess: (res) => {
          toast.success(`${res.updated} piece(s) updated`);
          onOpenChange(false);
          onDone();
        },
        onError: (err) =>
          toast.error(
            apiErrorMessage(
              err,
              "Could not update the selected pieces. Reserved / in-transit pieces can't be bulk-adjusted.",
            ),
          ),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Bulk update status</DialogTitle>
          <DialogDescription>
            Applies to {ids.length} selected piece(s). A piece reserved by an
            active transfer will refuse the whole batch.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="bulk-reason">
              Reason <span className="text-destructive">*</span>
            </Label>
            <Select
              value={reason}
              onValueChange={(v) => setReason(v as AdjustReason)}
            >
              <SelectTrigger id="bulk-reason" aria-invalid={!reason}>
                <SelectValue placeholder="Select a reason…" />
              </SelectTrigger>
              <SelectContent>
                {ADJUST_REASON_OPTIONS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="bulk-note">Note</Label>
            <Textarea
              id="bulk-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={bulk.isPending || !reason}>
            {bulk.isPending ? "Applying…" : "Apply to selected"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Coerce a spreadsheet cell to a number, or undefined when blank/invalid. */
function cellNum(v: unknown): number | undefined {
  if (v === "" || v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Coerce a spreadsheet cell to a trimmed string, or undefined when blank. */
function cellStr(v: unknown): string | undefined {
  const s = String(v ?? "").trim();
  return s || undefined;
}

/**
 * Import from Excel — pick a concrete destination store, upload an .xlsx/.csv,
 * parse it client-side into rows and POST to /stock/bulk-import. The import is
 * all-or-nothing: a row-level error report comes back if anything is rejected.
 */
function ImportStockDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { isAggregate, targetStoreId, storeLabel, pickedStoreId, setPickedStoreId } =
    useStoreScope();
  const bulkImport = useBulkImportStock();
  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<ImportStockRow[]>([]);
  const [errors, setErrors] = useState<
    { row: number; sku: string; error: string }[]
  >([]);

  const needsStore = isAggregate && !targetStoreId;

  function downloadTemplate() {
    const sample = [
      "NK-22K-0001",
      "gold_22k",
      "Sample necklace",
      22,
      18.42,
      17.9,
      0,
      0,
      185000,
      "AZ4567",
      "HM-01",
      "CERT-01",
    ];
    const ws = XLSX.utils.aoa_to_sheet([[...IMPORT_COLUMNS], sample]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Template");
    XLSX.writeFile(wb, "stock-import-template.xlsx");
  }

  async function onFile(file: File | null) {
    if (!file) return;
    setFileName(file.name);
    setErrors([]);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, {
        defval: "",
      });
      const parsed: ImportStockRow[] = raw
        .map((r) => ({
          sku: cellStr(r.sku) ?? "",
          metal: (cellStr(r.metal) ?? "") as ImportStockRow["metal"],
          name: cellStr(r.name),
          karat: cellNum(r.karat),
          grossWeight: cellNum(r.grossWeight),
          netWeight: cellNum(r.netWeight),
          diamondPieces: cellNum(r.diamondPieces),
          diamondWeightCt: cellNum(r.diamondWeightCt),
          tagPrice: cellNum(r.tagPrice),
          huid: cellStr(r.huid),
          hallmarkNo: cellStr(r.hallmarkNo),
          certificateNo: cellStr(r.certificateNo),
        }))
        .filter((r) => r.sku || r.metal);
      setRows(parsed);
      if (parsed.length === 0) {
        toast.error("No rows found. Use the template's column headers.");
      }
    } catch {
      toast.error("Couldn't read that file — is it a valid .xlsx / .csv?");
      setRows([]);
    }
  }

  function submit() {
    if (!targetStoreId) {
      toast.error("Select a destination store.");
      return;
    }
    if (rows.length === 0) {
      toast.error("Upload a file with at least one row.");
      return;
    }
    setErrors([]);
    bulkImport.mutate(
      { storeId: targetStoreId, rows },
      {
        onSuccess: (res) => {
          if (res.errors.length > 0) {
            setErrors(res.errors);
            toast.error(
              `Import rejected — ${res.errors.length} row(s) need fixing. Nothing was imported.`,
            );
          } else {
            toast.success(`Imported ${res.imported} piece(s) to ${storeLabel}`);
            onOpenChange(false);
          }
        },
        onError: (err) =>
          toast.error(apiErrorMessage(err, "Import failed. Please try again.")),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import stock from Excel</DialogTitle>
          <DialogDescription>
            Upload an .xlsx / .csv to add many pieces to one store at once.
            All-or-nothing — a bad row blocks the whole file.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <StoreScopeField
            value={pickedStoreId}
            onChange={setPickedStoreId}
            label="Destination store"
          />
          {needsStore ? (
            <p className="text-xs text-destructive">
              Choose a specific store before importing.
            </p>
          ) : null}

          <div className="flex items-center justify-between gap-2">
            <Button variant="outline" size="sm" onClick={downloadTemplate}>
              <FileSpreadsheet className="h-4 w-4" />
              Download template
            </Button>
            <span className="text-xs text-muted-foreground">
              Columns: {IMPORT_COLUMNS.join(", ")}
            </span>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="import-file">Spreadsheet</Label>
            <input
              id="import-file"
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={(e) => onFile(e.target.files?.[0] ?? null)}
              className="text-sm"
            />
            {fileName ? (
              <p className="text-xs text-muted-foreground">
                {fileName} — <span className="num">{rows.length}</span> row(s)
                parsed
              </p>
            ) : null}
          </div>

          {errors.length > 0 ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3">
              <p className="mb-2 text-sm font-medium text-destructive">
                {errors.length} row(s) rejected — nothing was imported:
              </p>
              <ul className="max-h-40 space-y-1 overflow-y-auto text-xs">
                {errors.map((e, i) => (
                  <li key={i}>
                    Row {e.row} ({e.sku || "—"}): {e.error}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={bulkImport.isPending || needsStore || rows.length === 0}
          >
            {bulkImport.isPending
              ? "Importing…"
              : `Import ${rows.length || ""} row(s)`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Pieces sent for melting — the real ones, from the stock ledger.
 *
 * This replaced a hardcoded table of invented melt jobs with expected fine
 * weights and refinery stages, none of which exist anywhere in the system. The
 * refining workflow (approval, refinery hand-off, recovered weight) is genuinely
 * not modelled, so it is not shown; what IS recorded is which pieces were
 * adjusted to "melted" and what they weighed, and that is what appears.
 */
function MeltingTab() {
  const { data, isLoading, isError } = useStock({
    page: 1,
    pageSize: 50,
    status: "melted",
  });
  const rows = data?.items ?? [];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Flame className="h-4 w-4" />
          Sent for melting
        </CardTitle>
        <CardDescription>
          Pieces taken out of the ledger for melting or refining.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : isError ? (
          <EmptyState icon={Flame} title="Could not load melted stock" />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Flame}
            title="Nothing has been sent for melting"
            description="Adjust a piece's status to “Sent for melting” in the stock ledger and it will appear here."
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Store</TableHead>
                  <TableHead className="text-right">Gross</TableHead>
                  <TableHead className="text-right">Purity</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell>
                      <div className="font-medium">{m.name}</div>
                      <div className="text-xs text-muted-foreground">{m.sku}</div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{m.storeName}</TableCell>
                    <TableCell className="text-right">
                      <span className="num">{formatGrams(m.grossGrams, 1)}</span>
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="num">{formatPurity(m.karat)}</span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
