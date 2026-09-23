"use client";

import { useMemo, useState } from "react";
import { MessageCircle } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatINR } from "@/lib/format";
import {
  closingBooking,
  composeDailyReportText,
  type DailyReportInput,
} from "@/lib/mock/reporting";
import { useCreateDailyReport } from "@/lib/queries/reporting";
import { cn, positiveNumberInput } from "@/lib/utils";
import { useSession } from "@/store/use-session";

/** Parse a numeric input; blank/invalid -> undefined. */
function toNumber(v: string): number | undefined {
  if (v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Today as yyyy-mm-dd in local time (for the date input default). */
export function todayLocal(): string {
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
          onChange={(e) => onChange(positiveNumberInput(e.target.value))}
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
 * The money/weight fields of a mode-of-payment block on the sheet. Bank
 * transfer is on Table B's block only, so it stays blank on Table A's.
 */
interface PaymentSplit {
  cash: string;
  card: string;
  upi: string;
  goldWt: string;
  goldValue: string;
  bank: string;
}

const EMPTY_SPLIT: PaymentSplit = {
  cash: "",
  card: "",
  upi: "",
  goldWt: "",
  goldValue: "",
  bank: "",
};

/**
 * One "Mode of Payment" block — cash / card / UPI / gold (weight + value) and
 * the Total row, exactly as the store's own sheet lays it out.
 *
 * `expected` is the figure this block is supposed to add up to (the table's sale
 * or received value). When the two disagree the difference is shown, but the
 * report still files: a genuine part-payment, a pending balance, or a figure the
 * manager has not typed yet are all normal at store close, and a form that
 * refuses to save until the arithmetic is perfect is a form people stop using.
 */
function PaymentSplitFields({
  idPrefix,
  split,
  onChange,
  expected,
  withBank = false,
}: {
  idPrefix: string;
  split: PaymentSplit;
  onChange: (next: PaymentSplit) => void;
  expected: number;
  withBank?: boolean;
}) {
  const set = (k: keyof PaymentSplit) => (v: string) =>
    onChange({ ...split, [k]: v });

  const total =
    (toNumber(split.cash) ?? 0) +
    (toNumber(split.card) ?? 0) +
    (toNumber(split.upi) ?? 0) +
    (toNumber(split.goldValue) ?? 0) +
    (toNumber(split.bank) ?? 0);
  const diff = expected - total;
  // Sub-rupee drift is rounding, not a discrepancy worth a red line.
  const reconciles = Math.abs(diff) < 1;

  return (
    <div className="space-y-2.5">
      <p className="text-[11px] text-muted-foreground">Mode of payment</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <NumberField
          id={`${idPrefix}-cash`}
          label="Cash"
          value={split.cash}
          onChange={set("cash")}
          prefix="₹"
        />
        <NumberField
          id={`${idPrefix}-card`}
          label="Card"
          value={split.card}
          onChange={set("card")}
          prefix="₹"
        />
        <NumberField
          id={`${idPrefix}-upi`}
          label="UPI"
          value={split.upi}
          onChange={set("upi")}
          prefix="₹"
        />
      </div>
      <div className={cn("grid gap-3", withBank ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
        <NumberField
          id={`${idPrefix}-gold-wt`}
          label="Gold — weight"
          value={split.goldWt}
          onChange={set("goldWt")}
          suffix="g"
          step="0.001"
          placeholder="—"
        />
        <NumberField
          id={`${idPrefix}-gold-val`}
          label="Gold — value"
          value={split.goldValue}
          onChange={set("goldValue")}
          prefix="₹"
          placeholder="—"
        />
        {withBank ? (
          <NumberField
            id={`${idPrefix}-bank`}
            label="Bank transfer"
            value={split.bank}
            onChange={set("bank")}
            prefix="₹"
          />
        ) : null}
      </div>
      <div
        className={cn(
          "flex items-center justify-between rounded-md px-3 py-2 text-xs",
          reconciles ? "bg-muted/40" : "bg-amber-500/10",
        )}
      >
        <span className="text-muted-foreground">Total</span>
        <span className="flex items-center gap-2">
          <span className="num font-semibold">{formatINR(total)}</span>
          {reconciles ? null : (
            <span className="font-medium text-amber-600 dark:text-amber-500">
              {diff > 0
                ? `${formatINR(diff)} unaccounted`
                : `${formatINR(-diff)} over`}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

/**
 * Daily Report (DSR) entry form — the store-close sheet the manager keeps,
 * field for field: the traffic funnel, TABLE A (counter sale), TABLE B
 * (customised sale), each with its own mode-of-payment split, and the
 * customised-order book. A live WhatsApp-style `<pre>` preview updates as the
 * user types. Submit → POST /reporting/daily.
 */
export function DailyReportForm() {
  const { currentStore, user, stores } = useSession();
  const createReport = useCreateDailyReport();

  // A DSR is a per-store store-close report. On the "All Stores" aggregate there
  // is no single store to file against, so the manager must PICK one — never a
  // silent fallback to a particular branch. Single-store context uses its store.
  const realStores = stores.filter((s) => !s.isAggregate);
  // A real active store follows the topbar switcher (derived, so it stays
  // reactive — a useState would go stale on a store switch). Only the aggregate
  // needs a manual pick, held separately.
  const [pickedStoreId, setPickedStoreId] = useState("");
  const storeId = currentStore.isAggregate ? pickedStoreId : currentStore.id;
  const selectedStore = realStores.find((s) => s.id === storeId);
  const storeLabel = selectedStore?.name ?? "—";

  const [reportDate, setReportDate] = useState(todayLocal());
  const [reportTime, setReportTime] = useState(nowLocalTime());
  // Traffic funnel
  const [walkIns, setWalkIns] = useState("");
  const [seriousEnquiries, setSeriousEnquiries] = useState("");
  const [conversions, setConversions] = useState("");
  // Table A — counter sale
  const [counterSale, setCounterSale] = useState("");
  const [counterSplit, setCounterSplit] = useState<PaymentSplit>(EMPTY_SPLIT);
  // Table B — customised sale
  const [bookingsNew, setBookingsNew] = useState("");
  const [advanceReceived, setAdvanceReceived] = useState("");
  const [customSplit, setCustomSplit] = useState<PaymentSplit>(EMPTY_SPLIT);
  // The customised-order book
  const [bookingsOpen, setBookingsOpen] = useState("");
  const [bookingsClosed, setBookingsClosed] = useState("");
  const [remark, setRemark] = useState("");
  const [submittedBy, setSubmittedBy] = useState(user.name);

  // Build the live input snapshot (numbers default to 0 for the preview).
  const draft: DailyReportInput = useMemo(
    () => ({
      storeId,
      reportDate,
      reportTime: reportTime || undefined,
      walkIns: toNumber(walkIns) ?? 0,
      seriousEnquiries: toNumber(seriousEnquiries) ?? 0,
      conversions: toNumber(conversions) ?? 0,
      deliveredBilled: toNumber(counterSale) ?? 0,
      cash: toNumber(counterSplit.cash) ?? 0,
      card: toNumber(counterSplit.card) ?? 0,
      upi: toNumber(counterSplit.upi) ?? 0,
      oldGoldWtG: toNumber(counterSplit.goldWt),
      oldGoldValue: toNumber(counterSplit.goldValue),
      bookingsNew: toNumber(bookingsNew) ?? 0,
      advanceReceived: toNumber(advanceReceived) ?? 0,
      customCash: toNumber(customSplit.cash) ?? 0,
      customCard: toNumber(customSplit.card) ?? 0,
      customUpi: toNumber(customSplit.upi) ?? 0,
      customGoldWtG: toNumber(customSplit.goldWt),
      customGoldValue: toNumber(customSplit.goldValue),
      customBankTransfer: toNumber(customSplit.bank) ?? 0,
      bookingsOpen: toNumber(bookingsOpen) ?? 0,
      bookingsClosed: toNumber(bookingsClosed) ?? 0,
      remark: remark.trim() || undefined,
      submittedBy: submittedBy.trim() || undefined,
    }),
    [
      storeId,
      reportDate,
      reportTime,
      walkIns,
      seriousEnquiries,
      conversions,
      counterSale,
      counterSplit,
      bookingsNew,
      advanceReceived,
      customSplit,
      bookingsOpen,
      bookingsClosed,
      remark,
      submittedBy,
    ],
  );

  // Composed inline: it is a pure function of `draft` (already memoised) and a
  // label, so a second manual memo only gave the compiler a dependency list to
  // disagree with.
  const preview = composeDailyReportText(draft, storeLabel);
  const closing = closingBooking(draft);

  // Footfall funnel: each row is a subset of the one above it, so it can only
  // ever narrow. Only flagged once both figures of a pair are actually entered
  // (a blank field is undefined, not zero).
  const funnelError = (() => {
    const w = toNumber(walkIns);
    const se = toNumber(seriousEnquiries);
    const c = toNumber(conversions);
    if (w != null && se != null && se > w)
      return "Serious enquiries cannot exceed walk-ins.";
    if (se != null && c != null && c > se)
      return "Conversions cannot exceed serious enquiries.";
    return null;
  })();

  function resetFigures() {
    setWalkIns("");
    setSeriousEnquiries("");
    setConversions("");
    setCounterSale("");
    setCounterSplit(EMPTY_SPLIT);
    setBookingsNew("");
    setAdvanceReceived("");
    setCustomSplit(EMPTY_SPLIT);
    setBookingsClosed("");
    setRemark("");
    // Opening is deliberately kept: tomorrow morning's opening book is tonight's
    // closing, so the manager carries it forward rather than looking it up again.
    setBookingsOpen(String(closing));
  }

  async function submit() {
    if (!storeId) {
      toast.error("Select a store to file the report for.");
      return;
    }
    if (!reportDate) {
      toast.error("Pick the report date.");
      return;
    }
    if (!draft.submittedBy) {
      toast.error("Add who is submitting this report.");
      return;
    }
    if (funnelError) {
      toast.error(funnelError);
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
            {currentStore.isAggregate && !storeId
              ? "Choose the store you're filing for"
              : `Store-close figures for ${storeLabel}`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Store / date / time */}
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label htmlFor="dsr-store" className="text-xs">
                Store{" "}
                {currentStore.isAggregate ? (
                  <span className="text-destructive">*</span>
                ) : null}
              </Label>
              {currentStore.isAggregate ? (
                // All Stores → the manager must pick one; never a silent default.
                <Select value={storeId} onValueChange={setPickedStoreId}>
                  <SelectTrigger id="dsr-store" className="h-9">
                    <SelectValue placeholder="Choose a store" />
                  </SelectTrigger>
                  <SelectContent>
                    {realStores.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <div className="flex h-9 items-center gap-1.5 rounded-md border bg-muted/40 px-3 text-sm font-medium">
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--gold)]" />
                  {storeLabel}
                </div>
              )}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="dsr-date" className="text-xs">
                Date
              </Label>
              <Input
                id="dsr-date"
                type="date"
                max={todayLocal()}
                value={reportDate}
                onChange={(e) => setReportDate(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="dsr-time" className="text-xs">
                Time
              </Label>
              <div className="flex gap-1.5">
                <Input
                  id="dsr-time"
                  type="time"
                  value={reportTime}
                  onChange={(e) => setReportTime(e.target.value)}
                />
                {/* Refresh to the current time without a full page reload; never
                    overwrites a time the user has typed unless they click it. */}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  title="Set to the current time"
                  onClick={() => setReportTime(nowLocalTime())}
                >
                  Now
                </Button>
              </div>
            </div>
          </div>

          {/* Traffic funnel */}
          <div className="space-y-2.5">
            <GroupLabel>Traffic</GroupLabel>
            <p className="text-[11px] text-muted-foreground">
              Counts only — a walk-in is logged whether or not the customer left
              a name or number.
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
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
              <NumberField
                id="dsr-conversions"
                label="Converted"
                value={conversions}
                onChange={setConversions}
                step="1"
              />
            </div>
            {funnelError ? (
              <p className="text-[11px] font-medium text-destructive">
                {funnelError}
              </p>
            ) : null}
          </div>

          {/* Table A — counter sale */}
          <div className="space-y-3 rounded-lg border p-3.5">
            <GroupLabel>Table A · Counter sale</GroupLabel>
            <div className="grid gap-3 sm:grid-cols-2">
              <NumberField
                id="dsr-counter-value"
                label="Sale value"
                value={counterSale}
                onChange={setCounterSale}
                prefix="₹"
              />
            </div>
            <PaymentSplitFields
              idPrefix="dsr-counter"
              split={counterSplit}
              onChange={setCounterSplit}
              expected={draft.deliveredBilled}
            />
          </div>

          {/* Table B — customised sale */}
          <div className="space-y-3 rounded-lg border p-3.5">
            <GroupLabel>Table B · Customised sale</GroupLabel>
            <div className="grid gap-3 sm:grid-cols-2">
              <NumberField
                id="dsr-booking-value"
                label="Booking value — for the day"
                value={bookingsNew}
                onChange={setBookingsNew}
                prefix="₹"
              />
              <NumberField
                id="dsr-advance"
                label="Amount received"
                value={advanceReceived}
                onChange={setAdvanceReceived}
                prefix="₹"
              />
            </div>
            <PaymentSplitFields
              idPrefix="dsr-custom"
              split={customSplit}
              onChange={setCustomSplit}
              expected={draft.advanceReceived}
              withBank
            />
          </div>

          {/* The customised-order book */}
          <div className="space-y-2.5">
            <GroupLabel>Customised order book</GroupLabel>
            <div className="grid gap-3 sm:grid-cols-3">
              <NumberField
                id="dsr-book-open"
                label="Open bookings"
                value={bookingsOpen}
                onChange={setBookingsOpen}
                prefix="₹"
              />
              <NumberField
                id="dsr-book-closed"
                label="Closed — sale completed"
                value={bookingsClosed}
                onChange={setBookingsClosed}
                prefix="₹"
              />
              {/* Derived, never typed: open + booked today − completed today. */}
              <div className="grid gap-1.5">
                <Label className="text-xs text-muted-foreground">
                  Closing booking
                </Label>
                <div className="flex h-9 items-center rounded-md border bg-muted/40 px-3">
                  <span className="num text-sm font-semibold">
                    {formatINR(closing)}
                  </span>
                </div>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Closing is calculated — open + booked today − completed today — and
              becomes tomorrow&apos;s opening automatically when you file.
            </p>
          </div>

          {/* Remark */}
          <div className="grid gap-1.5">
            <Label htmlFor="dsr-remark" className="text-xs">
              Remark
            </Label>
            <Textarea
              id="dsr-remark"
              maxLength={500}
              placeholder="Anything worth noting about the day"
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
            />
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
