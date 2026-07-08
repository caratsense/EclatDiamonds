"use client";

import { MessageCircle, Store as StoreIcon, Wrench } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { assetUrl } from "@/lib/api";
import {
  formatCarats,
  formatGrams,
  formatINR,
  formatPercent,
  formatPurity,
} from "@/lib/format";
import {
  computeQuoteTotals,
  GST_RATE,
  lineMetalValue,
  lineSubtotal,
  QUOTE_KIND_LABELS,
  QUOTE_STATUS_LABELS,
  type Quote,
} from "@/lib/mock/quotation";
import { useSession } from "@/store/use-session";

interface QuoteDetailDialogProps {
  quote: Quote | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Read-only view of an existing quote — the pricing breakdown, portability, any
 * reference photos, and a WhatsApp share action. Creation lives in
 * {@link QuoteBuilderDialog}.
 */
export function QuoteDetailDialog({
  quote,
  open,
  onOpenChange,
}: QuoteDetailDialogProps) {
  const { stores, currentStore } = useSession();
  if (!quote) return null;

  const isRepair = quote.kind === "repair";
  const totals = computeQuoteTotals(quote);
  const photos = quote.photos ?? [];
  const originName =
    stores.find((s) => s.id === quote.originStoreId)?.name ?? quote.originStoreId;
  const redeemNames = quote.redeemableStoreIds.map(
    (id) => stores.find((s) => s.id === id)?.name ?? id,
  );
  // Cross-store portability: the quote can be opened/checked out here even
  // though it was raised elsewhere.
  const portableHere =
    !currentStore.isAggregate &&
    currentStore.id !== quote.originStoreId &&
    quote.redeemableStoreIds.includes(currentStore.id);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <div className="flex items-center justify-between gap-2 pr-6">
            <DialogTitle className="flex items-center gap-2">
              {quote.ref}
              {isRepair ? (
                <Badge variant="outline">
                  <Wrench className="mr-1 h-3 w-3" />
                  {QUOTE_KIND_LABELS.repair}
                </Badge>
              ) : (
                <Badge variant="gold">{QUOTE_KIND_LABELS.sale}</Badge>
              )}
            </DialogTitle>
            <Badge variant="secondary">
              {QUOTE_STATUS_LABELS[quote.status]}
            </Badge>
          </div>
          <DialogDescription>
            {quote.customer} · raised at {originName} · valid till{" "}
            {quote.validUntil}
          </DialogDescription>
        </DialogHeader>

        {portableHere ? (
          <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 p-2.5 text-xs">
            <StoreIcon className="h-4 w-4 text-primary" />
            <span>
              Portable quote — raised at {originName}, retrievable and
              checkout-able here at {currentStore.name}.
            </span>
          </div>
        ) : null}

        {isRepair && quote.grossWeightG != null ? (
          <div className="rounded-lg border bg-muted/30 p-3 text-sm">
            <span className="text-muted-foreground">Gross weight in: </span>
            <span className="num font-medium">
              {formatGrams(quote.grossWeightG, 2)}
            </span>
          </div>
        ) : null}

        {/* Line items + pricing breakdown */}
        <div className="space-y-4">
          {quote.lines.map((line) => (
            <div key={line.id} className="rounded-lg border p-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">{line.description}</p>
                {line.karat > 0 ? (
                  <Badge variant="outline">
                    <span className="num">{formatPurity(line.karat)}</span>
                  </Badge>
                ) : null}
              </div>
              <dl className="mt-2 space-y-1 text-sm">
                {line.weightGrams > 0 ? (
                  <Row
                    label={
                      <>
                        Gold{" "}
                        <span className="num">
                          {formatGrams(line.weightGrams, 2)}
                        </span>{" "}
                        ×{" "}
                        <span className="num">
                          {formatINR(line.goldRatePerGram)}
                        </span>
                        /g
                      </>
                    }
                    value={formatINR(lineMetalValue(line))}
                  />
                ) : null}
                {line.makingCharges > 0 ? (
                  <Row
                    label="Making charges"
                    value={formatINR(line.makingCharges)}
                  />
                ) : null}
                {line.stoneCharges > 0 ? (
                  <Row
                    label={
                      <>
                        Diamond / stones
                        {line.caratWeight > 0 ? (
                          <>
                            {" ("}
                            <span className="num">
                              {formatCarats(line.caratWeight)}
                            </span>
                            {")"}
                          </>
                        ) : null}
                      </>
                    }
                    value={formatINR(line.stoneCharges)}
                  />
                ) : null}
                <Separator className="my-1" />
                <Row
                  label="Line subtotal"
                  value={formatINR(lineSubtotal(line))}
                  bold
                />
              </dl>
            </div>
          ))}
        </div>

        {quote.remarks ? (
          <div className="rounded-lg border bg-muted/30 p-3">
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              Remarks
            </p>
            <p className="text-sm">{quote.remarks}</p>
          </div>
        ) : null}

        {photos.length > 0 ? (
          <div>
            <p className="mb-1.5 text-xs text-muted-foreground">
              Reference photos
            </p>
            <div className="flex flex-wrap gap-2">
              {photos.map((p) => (
                <a
                  key={p.id}
                  href={assetUrl(p.url)}
                  target="_blank"
                  rel="noreferrer"
                  className="block h-20 w-20 overflow-hidden rounded-md border bg-muted/30"
                  title={p.label || "Reference"}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={assetUrl(p.url)}
                    alt={p.label || "Reference photo"}
                    className="h-full w-full object-cover"
                  />
                </a>
              ))}
            </div>
          </div>
        ) : null}

        {/* Quote totals */}
        <div className="rounded-lg bg-muted/50 p-3">
          <dl className="space-y-1 text-sm">
            {!isRepair ? (
              <>
                <Row label="Metal value" value={formatINR(totals.metalValue)} />
                <Row
                  label="Making charges"
                  value={formatINR(totals.makingCharges)}
                />
                <Row label="Diamond / stones" value={formatINR(totals.stoneCharges)} />
              </>
            ) : (
              <Row
                label="Making / labour"
                value={formatINR(totals.makingCharges)}
              />
            )}
            <Separator className="my-1" />
            <Row label="Taxable value" value={formatINR(totals.taxable)} />
            <Row
              label={
                <>
                  GST @{" "}
                  <span className="num">{formatPercent(GST_RATE * 100, 0)}</span>
                </>
              }
              value={formatINR(totals.gst)}
            />
            <Separator className="my-1" />
            <Row
              label="Grand total"
              value={formatINR(totals.grandTotal)}
              bold
            />
          </dl>
        </div>

        <div>
          <p className="mb-1.5 text-xs text-muted-foreground">Redeemable at</p>
          <div className="flex flex-wrap gap-1.5">
            {redeemNames.map((n) => (
              <Badge key={n} variant="outline">
                {n}
              </Badge>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() =>
              toast.success("Quote shared on WhatsApp (mock)", {
                description: `${quote.ref} sent to ${quote.customer} · ${quote.phone}`,
              })
            }
          >
            <MessageCircle className="h-4 w-4" />
            Share on WhatsApp
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({
  label,
  value,
  bold,
}: {
  label: React.ReactNode;
  value: string;
  bold?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <dt className={bold ? "font-medium" : "text-muted-foreground"}>
        {label}
      </dt>
      <dd className={bold ? "num font-semibold" : "num"}>{value}</dd>
    </div>
  );
}
