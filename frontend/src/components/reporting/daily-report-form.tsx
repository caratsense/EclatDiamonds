"use client";

import { useMemo, useState } from "react";
import { Banknote, CreditCard, MessageCircle, Smartphone } from "lucide-react";
import { toast } from "sonner";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatINR } from "@/lib/format";
import {
  composeDailyReportText,
  type DailyReportInput,
} from "@/lib/mock/reporting";
import { useCreateDailyReport } from "@/lib/queries/reporting";
import { cn } from "@/lib/utils";
import { useSession } from "@/store/use-session";

/** Parse a numeric input; blank/invalid -> undefined. */
function toNumber(v: string): number | undefined {
  if (v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Today as yyyy-mm-dd in local time (for the date input default). */
function todayLocal(): string {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60_000).toISOString().slice(0, 10);
}

/** Current HH:mm in local time (for the time input default). */
function nowLocalTime(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
}

/** A number field with a leading ₹ / trailing-unit adornment. */
function NumberField({
  id,
  label,
  value,
  onChange,
  prefix,
  suffix,
  placeholder = "0",
  step,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  prefix?: string;
  suffix?: string;
  placeholder?: string;
  step?: string;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <div className="relative">
        {prefix ? (
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
            {prefix}
          </span>
        ) : null}
        <Input
          id={id}
          type="number"
          min={0}
          step={step}
          inputMode="decimal"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={cn("num", prefix && "pl-7", suffix && "pr-9")}
        />
        {suffix ? (
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
            {suffix}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Small uppercase group heading inside the form. */
function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
      {children}
    </p>
  );
}

/**
 * Daily Report (DSR) entry form — the store-close report the manager used to
 * type on WhatsApp, grouped exactly like that layout (Traffic · Sales · Payment
 * split · Old gold · Submitted by). The store comes from the active-store
 * context; a live WhatsApp-style `<pre>` preview updates as the user types.
 * Submit → POST /reporting/daily.
 */
export function DailyReportForm() {
  const { currentStore, user } = useSession();
  const createReport = useCreateDailyReport();

  // Aggregate ("All Stores") has no concrete store to file against — fall back
  // to the first real store, matching the direct-sale entry convention.
  const targetStoreId = currentStore.isAggregate
    ? "surat-main"
    : currentStore.id;
  const storeLabel = currentStore.isAggregate
    ? "Surat — Main"
    : currentStore.name;

  const [reportDate, setReportDate] = useState(todayLocal());
  const [reportTime, setReportTime] = useState(nowLocalTime());
  // Traffic
  const [walkIns, setWalkIns] = useState("");
  const [seriousEnquiries, setSeriousEnquiries] = useState("");
  // Sales
  const [deliveredBilled, setDeliveredBilled] = useState("");
  const [bookingsNew, setBookingsNew] = useState("");
  const [advanceReceived, setAdvanceReceived] = useState("");
  // Payment split
  const [cash, setCash] = useState("");
  const [card, setCard] = useState("");
  const [upi, setUpi] = useState("");
  // Old gold (optional)
  const [oldGoldWtG, setOldGoldWtG] = useState("");
  const [oldGoldValue, setOldGoldValue] = useState("");
  const [submittedBy, setSubmittedBy] = useState(user.name);

  // Build the live input snapshot (numbers default to 0 for the preview).
  const draft: DailyReportInput = useMemo(
    () => ({
      storeId: targetStoreId,
      reportDate,
      reportTime: reportTime || undefined,
      walkIns: toNumber(walkIns) ?? 0,
      seriousEnquiries: toNumber(seriousEnquiries) ?? 0,
      deliveredBilled: toNumber(deliveredBilled) ?? 0,
      bookingsNew: toNumber(bookingsNew) ?? 0,
      advanceReceived: toNumber(advanceReceived) ?? 0,
      cash: toNumber(cash) ?? 0,
      card: toNumber(card) ?? 0,
      upi: toNumber(upi) ?? 0,
      oldGoldWtG: toNumber(oldGoldWtG),
      oldGoldValue: toNumber(oldGoldValue),
      submittedBy: submittedBy.trim() || undefined,
    }),
    [
      targetStoreId,
      reportDate,
      reportTime,
      walkIns,
      seriousEnquiries,
      deliveredBilled,
      bookingsNew,
      advanceReceived,
      cash,
      card,
      upi,
      oldGoldWtG,
      oldGoldValue,
      submittedBy,
    ],
  );

  const preview = useMemo(
    () => composeDailyReportText(draft, storeLabel),
    [draft, storeLabel],
  );

  const collected = draft.cash + draft.card + draft.upi;

  function resetFigures() {
    setWalkIns("");
    setSeriousEnquiries("");
    setDeliveredBilled("");
    setBookingsNew("");
    setAdvanceReceived("");
    setCash("");
    setCard("");
    setUpi("");
    setOldGoldWtG("");
    setOldGoldValue("");
  }

  async function submit() {
    if (!reportDate) {
      toast.error("Pick the report date.");
      return;
    }
    if (!draft.submittedBy) {
      toast.error("Add who is submitting this report.");
      return;
    }
    try {
      await createReport.mutateAsync(draft);
      toast.success("Daily report filed", {
        description: `${storeLabel} · ${reportDate}`,
      });
      resetFigures();
    } catch {
      toast.error("Could not file the report. Please try again.");
    }
  }

  async function copyPreview() {
    try {
      await navigator.clipboard.writeText(preview);
      toast.success("Report text copied — paste into WhatsApp");
    } catch {
      toast.error("Couldn't copy. Select the text and copy manually.");
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      {/* Entry form */}
      <Card>
        <CardHeader>
          <CardTitle>File today&apos;s report</CardTitle>
          <CardDescription>
            Store-close figures for {storeLabel}
            {currentStore.isAggregate ? (
              <span className="text-warning">
                {" "}
                · switch to a specific store to change
              </span>
            ) : null}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Store / date / time */}
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label className="text-xs">Store</Label>
              <div className="flex h-9 items-center gap-1.5 rounded-md border bg-muted/40 px-3 text-sm font-medium">
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--gold)]" />
                {storeLabel}
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="dsr-date" className="text-xs">
                Date
              </Label>
              <Input
                id="dsr-date"
                type="date"
                value={reportDate}
                onChange={(e) => setReportDate(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="dsr-time" className="text-xs">
                Time
              </Label>
              <Input
                id="dsr-time"
                type="time"
                value={reportTime}
                onChange={(e) => setReportTime(e.target.value)}
              />
            </div>
          </div>

          {/* Traffic */}
          <div className="space-y-2.5">
            <GroupLabel>Traffic</GroupLabel>
            <div className="grid gap-3 sm:grid-cols-2">
              <NumberField
                id="dsr-walkins"
                label="Walk-ins"
                value={walkIns}
                onChange={setWalkIns}
                step="1"
              />
              <NumberField
                id="dsr-enquiries"
                label="Serious enquiries"
                value={seriousEnquiries}
                onChange={setSeriousEnquiries}
                step="1"
              />
            </div>
          </div>

          {/* Sales */}
          <div className="space-y-2.5">
            <GroupLabel>Sales</GroupLabel>
            <div className="grid gap-3 sm:grid-cols-3">
              <NumberField
                id="dsr-billed"
                label="Delivered & billed"
                value={deliveredBilled}
                onChange={setDeliveredBilled}
                prefix="₹"
              />
              <NumberField
                id="dsr-bookings"
                label="Bookings (new)"
                value={bookingsNew}
                onChange={setBookingsNew}
                prefix="₹"
              />
              <NumberField
                id="dsr-advance"
                label="Advance received"
                value={advanceReceived}
                onChange={setAdvanceReceived}
                prefix="₹"
              />
            </div>
          </div>

          {/* Payment split */}
          <div className="space-y-2.5">
            <GroupLabel>Payment split</GroupLabel>
            <div className="grid gap-3 sm:grid-cols-3">
              <NumberField
                id="dsr-cash"
                label="Cash"
                value={cash}
                onChange={setCash}
                prefix="₹"
              />
              <NumberField
                id="dsr-card"
                label="Card"
                value={card}
                onChange={setCard}
                prefix="₹"
              />
              <NumberField
                id="dsr-upi"
                label="UPI"
                value={upi}
                onChange={setUpi}
                prefix="₹"
              />
            </div>
            <div className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-2 text-xs">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Banknote className="h-3.5 w-3.5" />
                <CreditCard className="h-3.5 w-3.5" />
                <Smartphone className="h-3.5 w-3.5" />
                Collected today
              </span>
              <span className="num font-semibold">{formatINR(collected)}</span>
            </div>
          </div>

          {/* Old gold (optional) */}
          <div className="space-y-2.5">
            <GroupLabel>Old gold — trade-in (optional)</GroupLabel>
            <div className="grid gap-3 sm:grid-cols-2">
              <NumberField
                id="dsr-oldgold-wt"
                label="Weight"
                value={oldGoldWtG}
                onChange={setOldGoldWtG}
                suffix="g"
                step="0.001"
                placeholder="—"
              />
              <NumberField
                id="dsr-oldgold-val"
                label="Value"
                value={oldGoldValue}
                onChange={setOldGoldValue}
                prefix="₹"
                placeholder="—"
              />
            </div>
          </div>

          {/* Submitted by */}
          <div className="grid gap-1.5">
            <Label htmlFor="dsr-by" className="text-xs">
              Submitted by
            </Label>
            <Input
              id="dsr-by"
              placeholder="e.g. Manish Vaishnav"
              value={submittedBy}
              onChange={(e) => setSubmittedBy(e.target.value)}
            />
          </div>

          <div className="flex justify-end pt-1">
            <Button
              variant="gold"
              onClick={submit}
              disabled={createReport.isPending}
            >
              {createReport.isPending ? "Filing…" : "File report"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Live WhatsApp-style preview */}
      <Card className="self-start lg:sticky lg:top-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MessageCircle className="h-4 w-4 text-[var(--gold)]" />
            WhatsApp preview
          </CardTitle>
          <CardDescription>
            Exactly what gets sent — updates as you type
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg border bg-muted/40 p-3 font-mono text-[12.5px] leading-relaxed text-foreground">
            {preview}
          </pre>
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={copyPreview}
          >
            <MessageCircle className="h-4 w-4" />
            Copy text
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
