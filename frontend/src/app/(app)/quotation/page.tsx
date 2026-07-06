"use client";

import { useState } from "react";
import { MessageCircle } from "lucide-react";
import { toast } from "sonner";

import { QuoteBuilderDialog } from "@/components/quotation/quote-builder-dialog";
import { SectionHeader } from "@/components/section/section-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getNavItem } from "@/lib/navigation";
import { formatINR } from "@/lib/format";
import {
  computeQuoteTotals,
  QUOTE_STATUS_LABELS,
  type Quote,
  type QuoteStatus,
} from "@/lib/mock/quotation";
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
import { useQuotes, useCreateQuote } from "@/lib/queries/quotes";
import { GOLD_RATE_PER_GRAM } from "@/lib/mock/quotation";
import { useSession } from "@/store/use-session";

const nav = getNavItem("quotation")!;

const STATUS_VARIANT: Record<
  QuoteStatus,
  "default" | "secondary" | "success" | "outline" | "destructive"
> = {
  draft: "outline",
  shared: "secondary",
  accepted: "success",
  expired: "destructive",
};

export default function QuotationPage() {
  const { currentStore, stores } = useSession();
  // Quotes come live + portability-scoped server-side (origin or redeemable).
  const { data: scoped = [], isLoading, isError, refetch } = useQuotes();
  const [active, setActive] = useState<Quote | null>(null);
  const [open, setOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);

  function storeName(id: string) {
    return stores.find((s) => s.id === id)?.name ?? id;
  }

  function openQuote(q: Quote) {
    setActive(q);
    setOpen(true);
  }

  return (
    <>
      <SectionHeader
        title={nav.title}
        purpose={nav.purpose}
        primaryAction={nav.primaryAction}
        onPrimaryAction={() => setNewOpen(true)}
      />

      <p className="mb-4 text-sm text-muted-foreground">
        {currentStore.isAggregate
          ? "Showing quotes across all stores"
          : `Showing quotes raised at or portable to ${currentStore.name}`}
      </p>

      <div className="rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Quote #</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Origin store</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={6} className="py-6">
                  <Skeleton className="h-24 w-full" />
                </TableCell>
              </TableRow>
            ) : isError ? (
              <TableRow>
                <TableCell colSpan={6} className="py-10">
                  <div className="mx-auto max-w-md rounded-lg border bg-muted/30 p-4 text-center">
                    <p className="text-sm font-medium">
                      Couldn&apos;t load quotes.
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      The connection may have dropped. Check your network and
                      try again.
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
            ) : scoped.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="py-10 text-center text-muted-foreground"
                >
                  No quotes yet — create the first one to share with a customer.
                </TableCell>
              </TableRow>
            ) : null}
            {scoped.map((q) => {
              const total = computeQuoteTotals(q).grandTotal;
              const portable =
                !currentStore.isAggregate &&
                q.originStoreId !== currentStore.id;
              return (
                <TableRow
                  key={q.id}
                  className="cursor-pointer"
                  onClick={() => openQuote(q)}
                >
                  <TableCell className="font-medium">
                    <span className="num">{q.ref}</span>
                  </TableCell>
                  <TableCell>{q.customer}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      {storeName(q.originStoreId)}
                      {portable ? (
                        <Badge variant="outline" className="text-[10px]">
                          Portable
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[q.status]}>
                      {QUOTE_STATUS_LABELS[q.status]}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    <span className="num">{formatINR(total)}</span>
                  </TableCell>
                  <TableCell
                    className="text-right"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        toast.success("Quote shared on WhatsApp (mock)", {
                          description: `${q.ref} sent to ${q.customer}`,
                        })
                      }
                    >
                      <MessageCircle className="h-4 w-4" />
                      <span className="sr-only">Share on WhatsApp</span>
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <QuoteBuilderDialog quote={active} open={open} onOpenChange={setOpen} />
      <NewQuoteDialog open={newOpen} onOpenChange={setNewOpen} />
    </>
  );
}

function NewQuoteDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { currentStore } = useSession();
  const createQuote = useCreateQuote();
  const [customer, setCustomer] = useState("");
  const [phone, setPhone] = useState("");
  const [description, setDescription] = useState("");
  const [karat, setKarat] = useState(22);
  const [weight, setWeight] = useState(10);
  const [making, setMaking] = useState(15000);

  const targetStoreId = currentStore.isAggregate ? "surat-main" : currentStore.id;

  function save() {
    if (!customer.trim() || !description.trim()) {
      toast.error("Customer and item description are required.");
      return;
    }
    createQuote.mutate(
      {
        storeId: targetStoreId,
        customerName: customer.trim(),
        phone: phone.trim() || undefined,
        lines: [
          {
            description: description.trim(),
            karat,
            weightGrams: weight,
            goldRatePerGram: GOLD_RATE_PER_GRAM[karat] ?? 7180,
            makingCharges: making,
            stoneCharges: 0,
            caratWeight: 0,
          },
        ],
      },
      {
        onSuccess: (q) => {
          toast.success(`Quote ${q.ref} created`);
          onOpenChange(false);
        },
        onError: () => toast.error("Could not create quote."),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New quote</DialogTitle>
          <DialogDescription>
            Raised at{" "}
            {currentStore.isAggregate ? "Surat — Main" : currentStore.name}.
            Gold rate is snapshotted from the active feed.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="q-cust">Customer name</Label>
            <Input
              id="q-cust"
              value={customer}
              onChange={(e) => setCustomer(e.target.value)}
              placeholder="e.g. Meera Iyer"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="q-phone">Phone</Label>
            <Input
              id="q-phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+91 ..."
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="q-desc">Item description</Label>
            <Input
              id="q-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. 22K gold chain"
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="q-karat">Karat</Label>
              <Input
                id="q-karat"
                type="number"
                value={karat}
                onChange={(e) => setKarat(Number(e.target.value) || 22)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="q-wt">Weight (g)</Label>
              <Input
                id="q-wt"
                type="number"
                value={weight}
                onChange={(e) => setWeight(Number(e.target.value) || 0)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="q-mk">Making (₹)</Label>
              <Input
                id="q-mk"
                type="number"
                value={making}
                onChange={(e) => setMaking(Number(e.target.value) || 0)}
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={createQuote.isPending}>
            {createQuote.isPending ? "Creating…" : "Create quote"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
