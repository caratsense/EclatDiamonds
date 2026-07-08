"use client";

import { useState } from "react";
import { MessageCircle } from "lucide-react";
import { toast } from "sonner";

import { QuoteBuilderDialog } from "@/components/quotation/quote-builder-dialog";
import { QuoteDetailDialog } from "@/components/quotation/quote-detail-dialog";
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
import { useQuotes } from "@/lib/queries/quotes";
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

      <QuoteDetailDialog quote={active} open={open} onOpenChange={setOpen} />
      <QuoteBuilderDialog open={newOpen} onOpenChange={setNewOpen} />
    </>
  );
}
