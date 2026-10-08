"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, MessageCircle } from "lucide-react";
import { toast } from "sonner";

import { QuoteDetailDialog } from "@/components/quotation/quote-detail-dialog";
import { ExcelExportButton } from "@/components/common/excel-export-button";
import { SectionHeader } from "@/components/section/section-header";
import { OrdersTimelineView } from "@/components/timelines/orders-timeline-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { api } from "@/lib/api";
import { apiErrorMessage } from "@/lib/utils";
import { QuoteApprovalsCard } from "@/components/quotation/quote-approvals-card";

const nav = getNavItem("quotation")!;

const STATUS_VARIANT: Record<
  QuoteStatus,
  "default" | "secondary" | "success" | "outline" | "destructive"
> = {
  draft: "outline",
  shared: "secondary",
  accepted: "success",
  expired: "destructive",
  pending_approval: "outline",
  approved: "success",
  rejected: "destructive",
};

export default function QuotationPage() {
  const { currentStore, stores, role } = useSession();
  // Kaccha ("@") estimates are HO-only. The toggle is gated on the session role;
  // non-HO users never see it and the server never returns kaccha rows to them.
  const isHeadOffice = role === "head_office";
  const [showKaccha, setShowKaccha] = useState(false);
  const includeKaccha = isHeadOffice && showKaccha;
  // Quotes come live + portability-scoped server-side (origin or redeemable).
  const {
    data: scoped = [],
    isLoading,
    isError,
    refetch,
  } = useQuotes({ includeKaccha });
  const [active, setActive] = useState<Quote | null>(null);
  const [open, setOpen] = useState(false);
  const router = useRouter();

  function storeName(id: string) {
    return stores.find((s) => s.id === id)?.name ?? id;
  }

  function openQuote(q: Quote) {
    setActive(q);
    setOpen(true);
  }

  // A screen of its own: with two or three items the form is long.
  const openBuilder = () => router.push("/quotation/new");

  /*
   * The row's WhatsApp action sends the DETAILED PDF, queued through the
   * branch's own business line — not a text summary, and never a wa.me link.
   * The old fallback opened web WhatsApp on whatever account the terminal had
   * logged in, with the price as prefilled text: it could not attach the
   * document, and it read as the feature being broken. A refusal here is
   * final — the approval gate's no must never be worked around by hand.
   */
  async function handleSendQuoteWhatsApp(e: React.MouseEvent, q: Quote) {
    e.stopPropagation();
    try {
      const { data } = await api.post<{ queued: boolean; dryRun: boolean }>(
        `/quotes/${q.id}/send-pdf`,
        {},
      );
      if (data.dryRun) {
        toast.warning("WhatsApp is not connected yet — the PDF will not be delivered.", {
          description: "Open the quote and use Download PDF to share it another way.",
        });
      } else {
        toast.success(`Quote ${q.ref} PDF queued for WhatsApp`, {
          description: `${q.customer} · ${q.phone}`,
        });
      }
    } catch (err) {
      toast.error(apiErrorMessage(err, "The quote could not be sent."));
    }
  }

  return (
    <>
      <SectionHeader
        title={nav.title}
        purpose={nav.purpose}
        primaryAction={nav.primaryAction}
        onPrimaryAction={openBuilder}
      />

      <Tabs defaultValue="quotes" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TabsList>
          <TabsTrigger value="quotes">Quotes</TabsTrigger>
          <TabsTrigger value="orders">Custom Orders &amp; Timeline</TabsTrigger>
        </TabsList>
          <ExcelExportButton path="/quotes/export.xlsx" fallbackName="quotations.xlsx" />
        </div>

        <TabsContent value="quotes" className="space-y-4">
          <QuoteApprovalsCard />

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              {currentStore.isAggregate
                ? "Showing quotes across all stores"
                : `Showing quotes raised at or portable to ${currentStore.name}`}
            </p>
            {isHeadOffice ? (
              <label className="flex cursor-pointer select-none items-center gap-2 text-sm">
                <span className="text-muted-foreground">
                  Show kaccha estimates
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={showKaccha}
                  aria-label="Show kaccha estimates"
                  onClick={() => setShowKaccha((v) => !v)}
                  className={
                    "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring " +
                    (showKaccha ? "bg-primary" : "bg-input")
                  }
                >
                  <span
                    className={
                      "inline-block h-5 w-5 transform rounded-full bg-background shadow-sm transition-transform " +
                      (showKaccha ? "translate-x-5" : "translate-x-0.5")
                    }
                  />
                </button>
              </label>
            ) : null}
          </div>

          {!isLoading && !isError && scoped.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="No quotes yet"
              description="Create a quote or a custom order to share with a customer."
              actionLabel="New Quote"
              onAction={openBuilder}
            />
          ) : (
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
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      {q.customer}
                      {q.isKaccha ? (
                        <Badge variant="outline" className="text-[10px]">
                          Kaccha
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
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
                      className="text-emerald-600 hover:text-emerald-700 hover:bg-emerald-500/10"
                      title="Send Quotation on WhatsApp"
                      onClick={(e) => handleSendQuoteWhatsApp(e, q)}
                    >
                      <MessageCircle className="h-4 w-4 fill-emerald-600/20" />
                      <span className="sr-only">Share on WhatsApp</span>
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
            </Table>
          </div>
          )}
        </TabsContent>

        <TabsContent value="orders">
          <OrdersTimelineView />
        </TabsContent>
      </Tabs>

      {/* The live row, not the snapshot taken when the dialog opened — otherwise
          requesting or deciding approval leaves the dialog showing the old status. */}
      <QuoteDetailDialog
        quote={scoped.find((q) => q.id === active?.id) ?? active}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
