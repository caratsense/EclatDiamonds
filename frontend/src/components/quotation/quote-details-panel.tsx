"use client";

import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatINR } from "@/lib/format";
import {
  PAYMENT_MODES,
  type Quote,
  type QuoteBillTo,
  type QuotePayment,
} from "@/lib/mock/quotation";
import { useUpdateQuoteDetails } from "@/lib/queries/quotes";
import { apiErrorMessage } from "@/lib/utils";

/**
 * Address and payments on a saved quote — what goes in the Billed To box and
 * the Payment box of the PDF. Editing here never touches the price: the
 * revision and any manager approval stay as they are.
 */
export function QuoteDetailsPanel({ quote }: { quote: Quote }) {
  const save = useUpdateQuoteDetails();
  const [editing, setEditing] = useState(false);
  const [billTo, setBillTo] = useState<QuoteBillTo>({});
  const [payments, setPayments] = useState<QuotePayment[]>([]);

  const saved = quote.payments ?? [];
  const total = quote.totals?.grandTotal ?? 0;
  const rows = editing ? payments : saved;
  const received = rows.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);

  const startEdit = () => {
    setBillTo({ ...(quote.billTo ?? {}) });
    setPayments(saved.map((p) => ({ ...p })));
    setEditing(true);
  };
  const setPayment = (i: number, patch: Partial<QuotePayment>) =>
    setPayments((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  const onSave = () =>
    save.mutate(
      {
        id: quote.id,
        billTo: {
          address: billTo.address ?? "",
          state: billTo.state ?? "",
          gstin: (billTo.gstin ?? "").trim().toUpperCase(),
          pan: (billTo.pan ?? "").trim().toUpperCase(),
        },
        payments: payments.map((p) => ({
          mode: p.mode,
          amount: Number(p.amount),
          ...(p.reference?.trim() ? { reference: p.reference.trim() } : {}),
          ...(p.date ? { date: p.date } : {}),
        })),
      },
      {
        onSuccess: () => {
          toast.success(`${quote.ref}: address and payments saved`);
          setEditing(false);
        },
        onError: (e) => toast.error(apiErrorMessage(e, "Could not save the address and payments.")),
      },
    );

  const b = quote.billTo ?? {};
  const billLines = [b.address, b.state, b.gstin && `GSTIN ${b.gstin}`, b.pan && `PAN ${b.pan}`].filter(Boolean);

  return (
    <div className="rounded-lg border p-3 text-sm">
      <div className="mb-2 flex items-center justify-between">
        <p className="font-medium">Bill to &amp; payments</p>
        {!editing ? (
          <Button size="sm" variant="ghost" onClick={startEdit}>
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </Button>
        ) : null}
      </div>

      {!editing ? (
        <div className="space-y-2">
          <p className="text-muted-foreground">
            {billLines.length ? billLines.join(" · ") : "Customer's own address from their record"}
          </p>
          {saved.map((p, i) => (
            <div key={i} className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">
                {PAYMENT_MODES[p.mode] ?? p.mode}
                {p.reference ? ` · ${p.reference}` : ""}
                {p.date ? ` · ${p.date}` : ""}
              </span>
              <span className="num">{formatINR(p.amount)}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              className="sm:col-span-2"
              placeholder="Address"
              maxLength={300}
              value={billTo.address ?? ""}
              onChange={(e) => setBillTo({ ...billTo, address: e.target.value })}
            />
            <Input
              placeholder="State"
              maxLength={60}
              value={billTo.state ?? ""}
              onChange={(e) => setBillTo({ ...billTo, state: e.target.value })}
            />
            <Input
              placeholder="GSTIN"
              maxLength={15}
              value={billTo.gstin ?? ""}
              onChange={(e) => setBillTo({ ...billTo, gstin: e.target.value.toUpperCase() })}
            />
            <Input
              placeholder="PAN"
              maxLength={10}
              value={billTo.pan ?? ""}
              onChange={(e) => setBillTo({ ...billTo, pan: e.target.value.toUpperCase() })}
            />
          </div>

          {payments.map((p, i) => (
            <div key={i} className="grid grid-cols-2 gap-2 rounded-md border p-2 sm:grid-cols-[7rem_1fr_1fr_9rem_auto]">
              <select
                aria-label="Payment mode"
                className="h-10 rounded-md border border-input bg-background px-2 text-sm"
                value={p.mode}
                onChange={(e) => setPayment(i, { mode: e.target.value as QuotePayment["mode"] })}
              >
                {Object.entries(PAYMENT_MODES).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <Input
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                aria-label="Amount"
                placeholder="Amount"
                value={p.amount || ""}
                onChange={(e) => setPayment(i, { amount: Number(e.target.value) })}
              />
              <Input
                aria-label="Transaction id / ref no"
                placeholder="Txn id / UTR / ref no"
                maxLength={60}
                value={p.reference ?? ""}
                onChange={(e) => setPayment(i, { reference: e.target.value })}
              />
              <Input
                type="date"
                aria-label="Date received"
                value={p.date ?? ""}
                onChange={(e) => setPayment(i, { date: e.target.value })}
              />
              <Button
                size="icon"
                variant="ghost"
                aria-label="Remove payment"
                onClick={() => setPayments((ps) => ps.filter((_, j) => j !== i))}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setPayments((ps) => [...ps, { mode: "upi", amount: 0, date: new Date().toISOString().slice(0, 10) }])
            }
          >
            <Plus className="h-3.5 w-3.5" />
            Add payment
          </Button>
        </div>
      )}

      <dl className="mt-3 space-y-1 border-t pt-2">
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Received</dt>
          <dd className="num">{formatINR(received)}</dd>
        </div>
        <div className="flex justify-between font-medium">
          <dt>Balance</dt>
          <dd className={received > total ? "num text-destructive" : "num"}>{formatINR(total - received)}</dd>
        </div>
      </dl>

      {editing ? (
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="outline" size="sm" disabled={save.isPending} onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={save.isPending || received > total || payments.some((p) => !(Number(p.amount) > 0))}
            onClick={onSave}
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
