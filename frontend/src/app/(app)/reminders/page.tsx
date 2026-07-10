"use client";

import { useMemo, useState } from "react";
import { format, parseISO } from "date-fns";
import {
  CalendarClock,
  Check,
  Pencil,
  Phone,
  Store as StoreIcon,
} from "lucide-react";
import { toast } from "sonner";

import { SectionHeader } from "@/components/section/section-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { getNavItem } from "@/lib/navigation";
import { LEAD_SOURCE_LABELS } from "@/lib/mock/crm";
import {
  bucketFor,
  todayISO,
  useCompleteFollowUp,
  useEditFollowUpDate,
  useReminders,
  type ReminderBucket,
  type ReminderItem,
} from "@/lib/queries/reminders";
import { useSession } from "@/store/use-session";

const nav = getNavItem("reminders")!;

type Group = { bucket: ReminderBucket; label: string; hint: string };

const GROUPS: Group[] = [
  { bucket: "overdue", label: "Overdue", hint: "Past due — follow up first" },
  { bucket: "today", label: "Today", hint: "Due today" },
  { bucket: "upcoming", label: "Upcoming", hint: "Scheduled ahead" },
];

function fmtDate(iso: string) {
  try {
    return format(parseISO(iso), "d MMM yyyy");
  } catch {
    return iso;
  }
}

