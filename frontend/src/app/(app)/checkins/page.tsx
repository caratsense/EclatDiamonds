"use client";

import { useEffect, useMemo, useState } from "react";
import { DoorOpen, Users, UserCheck, TrendingUp } from "lucide-react";
import { toast } from "sonner";

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/store/use-session";
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

export default function CheckinsPage() {
  const { currentStore, stores } = useSession();
  const nav = getNavItem("checkins");
  const isAggregate = currentStore.isAggregate;

  const { data: checkins = [], isLoading, isError, refetch } = useCheckins();
  const [addOpen, setAddOpen] = useState(false);
  // The visit currently being closed (drives the "Close visit" dialog).
  const [closing, setClosing] = useState<CheckIn | null>(null);

  // Headline numbers derived from the live log. "Week" has no endpoint so we
  // surface today's count for the single-store view.
  const today = checkins.length;
  const live = checkins.filter((c) => !c.timeOut).length;
  const converted = checkins.filter((c) => CLOSED_OUTCOMES.has(c.outcome)).length;
  const convRate = today ? (converted / today) * 100 : 0;

  const byHour = useMemo(() => deriveByHour(checkins), [checkins]);

  // Per-store breakdown only makes sense in the aggregate view; derive it from
  // the live rows grouped by store.
  const byStore = useMemo<StoreFootfall[]>(() => {
    if (!isAggregate) return [];
    const map = new Map<string, StoreFootfall>();
    for (const c of checkins) {
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
  }, [checkins, isAggregate, stores]);

  function handleCheckout(id: string) {
    const target = checkins.find((c) => c.id === id);
    if (target) setClosing(target);
  }

  return (
    <>
      <SectionHeader
        title={nav?.title ?? "Check-ins & Footfall"}
        purpose={nav?.purpose ?? ""}
        primaryAction={nav?.primaryAction}
        onPrimaryAction={() => setAddOpen(true)}
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
              onCheckout={handleCheckout}
              checkingOutId={closing?.id ?? null}
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

      <AddCheckinDialog open={addOpen} onOpenChange={setAddOpen} />
      <CloseVisitDialog
        checkin={closing}
        open={closing != null}
        onOpenChange={(o) => {
          if (!o) setClosing(null);
        }}
      />
    </>
  );
}

/** Outcome options offered when closing a walk-in visit. */
const CLOSE_OUTCOME_OPTIONS: { value: CheckinOutcomeInput; label: string }[] = [
  { value: "sale_closed", label: "Sale closed" },
  { value: "quote_given", label: "Quote given" },
  { value: "follow_up", label: "Follow-up needed" },
  { value: "left", label: "Just browsing" },
];

/** Capture the real visit outcome as a customer leaves the store. */
function CloseVisitDialog({
  checkin,
  open,
  onOpenChange,
}: {
  checkin: CheckIn | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const checkout = useCheckoutCheckin();
  const [outcome, setOutcome] = useState<CheckinOutcomeInput | "">("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  function clearError(field: string) {
    setErrors((prev) => (prev[field] ? { ...prev, [field]: "" } : prev));
  }

  // Reset the selection whenever a new visit is opened for closing.
  useEffect(() => {
    if (open) {
      setOutcome("");
      setErrors({});
    }
  }, [open, checkin?.id]);

  function submit() {
    if (!checkin) return;
    if (!outcome) {
      setErrors({ outcome: "Select the visit outcome." });
      toast.error("Please fix the highlighted fields.");
      return;
    }
    checkout.mutate(
      { id: checkin.id, outcome },
      {
        onSuccess: () => {
          toast.success("Visit closed");
          onOpenChange(false);
        },
        onError: (err) => toast.error(apiErrorMessage(err, "Could not close the visit.")),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Close visit</DialogTitle>
          <DialogDescription>
            {checkin
              ? `How did ${checkin.customer}'s visit end?`
              : "Record how the visit ended."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="close-outcome">
            Outcome <span className="text-destructive">*</span>
          </Label>
          <Select
            value={outcome}
            onValueChange={(v) => {
              setOutcome(v as CheckinOutcomeInput);
              clearError("outcome");
            }}
          >
            <SelectTrigger id="close-outcome" aria-invalid={!!errors.outcome}>
              <SelectValue placeholder="Select the visit outcome" />
            </SelectTrigger>
            <SelectContent>
              {CLOSE_OUTCOME_OPTIONS.map((o) => (
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
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={checkout.isPending}>
            {checkout.isPending ? "Closing…" : "Close visit"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const PURPOSE_OPTIONS: VisitPurpose[] = [
  "Browsing",
  "Bridal",
  "Gold Coin / Investment",
  "Repair / Service",
  "Gold Scheme",
  "Quote Follow-up",
];

function AddCheckinDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { targetStoreId, storeLabel, pickedStoreId, setPickedStoreId } =
    useStoreScope();
  const create = useCreateCheckin();
  const [customer, setCustomer] = useState("");
  const [phone, setPhone] = useState("");
  /*
   * The CANONICAL value, not the display label.
   *
   * This used to hold a jeweller's English ("Gold Coin / Investment") and map it
   * to the enum on submit, so the list a clinic saw was Bridal / Gold Scheme /
   * Repair whatever their pack had configured. Holding the enum value means the
   * options can come from the tenant's own vocabulary while what gets STORED is
   * unchanged — the same `CheckinPurpose` member either way.
   */
  const [purpose, setPurpose] = useState<CheckinPurposeInput>("browsing");
  const { data: checkinConfig } = useConfigBootstrap();
  /*
   * The tenant's configured visit purposes, falling back to the built-in list.
   *
   * A term only qualifies if it declares a `systemValue`, because that is the
   * enum member the column accepts; a label-only term the tenant invented has
   * nowhere to be stored and would fail on save.
   */
  const purposeOptions: { value: CheckinPurposeInput; label: string }[] = (() => {
    const terms = checkinConfig?.taxonomies?.checkin_purpose?.terms ?? [];
    const configured = terms
      .filter((t) => !!t.systemValue)
      .map((t) => ({ value: t.systemValue as CheckinPurposeInput, label: t.label }));
    if (configured.length) return configured;
    return PURPOSE_OPTIONS.map((label) => ({ value: PURPOSE_TO_ENUM[label], label }));
  })();
  // Inline validation errors, keyed by field. Cleared per-field on change.
  const [errors, setErrors] = useState<Record<string, string>>({});

  function clearError(field: string) {
    setErrors((prev) => (prev[field] ? { ...prev, [field]: "" } : prev));
  }

  function save() {
    if (!targetStoreId) {
      toast.error("Select a store to log this walk-in against.");
      return;
    }
    const next: Record<string, string> = {};
    if (!customer.trim()) next.customer = "Customer name is required.";
    else if (!isRealName(customer))
      next.customer = "Enter a real name — letters, not just a number.";
    // Phone is optional; only validate a non-empty value (backend @IsIndianMobile).
    const normalizedPhone = phone.trim() ? normalizeIndianMobile(phone) : null;
    if (phone.trim() && !normalizedPhone)
      next.phone = "Enter a valid 10-digit mobile number.";
    if (Object.keys(next).length > 0) {
      setErrors(next);
      toast.error("Please fix the highlighted fields.");
      return;
    }
    create.mutate(
      {
        storeId: targetStoreId,
        customerName: customer.trim(),
        phone: normalizedPhone ?? undefined,
        purpose,
      },
      {
        onSuccess: () => {
          toast.success("Check-in logged");
          setCustomer("");
          setPhone("");
          setPurpose("browsing");
          setErrors({});
          onOpenChange(false);
        },
        onError: (err) => toast.error(apiErrorMessage(err, "Could not log the walk-in.")),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Log walk-in</DialogTitle>
          <DialogDescription>
            New check-ins are recorded against {storeLabel}.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <StoreScopeField value={pickedStoreId} onChange={setPickedStoreId} />

          <div className="grid gap-1.5">
            <Label htmlFor="ci-cust">
              Customer name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="ci-cust"
              placeholder="e.g. Rajesh Agarwal"
              value={customer}
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
              placeholder="+91 ..."
              inputMode="tel"
              value={phone}
              aria-invalid={!!errors.phone}
              onChange={(e) => {
                setPhone(capIndianPhone(e.target.value));
                clearError("phone");
              }}
            />
            {errors.phone ? (
              <p className="mt-1 text-xs text-destructive">{errors.phone}</p>
            ) : null}
            {/* Recognition before creation: the counter finds out who this is
                while they are still typing, and a returning customer's name is
                filled in rather than re-typed (and possibly re-spelled, which
                is how one person becomes two records). */}
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
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={create.isPending}>
            {create.isPending ? "Saving…" : "Log check-in"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
