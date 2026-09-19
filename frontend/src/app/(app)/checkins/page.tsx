"use client";

import { useMemo, useState } from "react";
import { DoorOpen, Users, UserCheck, TrendingUp, ScanLine, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useRecordInteraction } from "@/lib/queries/crm";

import { SectionHeader } from "@/components/section/section-header";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/store/use-session";
import { describeDefaultReminder, useFollowUpReminderSettings } from "@/lib/queries/follow-up-reminders";
import { reminderLabel } from "@/lib/reminder";
import { useQuickAction } from "@/store/use-quick-action";
import {
  StoreScopeField,
  useStoreScope,
} from "@/components/common/store-scope-field";
import { getNavItem } from "@/lib/navigation";
import { formatPercent } from "@/lib/format";
import { StatTiles } from "@/components/hrms/stat-tiles";
import {
  type CheckIn,
  type HourlyFootfall,
  type StoreFootfall,
  type VisitPurpose,
} from "@/lib/mock/checkins";
import {
  FootfallByHourChart,
  FootfallByStoreChart,
} from "@/components/checkins/footfall-charts";
import { CheckInLog, LiveInStore } from "@/components/checkins/checkin-tables";
import { CustomerRecognition } from "@/components/crm/customer-recognition";
import {
  PURPOSE_TO_ENUM,
  useCheckins,
  useCheckoutCheckin,
  useCreateCheckin,
  type CheckinOutcomeInput,
  type CheckinPurposeInput,
} from "@/lib/queries/checkins";
import { useConfigBootstrap } from "@/lib/queries/tenant-config";
import {
  apiErrorMessage,
  capIndianPhone,
  isRealName,
  normalizeIndianMobile,
} from "@/lib/utils";
import { useResetOn } from "@/lib/use-reset-on";

