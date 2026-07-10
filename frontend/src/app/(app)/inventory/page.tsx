"use client";

import { useState } from "react";
import { ArrowRight, Flame, PackageX, ShoppingCart } from "lucide-react";
import { toast } from "sonner";

import { SectionHeader } from "@/components/section/section-header";
import { AgingChart } from "@/components/inventory/aging-chart";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatGrams, formatINR, formatPurity } from "@/lib/format";
import { METAL_LABELS, type Metal } from "@/lib/mock/catalogue";
import {
  DEAD_STOCK_THRESHOLD_DAYS,
  MOCK_AGING_DISTRIBUTION,
  MOCK_MELT_JOBS,
  MOCK_REORDER_ALERTS,
  MOCK_ROTATION_SUGGESTIONS,
  type MeltStage,
  type StockStatus,
} from "@/lib/mock/inventory";
import { useCreateStock, useStock } from "@/lib/queries/stock";
import { useSession } from "@/store/use-session";

const STATUS_VARIANT: Record<
  StockStatus,
  "secondary" | "success" | "destructive" | "outline"
> = {
  "In stock": "success",
  Aging: "secondary",
  "Dead stock": "destructive",
  Reserved: "outline",
};

const MELT_VARIANT: Record<MeltStage, "outline" | "secondary" | "default" | "success"> = {
  Flagged: "outline",
  Approved: "secondary",
  "At refinery": "default",
  Recovered: "success",
};