export default function RemindersPage() {
  const { currentStore, role } = useSession();
  // In-app reminders only. Fetch every pending follow-up, bucket client-side.
  const {
    data: reminders = [],
    isLoading,
    isError,
    refetch,
  } = useReminders("pending");
  const [completing, setCompleting] = useState<ReminderItem | null>(null);

  const grouped = useMemo(() => {
    const today = todayISO();
    const map: Record<ReminderBucket, ReminderItem[]> = {
      overdue: [],
      today: [],
      upcoming: [],
    };
    for (const r of reminders) {
      if (r.done) continue;
      map[bucketFor(r.dueDate, today)].push(r);
    }
    // Backend already orders by dueDate; keep that within each bucket.
    return map;
  }, [reminders]);

  const totalPending =
    grouped.overdue.length + grouped.today.length + grouped.upcoming.length;

  const scopeNote =
    role === "salesperson"
      ? "Your lead follow-ups"
      : currentStore.isAggregate
        ? "Follow-ups across all stores"
        : `Follow-ups for ${currentStore.name}`;

  return (
    <>
      <SectionHeader title={nav.title} purpose={nav.purpose} />

      <div className="mb-6 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span>{scopeNote}</span>
        {!isLoading && !isError ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="text-muted-foreground/50">·</span>
            <span className="num font-medium text-foreground">
              {totalPending}
            </span>
            pending
          </span>
        ) : null}
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
      ) : isError ? (
        <div className="mx-auto max-w-md rounded-lg border bg-muted/30 p-4 text-center">
          <p className="text-sm font-medium">Couldn&apos;t load reminders.</p>
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
      ) : totalPending === 0 ? (
        <div className="mx-auto max-w-md rounded-xl border border-dashed bg-muted/20 px-6 py-16 text-center">
          <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--gold)_12%,transparent)] text-gold-strong">
            <CalendarClock className="h-5 w-5" />
          </span>
          <p className="text-sm font-medium">No follow-ups due.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            New leads automatically schedule follow-ups at 7 and 30 days.
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {GROUPS.map((group) => {
            const items = grouped[group.bucket];
            if (items.length === 0) return null;
            return (
              <section key={group.bucket}>
                <div className="mb-3 flex items-center gap-2">
                  <h2 className="text-sm font-semibold">{group.label}</h2>
                  <Badge
                    variant={
                      group.bucket === "overdue"
                        ? "destructive"
                        : group.bucket === "today"
                          ? "gold"
                          : "secondary"
                    }
                  >
                    <span className="num">{items.length}</span>
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {group.hint}
                  </span>
                </div>
                <div className="space-y-2.5">
                  {items.map((item) => (
                    <ReminderRow
                      key={item.id}
                      item={item}
                      bucket={group.bucket}
                      onComplete={() => setCompleting(item)}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <CompleteDialog
        item={completing}
        onOpenChange={(open) => !open && setCompleting(null)}
      />
    </>
  );
}

function ReminderRow({
  item,
  bucket,
  onComplete,
}: {
  item: ReminderItem;
  bucket: ReminderBucket;
  onComplete: () => void;
}) {
  const editDate = useEditFollowUpDate();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.dueDate);

  function saveDate() {
    setEditing(false);
    if (!draft || draft === item.dueDate) return;
    editDate.mutate(
      { id: item.id, dueDate: draft },
      {
        onSuccess: () => toast.success(`Follow-up moved to ${fmtDate(draft)}`),
        onError: () => {
          setDraft(item.dueDate);
          toast.error("Could not reschedule.");
        },
      },
    );
  }

  return (
    <div className="facet-top flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
      {/* Who + what */}
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium">{item.customer}</p>
          <Badge variant="outline" className="text-[10px]">
            {LEAD_SOURCE_LABELS[item.source]}
          </Badge>
          <span className="text-[11px] text-muted-foreground">
            {item.leadRef} · Follow-up {item.seq}
          </span>
        </div>
        <p className="mt-1 truncate text-sm text-muted-foreground">
          {item.interest}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {item.phone ? (
            <a
              href={`tel:${item.phone}`}
              className="inline-flex items-center gap-1 hover:text-foreground"
            >
              <Phone className="h-3 w-3" /> {item.phone}
            </a>
          ) : null}
          <span className="inline-flex items-center gap-1">
            <StoreIcon className="h-3 w-3" /> {item.storeName}
          </span>
        </div>
      </div>

      {/* Due date + actions */}
      <div className="flex shrink-0 items-center gap-2 sm:flex-col sm:items-end sm:gap-2">
        {editing ? (
          <div className="flex items-center gap-1.5">
            <Input
              type="date"
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onBlur={saveDate}
              className="h-8 w-[9.5rem]"
            />
            <Button size="sm" className="h-8" onClick={saveDate}>
              Save
            </Button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              setDraft(item.dueDate);
              setEditing(true);
            }}
            className={cnDue(bucket)}
            title="Edit due date"
          >
            <CalendarClock className="h-3.5 w-3.5" />
            <span className="num">{fmtDate(item.dueDate)}</span>
            <Pencil className="h-3 w-3 opacity-60" />
          </button>
        )}

        <Button
          size="sm"
          variant="gold"
          className="h-8"
          onClick={onComplete}
          disabled={editDate.isPending}
        >
          <Check className="h-4 w-4" /> Done
        </Button>
      </div>
    </div>
  );
}

/** Due-date chip styling, tinted by urgency bucket. */
function cnDue(bucket: ReminderBucket) {
  const base =
    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors";
  if (bucket === "overdue")
    return `${base} border-transparent bg-[color-mix(in_srgb,var(--destructive)_14%,transparent)] text-destructive`;
  if (bucket === "today")
    return `${base} border-transparent bg-[color-mix(in_srgb,var(--gold)_16%,transparent)] text-gold-strong`;
  return `${base} border-border text-muted-foreground hover:text-foreground`;
}

function CompleteDialog({
  item,
  onOpenChange,
}: {
  item: ReminderItem | null;
  onOpenChange: (open: boolean) => void;
}) {
  const complete = useCompleteFollowUp();
  const [note, setNote] = useState("");

  function confirm() {
    if (!item) return;
    complete.mutate(
      { id: item.id, note: note.trim() || undefined },
      {
        onSuccess: () => {
          toast.success(`Follow-up with ${item.customer} marked done`);
          setNote("");
          onOpenChange(false);
        },
        onError: () => toast.error("Could not mark done."),
      },
    );
  }

  return (
    <Dialog
      open={!!item}
      onOpenChange={(open) => {
        if (!open) setNote("");
        onOpenChange(open);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mark follow-up done</DialogTitle>
          <DialogDescription>
            {item
              ? `${item.customer} · ${item.leadRef} · Follow-up ${item.seq}`
              : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="fu-note">Remark (optional)</Label>
          <Textarea
            id="fu-note"
            placeholder="e.g. Spoke to customer — coming in Saturday to finalise."
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="gold"
            onClick={confirm}
            disabled={complete.isPending}
          >
            <Check className="h-4 w-4" />
            {complete.isPending ? "Saving…" : "Mark done"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
