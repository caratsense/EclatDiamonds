"use client";

import { useState } from "react";
import { CheckCircle2, CircleHelp, Clock } from "lucide-react";
import { toast } from "sonner";

import { SectionHeader } from "@/components/section/section-header";
import { ModeChart } from "@/components/payments/mode-chart";
import { SalesSection } from "@/components/sales/sales-section";
import { DirectSaleDialog } from "@/components/sales/direct-sale-dialog";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatINR } from "@/lib/format";
import {
  usePayments,
  usePaymentReconciliation,
  useRecordPayment,
  type PaymentMode,
} from "@/lib/queries/payments";
import { useSession } from "@/store/use-session";

const MODE_OPTIONS: { value: PaymentMode; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "upi", label: "UPI" },
  { value: "net_banking", label: "Net Banking" },
  { value: "online", label: "Online" },
  { value: "cheque", label: "Cheque" },
  { value: "gold_exchange", label: "Gold Exchange" },
];

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type BadgeVariant = "secondary" | "default" | "outline" | "success";

const MODE_VARIANT: Record<string, BadgeVariant> = {
  Cash: "secondary",
  Card: "default",
  UPI: "success",
  "Net Banking": "outline",
  Online: "outline",
};

/** Unknown / extra modes (Cheque, Gold Exchange, …) fall back to a neutral chip. */
function modeVariant(mode: string): BadgeVariant {
  return MODE_VARIANT[mode] ?? "outline";
}

const RECON_VARIANT: Record<string, "success" | "destructive" | "secondary"> = {
  Matched: "success",
  Unmatched: "destructive",
  Pending: "secondary",
};