export default function InventoryPage() {
  // Stock ledger comes live + store-scoped from the API.
  const { data: rows = [], isLoading, isError, refetch } = useStock();
  const [addOpen, setAddOpen] = useState(false);

  const deadCount = rows.filter(
    (s) => s.ageDays > DEAD_STOCK_THRESHOLD_DAYS,
  ).length;

  return (
    <>
      <SectionHeader
        title="Inventory & Stock"
        purpose="Inventory optimization, aging-stock control and scrap recycling."
        primaryAction="Stock Entry"
        onPrimaryAction={() => setAddOpen(true)}
      />

      <StockEntryDialog open={addOpen} onOpenChange={setAddOpen} />

      {/* Aging distribution + at-a-glance counters */}
      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Aging distribution</CardTitle>
            <CardDescription>
              Stock count by days-in-inventory bucket. Items past{" "}
              {DEAD_STOCK_THRESHOLD_DAYS} days are treated as dead stock.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AgingChart data={MOCK_AGING_DISTRIBUTION} />
          </CardContent>
        </Card>

        <div className="grid gap-4">
          <Card>
            <CardContent className="flex items-center gap-3 py-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                <PackageX className="h-5 w-5" />
              </div>
              <div>
                <p className="num text-2xl font-semibold">{deadCount}</p>
                <p className="text-xs text-muted-foreground">
                  Dead-stock items (&gt;{DEAD_STOCK_THRESHOLD_DAYS}d)
                </p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center gap-3 py-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-warning/10 text-warning">
                <ShoppingCart className="h-5 w-5" />
              </div>
              <div>
                <p className="num text-2xl font-semibold">
                  {MOCK_REORDER_ALERTS.length}
                </p>
                <p className="text-xs text-muted-foreground">
                  Auto-reorder alerts
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

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
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Item</TableHead>
                    <TableHead>Store</TableHead>
                    <TableHead>Purity</TableHead>
                    <TableHead className="text-right">Weight</TableHead>
                    <TableHead className="text-right">Tag price</TableHead>
                    <TableHead className="text-right">Age</TableHead>
                    <TableHead className="text-right">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    <TableRow>
                      <TableCell colSpan={7} className="py-6">
                        <Skeleton className="h-24 w-full" />
                      </TableCell>
                    </TableRow>
                  ) : isError ? (
                    <TableRow>
                      <TableCell colSpan={7} className="py-10">
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
                        colSpan={7}
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
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* TODO: wire to backend — rotation, melt & reorder stay on mock
            (no endpoints yet). The Stock tab above is live via GET /stock. */}
        <TabsContent value="rotation">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                Stock rotation suggestions
              </CardTitle>
              <CardDescription>
                Move slow-moving stock to higher-demand stores by regional
                demand.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {MOCK_ROTATION_SUGGESTIONS.map((r) => (
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
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>{r.fromStore}</span>
                      <ArrowRight className="h-3.5 w-3.5" />
                      <span className="font-medium text-foreground">
                        {r.toStore}
                      </span>
                      <Badge variant="secondary">
                        <span className="num">{r.ageDays}d</span> idle
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">{r.reason}</p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() => toast.success(`Transfer raised for ${r.sku}`)}
                  >
                    Raise transfer
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="melt">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Flame className="h-4 w-4" />
                Melting &amp; scrap workflow
              </CardTitle>
              <CardDescription>
                Items melted / refined into recoverable raw metal.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Item</TableHead>
                    <TableHead>Store</TableHead>
                    <TableHead className="text-right">Gross</TableHead>
                    <TableHead className="text-right">Expected fine</TableHead>
                    <TableHead className="text-right">Stage</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {MOCK_MELT_JOBS.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell>
                        <div className="font-medium">{m.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {m.sku}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {m.storeName}
                      </TableCell>
                      <TableCell className="text-right">
                        <span className="num">{formatGrams(m.grossGrams, 1)}</span>
                      </TableCell>
                      <TableCell className="text-right">
                        <span className="num">
                          {formatGrams(m.expectedFineGrams, 1)}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        <Badge variant={MELT_VARIANT[m.stage]}>{m.stage}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="reorder">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Auto-reorder alerts</CardTitle>
              <CardDescription>
                On-hand below threshold — recommended purchase-order quantities.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Item</TableHead>
                    <TableHead>Store</TableHead>
                    <TableHead className="text-right">On hand</TableHead>
                    <TableHead className="text-right">Threshold</TableHead>
                    <TableHead className="text-right">Recommended PO</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {MOCK_REORDER_ALERTS.map((a) => (
                    <TableRow key={a.id} className="bg-warning/5">
                      <TableCell>
                        <div className="font-medium">{a.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {a.sku}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {a.storeName}
                      </TableCell>
                      <TableCell className="text-right font-medium text-destructive">
                        <span className="num">{a.onHand}</span>
                      </TableCell>
                      <TableCell className="text-right">
                        <span className="num">{a.threshold}</span>
                      </TableCell>
                      <TableCell className="text-right font-semibold">
                        <span className="num">{a.recommendedQty}</span>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            toast.success(`PO drafted: ${a.recommendedQty} × ${a.sku}`)
                          }
                        >
                          Create PO
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </>
  );
}

function StockEntryDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { currentStore } = useSession();
  const createStock = useCreateStock();
  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [metal, setMetal] = useState<Metal>("gold_22k");
  const [karat, setKarat] = useState("");
  const [grossWeight, setGrossWeight] = useState("");
  const [tagPrice, setTagPrice] = useState("");

  // Aggregate ("all") scope has no concrete store to write to — fall back
  // to the first real store id; broad roles normally pick a store first.
  const targetStoreId = currentStore.isAggregate ? "surat-main" : currentStore.id;

  function save() {
    if (!sku.trim()) {
      toast.error("SKU / tag number is required.");
      return;
    }
    const karatNum = karat.trim() ? Number(karat) : undefined;
    const grossNum = grossWeight.trim() ? Number(grossWeight) : undefined;
    const tagNum = tagPrice.trim() ? Number(tagPrice) : undefined;
    createStock.mutate(
      {
        storeId: targetStoreId,
        sku: sku.trim(),
        name: name.trim() || undefined,
        metal,
        karat: karatNum,
        grossWeight: grossNum,
        tagPrice: tagNum,
      },
      {
        onSuccess: () => {
          toast.success("Stock item added");
          setSku("");
          setName("");
          setMetal("gold_22k");
          setKarat("");
          setGrossWeight("");
          setTagPrice("");
          onOpenChange(false);
        },
        onError: () => toast.error("Could not add stock item."),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Stock entry</DialogTitle>
          <DialogDescription>
            New pieces are added to{" "}
            {currentStore.isAggregate ? "Surat — Main" : currentStore.name}.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="sku">SKU / tag number</Label>
            <Input
              id="sku"
              placeholder="e.g. NK-22K-0142"
              value={sku}
              onChange={(e) => setSku(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              placeholder="e.g. Antique bridal necklace"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="metal">Metal</Label>
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
                onChange={(e) => setKarat(e.target.value)}
              />
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
                onChange={(e) => setGrossWeight(e.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="tag">Tag price (₹)</Label>
            <Input
              id="tag"
              type="number"
              min={0}
              placeholder="e.g. 185000"
              value={tagPrice}
              onChange={(e) => setTagPrice(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={createStock.isPending}>
            {createStock.isPending ? "Saving…" : "Add to stock"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
