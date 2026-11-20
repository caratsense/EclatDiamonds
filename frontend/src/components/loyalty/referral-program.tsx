"use client";

import * as React from "react";
import {
  Gift,
  HandCoins,
  Plus,
  Receipt,
  UserRound,
  Wallet,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { formatINR } from "@/lib/format";
import { ROLE_RANK } from "@/lib/types";
import { useSession } from "@/store/use-session";
import {
  isCapReached,
  REFERRAL_COMMISSION_PCT,
  type ReferralCode,
} from "@/lib/mock/loyalty";
import { useReferralCodes } from "@/lib/queries/loyalty";
import { ApplyReferralDialog } from "./apply-referral-dialog";
import { CreateReferralCodeDialog } from "./create-referral-code-dialog";
import { PayoutDialog } from "./payout-dialog";
import { ReferralWalletDialog } from "./referral-wallet-dialog";

/**
 * Module 17 — Referral Accounts (reworked per client, 9 Oct 2026).
 *
 * A referrer is an existing customer with an ACCOUNT, identified by name/phone —
 * no coupon code to hand out. Each referred purchase recorded against the
 * account credits {@link REFERRAL_COMMISSION_PCT}% of the bill into its wallet;
 * credit is redeemed against a later purchase from the wallet. The wallet's own
 * history (purchases + redemptions) is the record — there is no separate
 * commission-ledger view. Accounts created under the old code workflow remain
 * listed and usable; their code shows as a muted legacy detail.
 */
export function ReferralProgram() {
  const { data: accounts = [], isLoading, isError } = useReferralCodes();
  const role = useSession((s) => s.role);
  // Creating accounts and redeeming credit both require store_manager+.
  const canManageReferrals = ROLE_RANK[role] >= ROLE_RANK.store_manager;

  const [createOpen, setCreateOpen] = React.useState(false);
  const [recordOpen, setRecordOpen] = React.useState(false);
  const [recordReferrerId, setRecordReferrerId] = React.useState<string | undefined>();
  const [payoutOpen, setPayoutOpen] = React.useState(false);
  const [payoutAccount, setPayoutAccount] = React.useState<ReferralCode | null>(null);
  const [walletOpen, setWalletOpen] = React.useState(false);
  const [walletAccountId, setWalletAccountId] = React.useState<string | null>(null);

  const totalOutstanding = accounts.reduce(
    (sum, c) => sum + c.commissionBalance,
    0,
  );

  function openRecord(referrerId?: string) {
    setRecordReferrerId(referrerId);
    setRecordOpen(true);
  }

  function openPayout(account: ReferralCode) {
    setPayoutAccount(account);
    setPayoutOpen(true);
  }

  function openWallet(accountId: string) {
    setWalletAccountId(accountId);
    setWalletOpen(true);
  }

  return (
    <div className="space-y-4">
      {/* Intro + actions */}
      <Card className="overflow-hidden">
        <CardContent className="flex flex-col gap-4 py-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--gold)_14%,transparent)] text-gold-strong">
              <UserRound className="h-5 w-5" />
            </span>
            <div className="space-y-1">
              <h3 className="font-display text-lg font-bold leading-tight">
                Referral Accounts
              </h3>
              <p className="max-w-xl text-sm text-muted-foreground">
                A referrer earns{" "}
                <span className="font-medium text-foreground">
                  {REFERRAL_COMMISSION_PCT}% credit
                </span>{" "}
                on every referred purchase, accumulated in their wallet and
                redeemable against a later bill. Referrers are identified by
                name and phone — no code needed.
              </p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button variant="outline" onClick={() => openRecord()}>
              <Receipt className="h-4 w-4" />
              Record purchase
            </Button>
            {canManageReferrals ? (
              <Button variant="gold" onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4" />
                New referrer account
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {/* Accounts list — the wallet (opened per row) is the transaction record. */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle>Referrer accounts</CardTitle>
            <CardDescription>
              {accounts.length} account{accounts.length === 1 ? "" : "s"} ·{" "}
              {formatINR(totalOutstanding)} credit outstanding
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
              Could not load referrer accounts. Check your connection and try
              again.
            </div>
          ) : accounts.length === 0 ? (
            <EmptyState
              icon={Gift}
              title="No referrer accounts yet"
              description="Open an account for an existing customer so every purchase they refer credits their wallet."
              actionLabel={canManageReferrals ? "New referrer account" : undefined}
              onAction={canManageReferrals ? () => setCreateOpen(true) : undefined}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Referrer</TableHead>
                  <TableHead className="text-center">Referrals</TableHead>
                  <TableHead className="text-right">Wallet balance</TableHead>
                  <TableHead className="w-px" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.map((c) => {
                  const capped = isCapReached(c);
                  return (
                    <TableRow
                      key={c.id}
                      onClick={() => openWallet(c.id)}
                      className="cursor-pointer"
                    >
                      <TableCell>
                        <div className="font-medium">{c.referrerName}</div>
                        <div className="text-xs text-muted-foreground">
                          {[c.referrerPhone || null, c.code ? `Code ${c.code}` : null]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                      </TableCell>
                      <TableCell className="text-center">
                        {capped ? (
                          <Badge variant="destructive">Cap reached</Badge>
                        ) : (
                          <span className="num text-sm">{c.uses}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <span className="num font-medium text-gold-strong">
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
                            onClick={() => openRecord(c.id)}
                          >
                            <Receipt className="h-3.5 w-3.5" />
                            Record
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={!canManageReferrals || c.commissionBalance <= 0}
                            onClick={() => openPayout(c)}
                          >
                            <HandCoins className="h-3.5 w-3.5" />
                            Redeem
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <CreateReferralCodeDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
      />
      <ApplyReferralDialog
        open={recordOpen}
        onOpenChange={setRecordOpen}
        initialReferrerId={recordReferrerId}
      />
      <PayoutDialog
        open={payoutOpen}
        onOpenChange={setPayoutOpen}
        code={payoutAccount}
      />
      <ReferralWalletDialog
        open={walletOpen}
        onOpenChange={setWalletOpen}
        codeId={walletAccountId}
      />
    </div>
  );
}
