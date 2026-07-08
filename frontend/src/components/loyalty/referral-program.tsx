"use client";

import * as React from "react";
import {
  Check,
  Copy,
  Gem,
  HandCoins,
  Plus,
  Share2,
  Ticket,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatINR, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  isCapReached,
  REFERRAL_COMMISSION_PCT,
  REFERRAL_DIAMOND_DISCOUNT_PCT,
  type ReferralCode,
} from "@/lib/mock/loyalty";
import { useReferralCodes, useReferrals } from "@/lib/queries/loyalty";
import { ApplyReferralDialog } from "./apply-referral-dialog";
import { CreateReferralCodeDialog } from "./create-referral-code-dialog";
import { PayoutDialog } from "./payout-dialog";
import { ReferralWalletDialog } from "./referral-wallet-dialog";

/** Copy-to-clipboard button with a brief "copied" confirmation. */
function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(value);
        setCopied(true);
        toast.success("Code copied");
        window.setTimeout(() => setCopied(false), 1400);
      }}
      className="text-muted-foreground transition-colors hover:text-foreground"
      aria-label={`Copy code ${value}`}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-emerald-600" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

/**
 * Module 17 — "Earn with Ratanlall" referral / commission program.
 *
 * Referrer X gets a coupon code; referee Y gets 5% off diamond; X earns 5%
 * commission on Y's total bill, redeemable or cashable. Codes can be
 * usage-capped. This panel lists codes (with copy + cap state), lets a manager
 * apply a code at a sale, and drills into a code's commission ledger + payout.
 */