export default function PaymentsPage() {
  const { currentStore } = useSession();
  const [addOpen, setAddOpen] = useState(false);
  const [saleOpen, setSaleOpen] = useState(false);

  // Collections + reconciliation come live from the API, store-scoped
  // server-side via X-Store-Id (no client-side store filtering needed).
  const paymentsQuery = usePayments();
  const reconQuery = usePaymentReconciliation();

  const ledger = paymentsQuery.data ?? [];
  const recon = reconQuery.data ?? [];

  const total = ledger.reduce((s, c) => s + c.amount, 0);

  // Mode breakdown for the donut is derived from the live collections.
  const modeBreakdown = Object.values(
    ledger.reduce<Record<string, { mode: string; amount: number }>>(
      (acc, c) => {
        acc[c.mode] = acc[c.mode] ?? { mode: c.mode, amount: 0 };
        acc[c.mode].amount += c.amount;
        return acc;
      },
      {},
    ),
  );

  const matched = recon.filter((r) => r.status === "Matched").length;
  const unmatched = recon.filter((r) => r.status === "Unmatched").length;
  const pending = recon.filter((r) => r.status === "Pending").length;

  return (
    <>
      <SectionHeader
        title="Sales & Payments"
        purpose="Record sales with advance and balance, and track collections and bank reconciliation."
        primaryAction="New Sale"
        onPrimaryAction={() => setSaleOpen(true)}
      />

      <Tabs defaultValue="sales">
        <TabsList>
          <TabsTrigger value="sales">Sales</TabsTrigger>
          <TabsTrigger value="ledger">Collections</TabsTrigger>
          <TabsTrigger value="recon">Reconciliation</TabsTrigger>
        </TabsList>

        <TabsContent value="sales" className="space-y-4">
          <SalesSection />
        </TabsContent>

        <TabsContent value="ledger" className="space-y-4">
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
              Record payment
            </Button>
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Collections ledger</CardTitle>
                <CardDescription>
                  Receipts across all collection channels for{" "}
                  {currentStore.name}.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Customer</TableHead>
                      <TableHead>Ref</TableHead>
                      <TableHead>Mode</TableHead>
                      <TableHead>Store</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paymentsQuery.isLoading ? (
                      Array.from({ length: 6 }).map((_, i) => (
                        <TableRow key={i}>
                          <TableCell colSpan={6}>
                            <Skeleton className="h-5 w-full" />
                          </TableCell>
                        </TableRow>
                      ))
                    ) : paymentsQuery.isError ? (
                      <TableRow>
                        <TableCell colSpan={6} className="py-10 text-center">
                          <div className="mx-auto max-w-sm rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-muted-foreground">
                            Couldn&apos;t load collections. Check your connection
                            and try again.
                          </div>
                        </TableCell>
                      </TableRow>
                    ) : ledger.length === 0 ? (
                      <TableRow>
                        <TableCell
                          colSpan={6}
                          className="py-10 text-center text-sm text-muted-foreground"
                        >
                          No payments yet. Record a payment to begin.
                        </TableCell>
                      </TableRow>
                    ) : (
                      ledger.map((c) => (
                        <TableRow key={c.id}>
                          <TableCell className="whitespace-nowrap text-muted-foreground">
                            {formatTime(c.date)}
                          </TableCell>
                          <TableCell className="font-medium">
                            {c.customer}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {c.ref}
                          </TableCell>
                          <TableCell>
                            <Badge variant={modeVariant(c.mode)}>{c.mode}</Badge>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {c.storeName}
                          </TableCell>
                          <TableCell className="text-right font-medium">
                            <span className="num">{formatINR(c.amount)}</span>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                  <TableFooter>
                    <TableRow>
                      <TableCell colSpan={5}>Total collected</TableCell>
                      <TableCell className="text-right">
                        <span className="num">{formatINR(total)}</span>
                      </TableCell>
                    </TableRow>
                  </TableFooter>
                </Table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Mode breakdown</CardTitle>
                <CardDescription>
                  Collections by channel for {currentStore.name}.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {paymentsQuery.isLoading ? (
                  <Skeleton className="h-[240px] rounded-xl" />
                ) : (
                  <ModeChart data={modeBreakdown} />
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="recon" className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Reconciliation — matching card and bank payouts to your recorded
            sales.
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            <Card>
              <CardContent className="flex items-center gap-3 py-4">
                <CheckCircle2 className="h-5 w-5 text-success" />
                <div>
                  <p className="num text-2xl font-semibold">{matched}</p>
                  <p className="text-xs text-muted-foreground">Matched</p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="flex items-center gap-3 py-4">
                <CircleHelp className="h-5 w-5 text-destructive" />
                <div>
                  <p className="num text-2xl font-semibold">{unmatched}</p>
                  <p className="text-xs text-muted-foreground">Unmatched</p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="flex items-center gap-3 py-4">
                <Clock className="h-5 w-5 text-muted-foreground" />
                <div>
                  <p className="num text-2xl font-semibold">{pending}</p>
                  <p className="text-xs text-muted-foreground">Pending settle</p>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                Store-reported vs bank statement
              </CardTitle>
              <CardDescription>
                Variances between store-reported and bank figures, flagged for review.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Store</TableHead>
                    <TableHead>Mode</TableHead>
                    <TableHead className="text-right">Store reported</TableHead>
                    <TableHead className="text-right">Bank statement</TableHead>
                    <TableHead className="text-right">Variance</TableHead>
                    <TableHead className="text-right">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {reconQuery.isLoading ? (
                    Array.from({ length: 5 }).map((_, i) => (
                      <TableRow key={i}>
                        <TableCell colSpan={7}>
                          <Skeleton className="h-5 w-full" />
                        </TableCell>
                      </TableRow>
                    ))
                  ) : reconQuery.isError ? (
                    <TableRow>
                      <TableCell colSpan={7} className="py-10 text-center">
                        <div className="mx-auto max-w-sm rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-muted-foreground">
                          Couldn&apos;t load reconciliation. Check your connection
                          and try again.
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : recon.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={7}
                        className="py-10 text-center text-sm text-muted-foreground"
                      >
                        Nothing to reconcile yet. Entries appear once collections post.
                      </TableCell>
                    </TableRow>
                  ) : (
                    recon.map((r) => {
                    const variance =
                      r.bankStatement === undefined
                        ? undefined
                        : r.bankStatement - r.storeReported;
                    return (
                      <TableRow
                        key={r.id}
                        className={
                          r.status === "Unmatched" ? "bg-destructive/5" : undefined
                        }
                      >
                        <TableCell className="text-muted-foreground">
                          {new Date(r.date).toLocaleDateString("en-IN", {
                            day: "2-digit",
                            month: "short",
                          })}
                        </TableCell>
                        <TableCell>{r.storeName}</TableCell>
                        <TableCell>
                          <Badge variant={modeVariant(r.mode)}>{r.mode}</Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <span className="num">{formatINR(r.storeReported)}</span>
                        </TableCell>
                        <TableCell className="text-right">
                          {r.bankStatement === undefined ? (
                            "—"
                          ) : (
                            <span className="num">
                              {formatINR(r.bankStatement)}
                            </span>
                          )}
                        </TableCell>
                        <TableCell
                          className={
                            variance && variance !== 0
                              ? "text-right font-medium text-destructive"
                              : "text-right text-muted-foreground"
                          }
                        >
                          {variance === undefined ? (
                            "—"
                          ) : (
                            <span className="num">
                              {variance === 0
                                ? formatINR(0)
                                : formatINR(variance)}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <Badge variant={RECON_VARIANT[r.status]}>
                            {r.status}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    );
                    })
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <AddPaymentDialog open={addOpen} onOpenChange={setAddOpen} />
      <DirectSaleDialog open={saleOpen} onOpenChange={setSaleOpen} />
    </>
  );
}

function AddPaymentDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { currentStore } = useSession();
  const recordPayment = useRecordPayment();
  const [customer, setCustomer] = useState("");
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<PaymentMode>("cash");
  const [reference, setReference] = useState("");

  // Aggregate ("all") scope has no concrete store to write to — fall back
  // to the first real store id; broad roles normally pick a store first.
  const targetStoreId = currentStore.isAggregate ? "surat-main" : currentStore.id;

  function save() {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      toast.error("Enter a valid amount.");
      return;
    }
    // Customer name is captured into the reference line when no party is linked.
    const ref =
      reference.trim() || (customer.trim() ? customer.trim() : undefined);
    recordPayment.mutate(
      {
        storeId: targetStoreId,
        amount: value,
        mode,
        reference: ref,
      },
      {
        onSuccess: () => {
          toast.success("Payment recorded");
          setCustomer("");
          setAmount("");
          setMode("cash");
          setReference("");
          onOpenChange(false);
        },
        onError: () => toast.error("Could not record payment."),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record payment</DialogTitle>
          <DialogDescription>
            Collections are recorded against{" "}
            {currentStore.isAggregate ? "Surat — Main" : currentStore.name}.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="pay-customer">Customer name</Label>
            <Input
              id="pay-customer"
              placeholder="e.g. Priya Sharma (optional)"
              value={customer}
              onChange={(e) => setCustomer(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="pay-amount">Amount</Label>
            <Input
              id="pay-amount"
              type="number"
              min={0}
              placeholder="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="pay-mode">Mode</Label>
            <Select
              value={mode}
              onValueChange={(v) => setMode(v as PaymentMode)}
            >
              <SelectTrigger id="pay-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODE_OPTIONS.map((m) => (
                  <SelectItem key={m.value} value={m.value}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="pay-ref">Reference</Label>
            <Input
              id="pay-ref"
              placeholder="e.g. UPI txn id, cheque no. (optional)"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={recordPayment.isPending}>
            {recordPayment.isPending ? "Saving…" : "Record payment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
