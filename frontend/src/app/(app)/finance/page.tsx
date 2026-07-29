"use client";

import { useState } from "react";
import { toast } from "sonner";

import { SectionHeader } from "@/components/section/section-header";
import { KpiCard } from "@/components/dashboards/kpi-card";
import { LedgerTable } from "@/components/finance/ledger-table";
import { ExpansionCards } from "@/components/finance/expansion-cards";
import {
  BudgetVarianceChart,
  CashFlowChart,
} from "@/components/finance/finance-charts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
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
import { getNavItem } from "@/lib/navigation";
import {
  useAddLedgerEntry,
  useFinanceBudget,
  useFinanceCashflow,
  useFinanceLedger,
  useFinanceSummary,
  type LedgerKind,
} from "@/lib/queries/finance";
import { useSession } from "@/store/use-session";
import { apiErrorMessage } from "@/lib/utils";

export default function FinancePage() {
  const item = getNavItem("finance");
  const [addOpen, setAddOpen] = useState(false);

  // All four cards/charts/tables come live from the API, store-scoped.
  const summaryQuery = useFinanceSummary();
  const budgetQuery = useFinanceBudget();
  const cashflowQuery = useFinanceCashflow();
  const ledgerQuery = useFinanceLedger();

  const summary = summaryQuery.data ?? [];
  const budget = budgetQuery.data ?? [];
  const cashflow = cashflowQuery.data ?? [];
  const ledger = ledgerQuery.data ?? [];

  const hasError =
    summaryQuery.isError ||
    budgetQuery.isError ||
    cashflowQuery.isError ||
    ledgerQuery.isError;

  return (
    <>
      <SectionHeader
        title={item?.title ?? "Finance & Fund Planning"}
        purpose={item?.purpose ?? ""}
        primaryAction={item?.primaryAction}
        onPrimaryAction={() => setAddOpen(true)}
      />

      {hasError ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-muted-foreground">
          Couldn&apos;t load finance data. Check your connection and try again.
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {summaryQuery.isLoading
          ? Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-28 rounded-xl" />
            ))
          : summary.map((c) => (
              <KpiCard
                key={c.id}
                label={c.label}
                value={c.value}
                format="inr"
                delta={c.delta}
                invertDelta={c.invertDelta}
              />
            ))}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {budgetQuery.isLoading || cashflowQuery.isLoading ? (
          <>
            <Skeleton className="h-[360px] rounded-xl" />
            <Skeleton className="h-[360px] rounded-xl" />
          </>
        ) : (
          <>
            <BudgetVarianceChart data={budget} />
            <CashFlowChart data={cashflow} />
          </>
        )}
      </div>

      <div className="mt-4">
        <LedgerTable data={ledger} isLoading={ledgerQuery.isLoading} />
      </div>

      <div className="mt-8 space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">
          Expansion Pipeline
        </h2>
        <ExpansionCards />
      </div>

      <AddEntryDialog open={addOpen} onOpenChange={setAddOpen} />
    </>
  );
}

const ENTRY_KINDS: { value: LedgerKind; label: string }[] = [
  { value: "AR", label: "AR (Receivable)" },
  { value: "AP", label: "AP (Payable)" },
  { value: "expense", label: "Expense" },
  { value: "income", label: "Income" },
];

/**
 * Status is two unrelated axes gated by kind:
 *  - AR / AP  → settlement state of the receivable/payable.
 *  - expense / income → plan type (realized vs. planned figure).
 * Gating the options keeps a manager from booking, say, an AR as "budget".
 */
const SETTLEMENT_STATUSES: { value: string; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "partial", label: "Partially settled" },
  { value: "cleared", label: "Cleared" },
  { value: "overdue", label: "Overdue" },
];

const PLAN_STATUSES: { value: string; label: string }[] = [
  { value: "actual", label: "Actual" },
  { value: "budget", label: "Budget" },
  { value: "forecast", label: "Forecast" },
];

const isSettlementKind = (kind: LedgerKind) => kind === "AR" || kind === "AP";

const statusOptionsForKind = (kind: LedgerKind) =>
  isSettlementKind(kind) ? SETTLEMENT_STATUSES : PLAN_STATUSES;

const defaultStatusForKind = (kind: LedgerKind) =>
  isSettlementKind(kind) ? "open" : "actual";

/**
 * Ledger side is derived from the kind so the entry books on the correct
 * column without asking the manager to reason about debits/credits:
 * money coming in (AR / income) is a credit; money going out (AP / expense)
 * is a debit. The service sums `amount` for income/expense regardless of
 * side, so this only affects how AR/AP rows render in the ledger.
 */
function sideForKind(kind: LedgerKind): "debit" | "credit" {
  return kind === "AR" || kind === "income" ? "credit" : "debit";
}

function AddEntryDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { currentStore } = useSession();
  const addEntry = useAddLedgerEntry();
  const [kind, setKind] = useState<LedgerKind>("AR");
  const [status, setStatus] = useState(() => defaultStatusForKind("AR"));
  const [amount, setAmount] = useState("");

  // Switching kind resets the status to a sensible default for the new axis
  // (settlement vs. plan type) so an invalid combination can't be submitted.
  function changeKind(next: LedgerKind) {
    setKind(next);
    setStatus(defaultStatusForKind(next));
  }
  const [entryDate, setEntryDate] = useState("");
  const [narration, setNarration] = useState("");

  // Aggregate ("all") scope has no concrete store to write to — fall back
  // to the first real store id; broad roles normally pick a store first.
  const targetStoreId = currentStore.isAggregate ? "surat-main" : currentStore.id;

  function reset() {
    setKind("AR");
    setStatus(defaultStatusForKind("AR"));
    setAmount("");
    setEntryDate("");
    setNarration("");
  }

  function save() {
    const value = Number(amount);
    if (!amount.trim() || Number.isNaN(value) || value < 0) {
      toast.error("Enter a valid amount.");
      return;
    }
    addEntry.mutate(
      {
        storeId: targetStoreId,
        kind,
        side: sideForKind(kind),
        amount: value,
        status,
        entryDate: entryDate || undefined,
        narration: narration.trim() || undefined,
      },
      {
        onSuccess: () => {
          toast.success("Ledger entry recorded");
          reset();
          onOpenChange(false);
        },
        onError: (err) => toast.error(apiErrorMessage(err, "Could not save ledger entry.")),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add ledger entry</DialogTitle>
          <DialogDescription>
            Book a ledger, budget or forecast row against{" "}
            {currentStore.isAggregate ? "Surat — Main" : currentStore.name}.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="kind">Kind</Label>
              <Select
                value={kind}
                onValueChange={(v) => changeKind(v as LedgerKind)}
              >
                <SelectTrigger id="kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ENTRY_KINDS.map((k) => (
                    <SelectItem key={k.value} value={k.value}>
                      {k.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="status">
                {isSettlementKind(kind) ? "Settlement status" : "Plan type"}
              </Label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger id="status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {statusOptionsForKind(kind).map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="amount">Amount (₹)</Label>
              <Input
                id="amount"
                type="number"
                min={0}
                placeholder="e.g. 250000"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="entry-date">Date</Label>
              <Input
                id="entry-date"
                type="date"
                value={entryDate}
                onChange={(e) => setEntryDate(e.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="narration">Narration</Label>
            <Input
              id="narration"
              placeholder="e.g. Rentals, Salaries, New Store, Sales — Bridal"
              value={narration}
              onChange={(e) => setNarration(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={addEntry.isPending}>
            {addEntry.isPending ? "Saving…" : "Save entry"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
