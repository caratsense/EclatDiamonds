"use client";

import { useState } from "react";
import { Receipt } from "lucide-react";

import { SaleDetailDialog } from "@/components/sales/sale-detail-dialog";
import { SaleDocThumbs } from "@/components/sales/sale-doc-thumbs";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatINR } from "@/lib/format";
import { saleModeLabel, saleModeVariant } from "@/lib/mock/sales";
import { useSales, type SaleScope } from "@/lib/queries/sales";
import { useSession } from "@/store/use-session";

function prettyDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
  });
}

/**
 * Direct-sales list (client call § "Sales (Direct Sales)"). Shows each sale's
 * advance vs balance split, its payment-mode chip and thumbnails/links to the
 * quotation / invoice / receipt photos. A row opens the sale detail.
 */
export function SalesSection() {
  const { currentStore } = useSession();
  // "all", not "manual". Manual means a sale typed into Eclat by hand, and on a
  // deployment fed by the shop's own system there are none — so the tab opened
  // empty while 145 real bills for that branch sat one click away, which reads
  // as "the sync did not work".
  const [scope, setScope] = useState<SaleScope>("all");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const salesQuery = useSales(scope);
  const sales = salesQuery.data ?? [];

  const totalBilled = sales.reduce((s, r) => s + r.afterDiscountValue, 0);
  const totalBalance = sales.reduce((s, r) => s + r.balance, 0);

  function openSale(id: string) {
    setActiveId(id);
    setDetailOpen(true);
  }

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3 pb-2">
          <div className="space-y-1">
            <CardTitle className="text-base">Direct sales</CardTitle>
            <CardDescription>
              Sales recorded for {currentStore.name}, with advance vs balance
              and counter photos.
            </CardDescription>
          </div>
          <Tabs value={scope} onValueChange={(v) => setScope(v as SaleScope)}>
            <TabsList>
              <TabsTrigger value="manual">Direct</TabsTrigger>
              <TabsTrigger value="all">All</TabsTrigger>
            </TabsList>
          </Tabs>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Invoice #</TableHead>
                  <TableHead className="text-right">Item value</TableHead>
                  <TableHead className="text-right">Invoice total</TableHead>
                  <TableHead className="text-right">Advance</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                  <TableHead>Mode</TableHead>
                  <TableHead>Docs</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {salesQuery.isLoading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell colSpan={9}>
                        <Skeleton className="h-5 w-full" />
                      </TableCell>
                    </TableRow>
                  ))
                ) : salesQuery.isError ? (
                  <TableRow>
                    <TableCell colSpan={9} className="py-10 text-center">
                      <div className="mx-auto max-w-sm rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-muted-foreground">
                        Could not load sales. Check your connection and try
                        again.
                      </div>
                    </TableCell>
                  </TableRow>
                ) : sales.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="py-6">
                      <EmptyState
                        icon={Receipt}
                        title="No sales yet"
                        description="Record a direct sale to capture the advance vs balance split and counter photos."
                      />
                    </TableCell>
                  </TableRow>
                ) : (
                  sales.map((sale) => (
                    <TableRow
                      key={sale.id}
                      className="cursor-pointer"
                      onClick={() => openSale(sale.id)}
                    >
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {prettyDate(sale.docDate)}
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{sale.customer}</div>
                        {sale.description ? (
                          <div className="max-w-[16rem] truncate text-xs text-muted-foreground">
                            {sale.description}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {sale.invoiceNo}
                      </TableCell>
                      <TableCell className="text-right">
                        <span className="num">{formatINR(sale.salesValue)}</span>
                      </TableCell>
                      <TableCell className="text-right">
                        <span className="num">
                          {formatINR(sale.afterDiscountValue)}
                        </span>
                      </TableCell>
                      <TableCell className="text-right text-success">
                        <span className="num">
                          {formatINR(sale.advanceReceived)}
                        </span>
                      </TableCell>
                      <TableCell
                        className={
                          sale.balance > 0
                            ? "text-right font-medium text-warning"
                            : "text-right text-muted-foreground"
                        }
                      >
                        <span className="num">{formatINR(sale.balance)}</span>
                      </TableCell>
                      <TableCell>
                        {sale.paymentMode ? (
                          <Badge variant={saleModeVariant(sale.paymentMode)}>
                            {saleModeLabel(sale.paymentMode)}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <SaleDocThumbs sale={sale} />
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
              {sales.length > 0 ? (
                <TableFooter>
                  <TableRow>
                    <TableCell colSpan={4}>Totals</TableCell>
                    <TableCell className="text-right">
                      <span className="num">{formatINR(totalBilled)}</span>
                    </TableCell>
                    <TableCell />
                    <TableCell className="text-right">
                      <span className="num">{formatINR(totalBalance)}</span>
                    </TableCell>
                    <TableCell colSpan={2} />
                  </TableRow>
                </TableFooter>
              ) : null}
            </Table>
          </div>
        </CardContent>
      </Card>

      <SaleDetailDialog
        saleId={activeId}
        open={detailOpen}
        onOpenChange={setDetailOpen}
      />
    </>
  );
}
