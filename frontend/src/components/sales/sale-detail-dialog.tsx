"use client";

import { toast } from "sonner";

import { SaleDocThumbs } from "@/components/sales/sale-doc-thumbs";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { formatINR } from "@/lib/format";
import { saleModeLabel, saleModeVariant, type SaleDocType } from "@/lib/mock/sales";
import { useSaleDetail, useUploadSaleDoc } from "@/lib/queries/sales";

function prettyDate(iso?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

interface SaleDetailDialogProps {
  saleId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Read view of a direct sale: the advance vs total split, its three counter
 * photos (with the option to upload any that are still missing), and the
 * payment history returned by GET /sales/:id.
 */
export function SaleDetailDialog({
  saleId,
  open,
  onOpenChange,
}: SaleDetailDialogProps) {
  const { data: sale, isLoading, isError } = useSaleDetail(open ? saleId : null);
  const uploadDoc = useUploadSaleDoc();

  function onUpload(doc: SaleDocType, file: File) {
    if (!saleId) return;
    if (file.size > 8 * 1024 * 1024) {
      toast.error("Image is too large — please keep it under 8 MB.");
      return;
    }
    uploadDoc.mutate(
      { id: saleId, doc, file },
      {
        onSuccess: () => toast.success("Photo uploaded"),
        onError: () => toast.error("Could not upload the photo."),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : isError || !sale ? (
          <>
            <DialogHeader>
              <DialogTitle>Sale</DialogTitle>
              <DialogDescription>
                Could not load this sale. Check your connection and try again.
              </DialogDescription>
            </DialogHeader>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {sale.customer}
                {sale.paymentMode ? (
                  <Badge variant={saleModeVariant(sale.paymentMode)}>
                    {saleModeLabel(sale.paymentMode)}
                  </Badge>
                ) : null}
              </DialogTitle>
              <DialogDescription>
                {sale.docNo} · Invoice {sale.invoiceNo} · {prettyDate(sale.docDate)}
                {sale.description ? ` · ${sale.description}` : ""}
              </DialogDescription>
            </DialogHeader>

            {/* Advance vs total */}
            <div className="grid grid-cols-2 gap-3 rounded-lg border bg-muted/30 p-3 text-center sm:grid-cols-4">
              <Figure label="Sales" value={sale.salesValue} />
              <Figure label="Billed" value={sale.afterDiscountValue} />
              <Figure label="Advance" value={sale.advanceReceived} tone="emerald" />
              <Figure label="Balance" value={sale.balance} tone="amber" />
            </div>

            <Separator />

            {/* Counter photos */}
            <div className="space-y-2">
              <p className="text-sm font-medium">Documents</p>
              <SaleDocThumbs
                sale={sale}
                variant="grid"
                onUpload={onUpload}
                uploadingDoc={
                  uploadDoc.isPending
                    ? (uploadDoc.variables?.doc ?? null)
                    : null
                }
              />
            </div>

            <Separator />

            {/* Payment history */}
            <div className="space-y-2">
              <p className="text-sm font-medium">Payments</p>
              {sale.payments && sale.payments.length > 0 ? (
                <ul className="divide-y rounded-lg border">
                  {sale.payments.map((p) => (
                    <li
                      key={p.id}
                      className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                    >
                      <div className="min-w-0">
                        <span className="font-medium">
                          {saleModeLabel(p.mode)}
                        </span>
                        {p.reference ? (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {p.reference}
                          </span>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-muted-foreground">
                          {prettyDate(p.date)}
                        </span>
                        <span className="num font-medium">
                          {formatINR(p.amount)}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="rounded-lg border border-dashed py-4 text-center text-xs text-muted-foreground">
                  No payments recorded against this sale yet.
                </p>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Figure({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "emerald" | "amber";
}) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p
        className={
          tone === "emerald"
            ? "num mt-0.5 text-sm font-semibold text-success"
            : tone === "amber" && value > 0
              ? "num mt-0.5 text-sm font-semibold text-warning"
              : "num mt-0.5 text-sm font-semibold"
        }
      >
        {formatINR(value)}
      </p>
    </div>
  );
}
