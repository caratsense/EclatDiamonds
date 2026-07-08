"use client";

import * as React from "react";
import { format, parseISO } from "date-fns";
import { Printer, Share2, Wallet } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatINR } from "@/lib/format";
import { PAYOUT_TYPE_LABELS, type PayoutType } from "@/lib/mock/loyalty";
import { useReferralWallet } from "@/lib/queries/loyalty";

/** Safe date (dd MMM yyyy); falls back to the raw value / em-dash. */
function longDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return format(parseISO(iso), "dd MMM yyyy");
  } catch {
    return iso;
  }
}

/** Redeem vs cash-out label for the wallet's payout rows. */
function payoutLabel(type: PayoutType): string {
  return type === "cashout" ? "Encash" : PAYOUT_TYPE_LABELS[type];
}

interface ReferralWalletDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  codeId: string | null;
}

/**
 * Module 17 — a referral code's full wallet.
 *
 * Prominent balance header, three totals tiles, a referrals (credits) table and
 * a redeemed (debits) table. Two manual-first actions: share a text summary on
 * WhatsApp, or print / save the wallet as a PDF (browser print of the formatted
 * `.print-wallet` section — no extra deps).
 */
export function ReferralWalletDialog({
  open,
  onOpenChange,
  codeId,
}: ReferralWalletDialogProps) {
  const { data: wallet, isLoading } = useReferralWallet(open ? codeId : null);

  function shareOnWhatsApp() {
    if (!wallet) return;
    const { code, totals, referrals } = wallet;
    const lines = [
      "Earn with Ratanlall — Referral wallet",
      `Referrer: ${code.referrerName} (${code.code})`,
      `Total wallet: ${formatINR(totals.totalWallet)}`,
      `Redeemed: ${formatINR(totals.redeemed)}`,
      `Wallet balance: ${formatINR(totals.balance)}`,
      `Referrals: ${referrals.length}`,
    ];
    const text = encodeURIComponent(lines.join("\n"));
    const digits = (code.referrerPhone ?? "").replace(/\D/g, "");
    const url = digits
      ? `https://wa.me/${digits}?text=${text}`
      : `https://wa.me/?text=${text}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        {isLoading || !wallet ? (
          <div className="space-y-3 py-2">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : (
          <>
            {/* Everything inside .print-wallet is what the print/PDF captures. */}
            <div className="print-wallet space-y-5">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Wallet className="h-4 w-4 text-gold-strong" />
                  {wallet.code.referrerName}
                </DialogTitle>
                <DialogDescription>
                  <span className="num">{wallet.code.code}</span>
                  {wallet.code.referrerPhone
                    ? ` · ${wallet.code.referrerPhone}`
                    : ""}
                </DialogDescription>
              </DialogHeader>

              {/* Prominent balance */}
              <div className="flex items-center justify-between rounded-xl border bg-[color-mix(in_srgb,var(--gold)_7%,transparent)] px-5 py-4">
                <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Wallet className="h-4 w-4" />
                  Wallet balance
                </span>
                <span className="num text-2xl font-semibold text-gold-strong">
                  {formatINR(wallet.totals.balance)}
                </span>
              </div>

              {/* Three totals tiles */}
              <div className="grid grid-cols-3 gap-3">
                <StatTile
                  label="Total wallet"
                  value={formatINR(wallet.totals.totalWallet)}
                />
                <StatTile
                  label="Redeemed"
                  value={formatINR(wallet.totals.redeemed)}
                />
                <StatTile
                  label="Wallet balance"
                  value={formatINR(wallet.totals.balance)}
                  emphasis
                />
              </div>

              {/* Referrals — credits */}
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">
                  Referrals ({wallet.referrals.length})
                </p>
                <div className="rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Customer</TableHead>
                        <TableHead>Date</TableHead>
                        <TableHead>Invoice No</TableHead>
                        <TableHead className="text-right">Bill amount</TableHead>
                        <TableHead className="text-right">Credit</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {wallet.referrals.map((r) => (
                        <TableRow key={r.id}>
                          <TableCell className="font-medium">
                            {r.refereeName}
                          </TableCell>
                          <TableCell className="num text-muted-foreground">
                            {longDate(r.billDate ?? r.createdAt)}
                          </TableCell>
                          <TableCell className="num text-muted-foreground">
                            {r.invoiceNo ?? "—"}
                          </TableCell>
                          <TableCell className="num text-right">
                            {formatINR(r.billAmount)}
                          </TableCell>
                          <TableCell className="num text-right font-medium text-gold-strong">
                            + {formatINR(r.commissionAmount)}
                          </TableCell>
                        </TableRow>
                      ))}
                      {wallet.referrals.length === 0 ? (
                        <TableRow>
                          <TableCell
                            colSpan={5}
                            className="py-6 text-center text-muted-foreground"
                          >
                            No referrals credited yet.
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </TableBody>
                  </Table>
                </div>
              </div>

              {/* Redeemed — debits */}
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">
                  Redeemed ({wallet.payouts.length})
                </p>
                <div className="rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Type</TableHead>
                        <TableHead>Date</TableHead>
                        <TableHead>Invoice No</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {wallet.payouts.map((p) => (
                        <TableRow key={p.id}>
                          <TableCell>
                            <Badge variant="secondary">
                              {payoutLabel(p.type)}
                            </Badge>
                          </TableCell>
                          <TableCell className="num text-muted-foreground">
                            {longDate(p.createdAt)}
                          </TableCell>
                          <TableCell className="num text-muted-foreground">
                            {p.invoiceNo ?? "—"}
                          </TableCell>
                          <TableCell className="num text-right font-medium">
                            − {formatINR(p.amount)}
                          </TableCell>
                        </TableRow>
                      ))}
                      {wallet.payouts.length === 0 ? (
                        <TableRow>
                          <TableCell
                            colSpan={4}
                            className="py-6 text-center text-muted-foreground"
                          >
                            Nothing redeemed yet.
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </div>

            {/* Actions — excluded from print via .no-print. */}
            <div className="no-print flex flex-col gap-2 sm:flex-row sm:justify-end">
              <Button variant="outline" onClick={shareOnWhatsApp}>
                <Share2 className="h-4 w-4" />
                Share on WhatsApp
              </Button>
              <Button variant="gold" onClick={() => window.print()}>
                <Printer className="h-4 w-4" />
                Print / Save PDF
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function StatTile({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p
        className={
          emphasis
            ? "num mt-1 text-lg font-semibold text-gold-strong"
            : "num mt-1 text-lg font-semibold"
        }
      >
        {value}
      </p>
    </div>
  );
}