export function ReferralProgram() {
  const { data: codes = [], isLoading, isError } = useReferralCodes();

  const [createOpen, setCreateOpen] = React.useState(false);
  const [applyOpen, setApplyOpen] = React.useState(false);
  const [applyCode, setApplyCode] = React.useState<string | undefined>();
  const [payoutOpen, setPayoutOpen] = React.useState(false);
  const [payoutCode, setPayoutCode] = React.useState<ReferralCode | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [walletOpen, setWalletOpen] = React.useState(false);
  const [walletCodeId, setWalletCodeId] = React.useState<string | null>(null);

  // Keep the selected code in sync with the freshest server data.
  const selected =
    codes.find((c) => c.id === selectedId) ?? codes[0] ?? null;
  const { data: referrals = [], isLoading: ledgerLoading } = useReferrals(
    selected?.id ?? null,
  );

  const totalOutstanding = codes.reduce(
    (sum, c) => sum + c.commissionBalance,
    0,
  );

  function openApply(code?: string) {
    setApplyCode(code);
    setApplyOpen(true);
  }

  function openPayout(code: ReferralCode) {
    setPayoutCode(code);
    setPayoutOpen(true);
  }

  function openWallet(codeId: string) {
    setWalletCodeId(codeId);
    setWalletOpen(true);
  }

  return (
    <div className="space-y-4">
      {/* Intro + actions */}
      <Card className="overflow-hidden">
        <CardContent className="flex flex-col gap-4 py-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--gold)_14%,transparent)] text-gold-strong">
              <Ticket className="h-5 w-5" />
            </span>
            <div className="space-y-1">
              <h3 className="font-display text-lg font-medium leading-tight">
                Earn with Ratanlall
              </h3>
              <p className="max-w-xl text-sm text-muted-foreground">
                Referrer earns{" "}
                <span className="font-medium text-foreground">
                  {REFERRAL_COMMISSION_PCT}% commission
                </span>{" "}
                on every referred bill; their referrals get{" "}
                <span className="font-medium text-foreground">
                  {REFERRAL_DIAMOND_DISCOUNT_PCT}% off diamond
                </span>
                . Cap a code to stop it being shared endlessly.
              </p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button variant="outline" onClick={() => openApply()}>
              <Gem className="h-4 w-4" />
              Apply a referral
            </Button>
            <Button variant="gold" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              Create code
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-5">
        {/* Codes list */}
        <Card className="lg:col-span-3">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div className="space-y-1.5">
              <CardTitle>Referral codes</CardTitle>
              <CardDescription>
                {codes.length} code{codes.length === 1 ? "" : "s"} ·{" "}
                {formatINR(totalOutstanding)} commission outstanding
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-11 w-full" />
                ))}
              </div>
            ) : isError ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-muted-foreground">
                Could not load referral codes. Check your connection and try
                again.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Code</TableHead>
                    <TableHead>Referrer</TableHead>
                    <TableHead className="text-center">Uses</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                    <TableHead className="w-px" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {codes.map((c) => {
                    const capped = isCapReached(c);
                    const isActive = selected?.id === c.id;
                    return (
                      <TableRow
                        key={c.id}
                        onClick={() => setSelectedId(c.id)}
                        className={cn(
                          "cursor-pointer",
                          isActive && "bg-muted/50",
                        )}
                      >
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              className="num font-medium underline-offset-2 hover:underline"
                              onClick={(e) => {
                                e.stopPropagation();
                                openWallet(c.id);
                              }}
                              title="Open wallet"
                            >
                              {c.code}
                            </button>
                            <CopyButton value={c.code} />
                          </div>
                        </TableCell>
                        <TableCell>
                          <div>{c.referrerName}</div>
                          {c.referrerPhone ? (
                            <div className="text-xs text-muted-foreground">
                              {c.referrerPhone}
                            </div>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-center">
                          {capped ? (
                            <Badge variant="destructive">Cap reached</Badge>
                          ) : (
                            <span className="num text-sm">
                              {c.uses}
                              <span className="text-muted-foreground">
                                {" / "}
                                {c.maxUses ?? "∞"}
                              </span>
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <span className="num font-medium">
                            {formatINR(c.commissionBalance)}
                          </span>
                        </TableCell>
                        <TableCell
                          className="text-right"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openWallet(c.id)}
                            >
                              <Wallet className="h-3.5 w-3.5" />
                              Wallet
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={capped}
                              onClick={() => openApply(c.code)}
                            >
                              <Share2 className="h-3.5 w-3.5" />
                              Apply
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {codes.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="py-10 text-center text-muted-foreground"
                      >
                        No referral codes yet — create the first one above.
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Commission ledger + payout for the selected code */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Commission ledger</CardTitle>
            <CardDescription>
              {selected
                ? `${selected.referrerName} · ${selected.code}`
                : "Select a code to see its referrals."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {selected ? (
              <>
                <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-4 py-3">
                  <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <Wallet className="h-4 w-4" />
                    Balance
                  </span>
                  <span className="num text-lg font-semibold text-gold-strong">
                    {formatINR(selected.commissionBalance)}
                  </span>
                </div>

                <Button
                  variant="gold"
                  className="w-full"
                  disabled={selected.commissionBalance <= 0}
                  onClick={() => openPayout(selected)}
                >
                  <HandCoins className="h-4 w-4" />
                  Redeem / cash out
                </Button>

                <div className="space-y-2">
                  <div className="text-xs font-medium text-muted-foreground">
                    Referrals ({referrals.length})
                  </div>
                  {ledgerLoading ? (
                    <div className="space-y-2">
                      {Array.from({ length: 3 }).map((_, i) => (
                        <Skeleton key={i} className="h-12 w-full" />
                      ))}
                    </div>
                  ) : referrals.length === 0 ? (
                    <p className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                      No referrals redeemed on this code yet.
                    </p>
                  ) : (
                    <ul className="divide-y rounded-lg border">
                      {referrals.map((r) => (
                        <li
                          key={r.id}
                          className="flex items-center justify-between gap-2 px-3 py-2.5 text-sm"
                        >
                          <div className="min-w-0">
                            <div className="truncate font-medium">
                              {r.refereeName}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              Bill{" "}
                              <span className="num">
                                {formatINR(r.billAmount)}
                              </span>{" "}
                              · {formatPercent(r.diamondDiscountPct)} diamond off
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="num font-medium text-gold-strong">
                              + {formatINR(r.commissionAmount)}
                            </div>
                            <div className="text-[11px] text-muted-foreground">
                              commission
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            ) : (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No code selected.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <CreateReferralCodeDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
      />
      <ApplyReferralDialog
        open={applyOpen}
        onOpenChange={setApplyOpen}
        initialCode={applyCode}
      />
      <PayoutDialog
        open={payoutOpen}
        onOpenChange={setPayoutOpen}
        code={payoutCode}
      />
      <ReferralWalletDialog
        open={walletOpen}
        onOpenChange={setWalletOpen}
        codeId={walletCodeId}
      />
    </div>
  );
}
