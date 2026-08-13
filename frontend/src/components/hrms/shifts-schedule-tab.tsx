"use client";

import { useMemo, useState } from "react";
import {
  CalendarDays,
  Clock,
  Moon,
  Plus,
  Sun,
} from "lucide-react";
import { toast } from "sonner";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { cn, apiErrorMessage } from "@/lib/utils";
import {
  StoreScopeField,
  useStoreScope,
} from "@/components/common/store-scope-field";
import {
  MOCK_WEEK_OFF,
  WEEK_DAYS,
  WEEK_DAYS_SHORT,
  type Holiday,
  type Shift,
} from "@/lib/mock/hrms";
import {
  useAddHoliday,
  useCreateShift,
  useSetWeekOff,
} from "@/lib/queries/hrms";
import { ROLE_RANK } from "@/lib/types";
import { useSession } from "@/store/use-session";

/** Parse a 'yyyy-mm-dd' string into a *local* Date (no tz drift). */
function parseISODate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

function formatHolidayDate(iso: string): string {
  return parseISODate(iso).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

interface ShiftsScheduleTabProps {
  shifts: Shift[];
  holidays: Holiday[];
}

export function ShiftsScheduleTab({ shifts, holidays }: ShiftsScheduleTabProps) {
  const { targetStoreId, storeLabel, pickedStoreId, setPickedStoreId } =
    useStoreScope();
  // Salespeople are view-only for shifts / week-off / holidays; store_manager+
  // may edit (the backend enforces the same via @Roles('store_manager'+)).
  const role = useSession((s) => s.role);
  const canEdit = ROLE_RANK[role] >= ROLE_RANK.store_manager;

  const [shiftOpen, setShiftOpen] = useState(false);

  // Upcoming holidays only (today onward), soonest first.
  const upcoming = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return [...holidays]
      .filter((h) => parseISODate(h.date) >= today)
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [holidays]);

  return (
    <div className="space-y-4">
      <StoreScopeField value={pickedStoreId} onChange={setPickedStoreId} />

      {/* --- Shifts / batches --------------------------------------- */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              Shifts &amp; batches
            </CardTitle>
            <CardDescription>
              Second-batch staff aren&apos;t marked late — lateness is measured
              against their own shift start&nbsp;+&nbsp;buffer.
            </CardDescription>
          </div>
          {canEdit ? (
            <Button size="sm" className="shrink-0" onClick={() => setShiftOpen(true)}>
              <Plus className="h-4 w-4" />
              Add shift
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-2">
          {shifts.length === 0 ? (
            <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
              No shifts for this store yet — add the morning and (for mall
              stores) the night / 2nd batch.
            </p>
          ) : (
            shifts.map((s) => (
              <div
                key={s.id}
                className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex items-center gap-3">
                  <div
                    className={cn(
                      "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
                      "bg-muted text-muted-foreground",
                    )}
                  >
                    {s.isNightBatch ? (
                      <Moon className="h-4 w-4" />
                    ) : (
                      <Sun className="h-4 w-4" />
                    )}
                  </div>
                  <div className="leading-tight">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium">{s.name}</p>
                      {s.isNightBatch ? (
                        <Badge variant="secondary" className="gap-1">
                          <Moon className="h-3 w-3" />
                          Night / 2nd batch
                        </Badge>
                      ) : null}
                    </div>
                    <p className="num text-xs text-muted-foreground">
                      {s.startTime}–{s.endTime}
                    </p>
                  </div>
                </div>
                <Badge variant="outline" className="w-fit shrink-0">
                  <span className="num">{s.bufferMins}</span>
                  &nbsp;min grace
                </Badge>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* --- Weekly off day -------------------------------------- */}
        <WeekOffCard
          storeId={targetStoreId}
          storeName={storeLabel}
          canEdit={canEdit}
        />

        {/* --- Store holidays -------------------------------------- */}
        <HolidaysCard
          storeId={targetStoreId}
          storeName={storeLabel}
          upcoming={upcoming}
          canEdit={canEdit}
        />
      </div>

      <AddShiftDialog
        open={shiftOpen}
        onOpenChange={setShiftOpen}
        storeId={targetStoreId}
        storeName={storeLabel}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Weekly-off selector                                                 */
/* ------------------------------------------------------------------ */

function WeekOffCard({
  storeId,
  storeName,
  canEdit,
}: {
  storeId: string;
  storeName: string;
  canEdit: boolean;
}) {
  const setWeekOff = useSetWeekOff();
  // No GET for week-off — seed from the known default, then track locally.
  const seeded = MOCK_WEEK_OFF[storeId] ?? 0;
  const [day, setDay] = useState<number>(seeded);
  const [saved, setSaved] = useState<number>(seeded);

  function save() {
    if (!storeId) {
      toast.error("Select a store first.");
      return;
    }
    setWeekOff.mutate(
      { storeId, weekOffDay: day },
      {
        onSuccess: () => {
          setSaved(day);
          toast.success(`Weekly off set to ${WEEK_DAYS[day]}`, {
            description: `Applies to ${storeName}.`,
          });
        },
        onError: (err) => toast.error(apiErrorMessage(err, "Could not update the weekly off.")),
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarDays className="h-4 w-4 text-muted-foreground" />
          Weekly off
        </CardTitle>
        <CardDescription>
          The store&apos;s recurring off day, set by head office.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-7 gap-1.5">
          {WEEK_DAYS_SHORT.map((label, idx) => {
            const active = day === idx;
            return (
              <button
                key={label}
                type="button"
                aria-pressed={active}
                disabled={!canEdit}
                onClick={() => setDay(idx)}
                className={cn(
                  "rounded-lg border py-2 text-xs font-medium transition-colors",
                  active
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-input text-muted-foreground hover:border-primary/40 hover:bg-accent",
                  !canEdit && "cursor-default opacity-60 hover:border-input hover:bg-transparent",
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            Current: <span className="font-medium text-foreground">{WEEK_DAYS[saved]}</span>
          </p>
          {canEdit ? (
            <Button
              size="sm"
              variant="outline"
              onClick={save}
              disabled={setWeekOff.isPending || day === saved}
            >
              {setWeekOff.isPending ? "Saving…" : "Save"}
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Holidays                                                            */
/* ------------------------------------------------------------------ */

function HolidaysCard({
  storeId,
  storeName,
  upcoming,
  canEdit,
}: {
  storeId: string;
  storeName: string;
  upcoming: Holiday[];
  canEdit: boolean;
}) {
  const addHoliday = useAddHoliday();
  const [date, setDate] = useState("");
  const [label, setLabel] = useState("");

  function add() {
    if (!storeId) {
      toast.error("Select a store first.");
      return;
    }
    if (!date) {
      toast.error("Pick a date for the holiday.");
      return;
    }
    addHoliday.mutate(
      { storeId, date, label: label.trim() || undefined },
      {
        onSuccess: () => {
          toast.success("Holiday added", {
            description: `${label.trim() || "Holiday"} · ${formatHolidayDate(date)} · ${storeName}.`,
          });
          setDate("");
          setLabel("");
        },
        onError: (err) => toast.error(apiErrorMessage(err, "Could not add the holiday.")),
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarDays className="h-4 w-4 text-muted-foreground" />
          Store holidays
        </CardTitle>
        <CardDescription>
          One-off closures for this store (festivals, maintenance).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {canEdit ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="grid flex-1 gap-1.5">
              <Label htmlFor="hol-date">Date</Label>
              <Input
                id="hol-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <div className="grid flex-1 gap-1.5">
              <Label htmlFor="hol-label">Label</Label>
              <Input
                id="hol-label"
                placeholder="e.g. Diwali"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
            <Button
              variant="outline"
              onClick={add}
              disabled={addHoliday.isPending}
              className="shrink-0"
            >
              <Plus className="h-4 w-4" />
              Add
            </Button>
          </div>
        ) : null}

        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Upcoming</p>
          {upcoming.length === 0 ? (
            <p className="rounded-lg border border-dashed py-6 text-center text-xs text-muted-foreground">
              No upcoming holidays for this store.
            </p>
          ) : (
            upcoming.map((h) => (
              <div
                key={h.id}
                className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2"
              >
                <span className="text-sm font-medium">{h.label}</span>
                <span className="num text-xs text-muted-foreground">
                  {formatHolidayDate(h.date)}
                </span>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Add-shift dialog                                                    */
/* ------------------------------------------------------------------ */

function AddShiftDialog({
  open,
  onOpenChange,
  storeId,
  storeName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  storeId: string;
  storeName: string;
}) {
  const createShift = useCreateShift();
  const [name, setName] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [bufferMins, setBufferMins] = useState("15");
  const [isNightBatch, setIsNightBatch] = useState(false);

  function reset() {
    setName("");
    setStartTime("");
    setEndTime("");
    setBufferMins("15");
    setIsNightBatch(false);
  }

  function save() {
    if (!storeId) {
      toast.error("Select a store first.");
      return;
    }
    if (!name.trim()) {
      toast.error("Shift name is required.");
      return;
    }
    if (!startTime || !endTime) {
      toast.error("Start and end times are required.");
      return;
    }
    const buffer = Number(bufferMins);
    createShift.mutate(
      {
        storeId,
        name: name.trim(),
        startTime,
        endTime,
        bufferMins: Number.isFinite(buffer) ? buffer : undefined,
        isNightBatch,
      },
      {
        onSuccess: () => {
          toast.success("Shift added", {
            description: `${name.trim()} · ${startTime}–${endTime} · ${storeName}.`,
          });
          reset();
          onOpenChange(false);
        },
        onError: (err) => toast.error(apiErrorMessage(err, "Could not add the shift.")),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add shift</DialogTitle>
          <DialogDescription>
            Shifts belong to {storeName}. Lateness is scored against this
            shift&apos;s start&nbsp;+&nbsp;buffer.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="shift-name">Shift name</Label>
            <Input
              id="shift-name"
              placeholder="e.g. Morning / Second batch"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="shift-start">Start time</Label>
              <Input
                id="shift-start"
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="shift-end">End time</Label>
              <Input
                id="shift-end"
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="shift-buffer">Buffer (minutes)</Label>
            <Input
              id="shift-buffer"
              type="number"
              min={0}
              inputMode="numeric"
              placeholder="15"
              value={bufferMins}
              onChange={(e) => setBufferMins(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Grace window after start before a check-in counts late.
            </p>
          </div>
          <button
            type="button"
            aria-pressed={isNightBatch}
            onClick={() => setIsNightBatch((v) => !v)}
            className={cn(
              "flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
              isNightBatch
                ? "border-primary bg-primary/10"
                : "border-input hover:border-primary/40 hover:bg-accent",
            )}
          >
            <span className="flex items-center gap-2">
              <Moon
                className={cn(
                  "h-4 w-4",
                  isNightBatch ? "text-primary" : "text-muted-foreground",
                )}
              />
              <span className="text-sm">
                <span className="font-medium">Night / 2nd batch</span>
                <span className="block text-xs text-muted-foreground">
                  Not marked late for the morning shift&apos;s start.
                </span>
              </span>
            </span>
            <span
              className={cn(
                "inline-flex h-5 w-9 shrink-0 items-center rounded-full border px-0.5 transition-colors",
                isNightBatch ? "bg-primary" : "bg-muted",
              )}
            >
              <span
                className={cn(
                  "h-4 w-4 rounded-full bg-background shadow transition-transform",
                  isNightBatch ? "translate-x-4" : "translate-x-0",
                )}
              />
            </span>
          </button>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={createShift.isPending}>
            {createShift.isPending ? "Saving…" : "Add shift"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