/** Bucket "HH:mm" into an hour label like "10a" / "1p" for the hourly chart. */
function hourLabel(timeIn: string | null): string | null {
  if (!timeIn) return null;
  const hour = Number(timeIn.slice(0, 2));
  if (Number.isNaN(hour)) return null;
  const period = hour < 12 ? "a" : "p";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}${period}`;
}

/** Derive the hourly-footfall series from the live check-in log (no endpoint). */
function deriveByHour(checkins: CheckIn[]): HourlyFootfall[] {
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const c of checkins) {
    const label = hourLabel(c.timeIn);
    if (!label) continue;
    if (!counts.has(label)) order.push(label);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return order
    .map((hour) => ({ hour, visitors: counts.get(hour) ?? 0 }))
    .sort((a, b) => sortHour(a.hour) - sortHour(b.hour));
}

function sortHour(label: string): number {
  const period = label.slice(-1);
  const h = Number(label.slice(0, -1));
  const base = h === 12 ? 0 : h;
  return period === "a" ? base : base + 12;
}

const CLOSED_OUTCOMES = new Set(["sale_closed"]);

/**
 * Was this walk-in today?
 *
 * The log is the most recent 200 rows with no date bound, so "today" has to be
 * decided here. It used to not be decided at all: every tile below counted the
 * whole log and called it today's, which on a branch with a week of history
 * reported a week of footfall as one day's and a lifetime conversion rate as
 * today's. `timeInAt` is the real instant; `timeIn` is only a wall clock.
 */
function isToday(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

export default function CheckinsPage() {
  const { currentStore, stores } = useSession();
  const nav = getNavItem("checkins");
  const isAggregate = currentStore.isAggregate;

  const { data: checkins = [], isLoading, isError, refetch } = useCheckins();
  const [addOpen, setAddOpen] = useState(false);

  /*
   * "Log walk-in" from the sidebar's Quick Action lands here.
   *
   * Derived rather than copied in by an effect, so the dialog is open on the
   * first paint after the route change instead of on the one after that.
   */
  const quickCheckin = useQuickAction((s) => s.pending === "checkin");
  const clearQuick = useQuickAction((s) => s.clear);
  const addDialogOpen = addOpen || quickCheckin;
  const setAddDialogOpen = (open: boolean) => {
    setAddOpen(open);
    if (!open) clearQuick();
  };

  // Headline numbers derived from the live log, narrowed to today. "Week" has no
  // endpoint, so the single-store view surfaces today's count and says so.
  const todaysVisits = useMemo(
    () => checkins.filter((c) => isToday(c.timeInAt)),
    [checkins],
  );
  const today = todaysVisits.length;
  // "In store now" is today's un-closed visits. Across the whole log it was
  // every visit ever left open, a number that only ever grew.
  const live = todaysVisits.filter((c) => !c.timeOut).length;
  const converted = todaysVisits.filter((c) => CLOSED_OUTCOMES.has(c.outcome)).length;
  const convRate = today ? (converted / today) * 100 : 0;

  const byHour = useMemo(() => deriveByHour(todaysVisits), [todaysVisits]);

  // Per-store breakdown only makes sense in the aggregate view; derive it from
  // the live rows grouped by store.
  const byStore = useMemo<StoreFootfall[]>(() => {
    if (!isAggregate) return [];
    const map = new Map<string, StoreFootfall>();
    for (const c of todaysVisits) {
      const store = stores.find((s) => s.id === c.storeId);
      const row =
        map.get(c.storeId) ??
        ({
          storeId: c.storeId,
          store: store?.name ?? c.storeId,
          today: 0,
          week: 0,
          converted: 0,
        } satisfies StoreFootfall);
      row.today += 1;
      if (CLOSED_OUTCOMES.has(c.outcome)) row.converted += 1;
      map.set(c.storeId, row);
    }
    return [...map.values()];
  }, [todaysVisits, isAggregate, stores]);

  return (
    <>
      <SectionHeader
        title={nav?.title ?? "Check-ins & Footfall"}
        purpose={nav?.purpose ?? ""}
        primaryAction={nav?.primaryAction}
        onPrimaryAction={() => setAddDialogOpen(true)}
      />

      <div className="space-y-4">
        <StatTiles
          tiles={[
            { label: "Footfall today", value: String(today), icon: DoorOpen },
            {
              label: "Converted today",
              value: String(converted),
              hint: "sale closed",
              icon: Users,
            },
            {
              label: "In store now",
              value: String(live),
              hint: "being attended",
              icon: UserCheck,
            },
            {
              label: "Conversion",
              value: formatPercent(convRate, 0),
              hint: `${converted} closed`,
              icon: TrendingUp,
            },
          ]}
        />

        {isLoading ? (
          <>
            <Skeleton className="h-40 rounded-xl" />
            <div className="grid gap-4 lg:grid-cols-2">
              <Skeleton className="h-64 rounded-xl" />
              <Skeleton className="h-64 rounded-xl" />
            </div>
            <Skeleton className="h-72 rounded-xl" />
          </>
        ) : isError ? (
          <div className="mx-auto max-w-md rounded-lg border bg-muted/30 p-4 text-center">
            <p className="text-sm font-medium">Couldn&apos;t load check-ins.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              The connection may have dropped. Check your network and try again.
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
        ) : (
          <>
            <LiveInStore
              checkins={checkins}
            />

            <div className="grid gap-4 lg:grid-cols-2">
              <FootfallByHourChart data={byHour} />
              {isAggregate && byStore.length > 0 ? (
                <FootfallByStoreChart data={byStore} />
              ) : null}
            </div>

            <CheckInLog checkins={checkins} />
          </>
        )}
      </div>

      <UnifiedWalkinDialog open={addDialogOpen} onOpenChange={setAddDialogOpen} />
    </>
  );
}

/** Outcome options offered for the visit. */
const OUTCOME_OPTIONS: { value: CheckinOutcomeInput; label: string }[] = [
  { value: "in_store", label: "Still in store (active visit)" },
  { value: "sale_closed", label: "Sale closed" },
  { value: "quote_given", label: "Quote given" },
  { value: "follow_up", label: "Follow up" },
  { value: "left", label: "Just browsing / left" },
];

const ITEM_KINDS = [
  { value: "shown", label: "Shown to them" },
  { value: "tried", label: "Tried on / sampled" },
  { value: "shortlisted", label: "Shortlisted" },
  { value: "quoted", label: "Quoted" },
  { value: "rejected", label: "Not for them" },
] as const;

const REMIND_BY: { value: "call" | "whatsapp" | "visit"; label: string }[] = [
  { value: "call", label: "Call" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "visit", label: "Visit" },
];

/** Today as yyyy-mm-dd on this device's calendar — the earliest follow-up date. */
function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const PURPOSE_OPTIONS: VisitPurpose[] = [
  "Browsing",
  "Bridal",
  "Gold Coin / Investment",
  "Repair / Service",
  "Gold Scheme",
  "Quote Follow-up",
];

/** Unified dialog for logging walk-ins, items shown, and outcome in one popup. */
function UnifiedWalkinDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { targetStoreId, storeLabel, pickedStoreId, setPickedStoreId } =
    useStoreScope();
  const createCheckin = useCreateCheckin();
  const checkoutCheckin = useCheckoutCheckin();
  const recordInteraction = useRecordInteraction();
  const reminderDefaults = useFollowUpReminderSettings();

  // Customer details
  const [customer, setCustomer] = useState("");
  const [phone, setPhone] = useState("");
  // Plenty of people walk in, look, and leave without giving a name or a
  // number. Before this they could not be logged at all, so they vanished
  // from footfall entirely and the DSR walk-in count was quietly short. An
  // anonymous visit is still a visit.
  const [anonymous, setAnonymous] = useState(false);
  const [purpose, setPurpose] = useState<CheckinPurposeInput>("browsing");

  // Item shown
  const [sku, setSku] = useState("");
  const [itemKind, setItemKind] = useState<string>("shown");
  const [itemNote, setItemNote] = useState("");

  // Outcome & follow-up
  const [outcome, setOutcome] = useState<CheckinOutcomeInput>("in_store");
  const [remark, setRemark] = useState("");
  const [followUpDate, setFollowUpDate] = useState("");
  const [remindBy, setRemindBy] = useState<"call" | "whatsapp" | "visit" | "">("");
  const [reminderAt, setReminderAt] = useState("");

  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const { data: checkinConfig } = useConfigBootstrap();
  const purposeOptions: { value: CheckinPurposeInput; label: string }[] = (() => {
    const terms = checkinConfig?.taxonomies?.checkin_purpose?.terms ?? [];
    const configured = terms
      .filter((t) => !!t.systemValue)
      .map((t) => ({ value: t.systemValue as CheckinPurposeInput, label: t.label }));
    if (configured.length) return configured;
    return PURPOSE_OPTIONS.map((label) => ({ value: PURPOSE_TO_ENUM[label], label }));
  })();

  function clearError(field: string) {
    setErrors((prev) => (prev[field] ? { ...prev, [field]: "" } : prev));
  }

  function resetForm() {
    setCustomer("");
    setPhone("");
    setAnonymous(false);
    setPurpose("browsing");
    setSku("");
    setItemKind("shown");
    setItemNote("");
    setOutcome("in_store");
    setRemark("");
    setFollowUpDate("");
    setRemindBy("");
    setReminderAt("");
    setErrors({});
  }

  async function save() {
    if (!targetStoreId) {
      toast.error("Select a store to log this walk-in against.");
      return;
    }
    const next: Record<string, string> = {};
    // An anonymous visit carries a timestamped label instead of a name, so
    // the row is obviously a walk-in rather than a person somebody failed to
    // identify — and two of them on the same day never look like the same
    // customer.
    const customerName = anonymous
      ? `Walk-in · ${new Date().toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        })}`
      : customer.trim();
    if (!anonymous) {
      if (!customer.trim()) next.customer = "Customer name is required.";
      else if (!isRealName(customer))
        next.customer = "Enter a real name — letters, not just a number.";
    }
    const normalizedPhone =
      !anonymous && phone.trim() ? normalizeIndianMobile(phone) : null;
    if (!anonymous && phone.trim() && !normalizedPhone)
      next.phone = "Enter a valid 10-digit mobile number.";
    if (outcome === "follow_up" && !followUpDate && !reminderAt) {
      next.followUpDate = "Pick the follow-up date or a reminder.";
    }
    if (followUpDate && reminderAt && reminderAt.slice(0, 10) > followUpDate) {
      next.reminderAt = "The reminder must be on or before the follow-up date.";
    }
    if (Object.keys(next).length > 0) {
      setErrors(next);
      toast.error("Please fix the highlighted fields.");
      return;
    }

    setSaving(true);
    try {
      // Step 1: Create check-in
      const row = await createCheckin.mutateAsync({
        storeId: targetStoreId,
        customerName,
        phone: normalizedPhone ?? undefined,
        purpose,
      });

      // Step 2: Record item shown if an item code was scanned or entered
      if (sku.trim() && row.partyId) {
        try {
          await recordInteraction.mutateAsync({
            kind: itemKind,
            partyId: row.partyId,
            sku: sku.trim(),
            storeId: targetStoreId,
            channel: "store",
            notes: itemNote.trim() || undefined,
          });
        } catch {
          // Logged non-blocking if CRM interaction fails
        }
      }

      // Step 3: Record outcome and follow-up if closed or outcome selected
      if (outcome && outcome !== "in_store") {
        await checkoutCheckin.mutateAsync({
          id: row.id,
          outcome,
          remark: remark.trim() || undefined,
          followUpDate: followUpDate || undefined,
          preferredAction: (followUpDate || reminderAt) && remindBy ? remindBy : undefined,
          reminderAt: reminderAt || undefined,
        });
      }

      toast.success(`Walk-in recorded for ${customerName}`);
      resetForm();
      onOpenChange(false);
    } catch (err) {
      toast.error(apiErrorMessage(err, "Could not record the walk-in."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => {
      if (!o) resetForm();
      onOpenChange(o);
    }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Log walk-in &amp; visit</DialogTitle>
          <DialogDescription>
            Record customer details, items shown, and outcome against {storeLabel}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <StoreScopeField value={pickedStoreId} onChange={setPickedStoreId} />

          {/* Section 1: Customer Details */}
          <div className="space-y-3 rounded-lg border bg-card p-3 shadow-xs">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Customer Details
            </h4>

            <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
              <input
                id="ci-anon"
                type="checkbox"
                className="h-4 w-4 accent-[var(--primary)]"
                checked={anonymous}
                onChange={(e) => {
                  setAnonymous(e.target.checked);
                  clearError("customer");
                  clearError("phone");
                }}
              />
              Customer didn&apos;t share details
            </label>
            {anonymous ? (
              <p className="text-xs text-muted-foreground">
                Logged as an anonymous walk-in with the time of the visit. It
                still counts towards footfall and the DSR; items shown and the
                outcome can be recorded as usual.
              </p>
            ) : null}

            <div className="grid gap-1.5">
              <Label htmlFor="ci-cust">
                Customer name
                {anonymous ? null : (
                  <span className="text-destructive"> *</span>
                )}
              </Label>
              <Input
                id="ci-cust"
                placeholder={anonymous ? "Not provided" : "e.g. Rajesh Agarwal"}
                disabled={anonymous}
                value={anonymous ? "" : customer}
                aria-invalid={!!errors.customer}
                onChange={(e) => {
                  setCustomer(e.target.value);
                  clearError("customer");
                }}
              />
              {errors.customer ? (
                <p className="mt-1 text-xs text-destructive">{errors.customer}</p>
              ) : null}
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="ci-phone">Phone</Label>
              <Input
                id="ci-phone"
                placeholder={anonymous ? "Not provided" : "+91 ..."}
                inputMode="tel"
                disabled={anonymous}
                value={anonymous ? "" : phone}
                aria-invalid={!!errors.phone}
                onChange={(e) => {
                  setPhone(capIndianPhone(e.target.value));
                  clearError("phone");
                }}
              />
              {errors.phone ? (
                <p className="mt-1 text-xs text-destructive">{errors.phone}</p>
              ) : null}
              <CustomerRecognition
                phone={phone}
                onRecognised={(c) => {
                  if (!customer.trim()) {
                    setCustomer(c.name);
                    clearError("customer");
                  }
                }}
              />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="ci-purpose">Purpose</Label>
              <Select
                value={purpose}
                onValueChange={(v) => setPurpose(v as CheckinPurposeInput)}
              >
                <SelectTrigger id="ci-purpose">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {purposeOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Section 2: Items Shown / Interest */}
          <div className="space-y-3 rounded-lg border bg-card p-3 shadow-xs">
            <div className="flex items-center justify-between">
              <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <ScanLine className="h-3.5 w-3.5 text-indigo-500" />
                What did you show?
              </h4>
              <span className="text-[11px] text-muted-foreground">Optional</span>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="ri-sku">Item code</Label>
              <div className="relative">
                <ScanLine className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="ri-sku"
                  className="pl-8"
                  placeholder="Scan or type the code"
                  value={sku}
                  onChange={(e) => setSku(e.target.value)}
                />
              </div>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="ri-kind">What happened</Label>
              <Select value={itemKind} onValueChange={setItemKind}>
                <SelectTrigger id="ri-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ITEM_KINDS.map((k) => (
                    <SelectItem key={k.value} value={k.value}>
                      {k.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="ri-notes">Item note</Label>
              <Textarea
                id="ri-notes"
                rows={2}
                placeholder="e.g. wanted it in rose gold, size smaller"
                value={itemNote}
                onChange={(e) => setItemNote(e.target.value)}
              />
            </div>
          </div>

          {/* Section 3: Visit Outcome & Follow-up */}
          <div className="space-y-3 rounded-lg border bg-card p-3 shadow-xs">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Visit Outcome &amp; Follow-up
            </h4>

            <div className="grid gap-1.5">
              <Label htmlFor="close-outcome">Outcome</Label>
              <Select
                value={outcome}
                onValueChange={(v) => {
                  setOutcome(v as CheckinOutcomeInput);
                  clearError("outcome");
                }}
              >
                <SelectTrigger id="close-outcome" aria-invalid={!!errors.outcome}>
                  <SelectValue placeholder="Select outcome" />
                </SelectTrigger>
                <SelectContent>
                  {OUTCOME_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.outcome ? (
                <p className="mt-1 text-xs text-destructive">{errors.outcome}</p>
              ) : null}
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="close-remark">Customer feedback / remark</Label>
              <Textarea
                id="close-remark"
                rows={2}
                maxLength={2000}
                value={remark}
                onChange={(e) => setRemark(e.target.value)}
                placeholder="What did the customer say? e.g. liked the necklace, will return this weekend"
              />
            </div>

            {(outcome === "follow_up" || followUpDate) ? (
              <fieldset className="grid gap-3 rounded-lg border border-indigo-200 dark:border-indigo-500/20 bg-indigo-50/40 dark:bg-indigo-500/5 p-3">
                <legend className="px-1 text-xs font-semibold uppercase text-indigo-700 dark:text-indigo-400">
                  Follow up details
                </legend>

                <div className="grid gap-1.5">
                  <Label htmlFor="close-followup-date">
                    Follow-up date
                    {outcome === "follow_up" ? <span className="text-destructive"> *</span> : null}
                  </Label>
                  <Input
                    id="close-followup-date"
                    type="date"
                    min={todayYmd()}
                    value={followUpDate}
                    aria-invalid={!!errors.followUpDate}
                    onChange={(e) => {
                      setFollowUpDate(e.target.value);
                      clearError("followUpDate");
                    }}
                  />
                  {errors.followUpDate ? (
                    <p className="text-xs text-destructive">{errors.followUpDate}</p>
                  ) : null}
                </div>

                <div className="grid gap-1.5">
                  <span id="close-remind-by" className="text-xs font-medium">
                    Reminder channel
                  </span>
                  <div role="radiogroup" aria-labelledby="close-remind-by" className="flex flex-wrap gap-2">
                    {REMIND_BY.map((r) => (
                      <Button
                        key={r.value}
                        type="button"
                        size="sm"
                        role="radio"
                        aria-checked={remindBy === r.value}
                        variant={remindBy === r.value ? "default" : "outline"}
                        onClick={() => setRemindBy(remindBy === r.value ? "" : r.value)}
                      >
                        {r.label}
                      </Button>
                    ))}
                  </div>
                </div>

                <div className="grid gap-1.5">
                  <Label htmlFor="close-reminder-at">Remind me at</Label>
                  <Input
                    id="close-reminder-at"
                    type="datetime-local"
                    min={`${todayYmd()}T00:00`}
                    max={followUpDate ? `${followUpDate}T23:59` : undefined}
                    value={reminderAt}
                    aria-invalid={!!errors.reminderAt}
                    onChange={(e) => {
                      setReminderAt(e.target.value);
                      clearError("reminderAt");
                    }}
                  />
                  {errors.reminderAt ? (
                    <p className="text-xs text-destructive">{errors.reminderAt}</p>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">
                      {followUpDate || !reminderAt
                        ? `Default: ${describeDefaultReminder(reminderDefaults.data)}.`
                        : "Follow-up due on reminder day."}
                    </p>
                  )}
                </div>
              </fieldset>
            ) : null}
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || createCheckin.isPending} className="bg-[#6366f1] hover:bg-[#4f46e5] text-white">
            {saving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Recording…
              </>
            ) : (
              "Record Walk-in"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
