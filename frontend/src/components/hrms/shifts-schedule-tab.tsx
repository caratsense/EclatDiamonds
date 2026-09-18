"use client";

import { useMemo, useState } from "react";
import {
  CalendarDays,
  Clock,
  Moon,
  Pencil,
  Plus,
  Sun,
  Trash2,
} from "lucide-react";
import { AxiosError } from "axios";
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
import { useStoresAdmin } from "@/lib/queries/stores";
import {
  StoreScopeField,
  useStoreScope,
} from "@/components/common/store-scope-field";
import {
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
import {
  useDeleteHoliday,
  useDeleteShift,
  useUpdateHoliday,
  useUpdateShift,
} from "@/lib/queries/hrms-ops";
import { ReasonDialog } from "@/components/hrms/attendance-edit-dialog";
import { ShiftAssignments } from "@/components/hrms/shift-assignments";
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
  const [editingShift, setEditingShift] = useState<Shift | null>(null);
  const [deletingShift, setDeletingShift] = useState<Shift | null>(null);
  const [forceDelete, setForceDelete] = useState(false);
  const deleteShift = useDeleteShift();

  function removeShift(shift: Shift, force: boolean) {
    deleteShift.mutate(
      { id: shift.id, force },
      {
        onSuccess: () => {
          toast.success(`Shift ${shift.name} deleted`);
          setDeletingShift(null);
          setForceDelete(false);
        },
        onError: (err) => {
          // 409 = staff are still on it; offer the explicit unassign-and-delete.
          if (!force && err instanceof AxiosError && err.response?.status === 409) {
            setForceDelete(true);
            return;
          }
          toast.error(apiErrorMessage(err, "Could not delete the shift."));
        },
      },
    );
  }

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
                      {s.code ? (
                        <Badge variant="outline" className="num">
                          {s.code}
                        </Badge>
                      ) : null}
                      <p className="font-medium">{s.name}</p>
                      {s.isFlexible ? <Badge variant="gold">Flexible</Badge> : null}
                      {s.isNightBatch ? (
                        <Badge variant="secondary" className="gap-1">
                          <Moon className="h-3 w-3" />
                          Night / 2nd batch
                        </Badge>
                      ) : null}
                    </div>
                    <p className="num text-xs text-muted-foreground">
                      {s.startTime}–{s.endTime}
                      {s.isFlexible ? " · never marked late" : ""}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {s.isFlexible ? null : (
                    <Badge variant="outline" className="w-fit">
                      <span className="num">{s.bufferMins}</span>
                      &nbsp;min grace
                    </Badge>
                  )}
                  {canEdit ? (
                    <>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Edit shift ${s.name}`}
                        onClick={() => setEditingShift(s)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive"
                        aria-label={`Delete shift ${s.name}`}
                        onClick={() => {
                          setForceDelete(false);
                          setDeletingShift(s);
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </>
                  ) : null}
                </div>
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

      <ShiftAssignments
        storeId={targetStoreId}
        shifts={shifts.filter((s) => s.storeId === targetStoreId)}
        canEdit={canEdit}
      />

      {shiftOpen ? (
        <ShiftDialog
          open
          onOpenChange={setShiftOpen}
          storeId={targetStoreId}
          storeName={storeLabel}
        />
      ) : null}
      {editingShift ? (
        <ShiftDialog
          key={editingShift.id}
          open
          onOpenChange={(o) => (o ? null : setEditingShift(null))}
          storeId={editingShift.storeId}
          storeName={storeLabel}
          shift={editingShift}
        />
      ) : null}
      {deletingShift ? (
        <ReasonDialog
          key={`${deletingShift.id}-${forceDelete}`}
          open
          onOpenChange={(o) => (o ? null : setDeletingShift(null))}
          title={forceDelete ? "Staff are still on this shift" : `Delete shift ${deletingShift.name}?`}
          description={
            forceDelete
              ? "It is assigned to staff or was used today. Deleting it anyway ends those assignments; their days fall back to the store's default shift."
              : "Attendance already recorded keeps its times."
          }
          withReason={false}
          confirmLabel={forceDelete ? "Unassign and delete" : "Delete shift"}
          destructive
          pending={deleteShift.isPending}
          onConfirm={() => removeShift(deletingShift, forceDelete)}
        />
      ) : null}
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
  // The store's own saved value, not a hardcoded default: the control used to
  // seed from a constant, so it could confidently display a day that was not
  // the one actually configured.
  const { data: stores } = useStoresAdmin();
  const saved0 = stores?.find((s) => s.id === storeId)?.weekOffDay ?? null;
  const [day, setDay] = useState<number | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  // `?? saved0` keeps the card correct on first render and after the query
  // resolves, while still honouring a change the user just made.
  const shownDay = day ?? saved0 ?? 0;
  const shownSaved = saved ?? saved0;

  function save() {
    if (!storeId) {
      toast.error("Select a store first.");
      return;
    }
    setWeekOff.mutate(
      { storeId, weekOffDay: shownDay },
      {
        onSuccess: () => {
          setSaved(shownDay);
          toast.success(`Weekly off set to ${WEEK_DAYS[shownDay]}`, {
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
            const active = shownDay === idx;
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
            Current:{" "}
            <span className="font-medium text-foreground">
              {/* No weekly off configured is a real state, and saying "Sunday"
                  when nothing is set is how a wrong roster gets published. */}
              {shownSaved == null ? "not set" : WEEK_DAYS[shownSaved]}
            </span>
          </p>
          {canEdit ? (
            <Button
              size="sm"
              variant="outline"
              onClick={save}
              disabled={setWeekOff.isPending || shownDay === shownSaved}
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
  const deleteHoliday = useDeleteHoliday();
  const [date, setDate] = useState("");
  const [label, setLabel] = useState("");
  const [editing, setEditing] = useState<Holiday | null>(null);
  const [deleting, setDeleting] = useState<Holiday | null>(null);

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
                <span className="flex items-center gap-1">
                  <span className="num text-xs text-muted-foreground">
                    {formatHolidayDate(h.date)}
                  </span>
                  {canEdit ? (
                    <>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Edit holiday ${h.label}`}
                        onClick={() => setEditing(h)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive"
                        aria-label={`Delete holiday ${h.label}`}
                        onClick={() => setDeleting(h)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </>
                  ) : null}
                </span>
              </div>
            ))
          )}
        </div>
      </CardContent>

      {editing ? (
        <EditHolidayDialog key={editing.id} holiday={editing} onClose={() => setEditing(null)} />
      ) : null}
      {deleting ? (
        <ReasonDialog
          key={deleting.id}
          open
          onOpenChange={(o) => (o ? null : setDeleting(null))}
          title={`Delete ${deleting.label}?`}
          description={`${formatHolidayDate(deleting.date)} becomes a normal working day for ${storeName}.`}
          withReason={false}
          confirmLabel="Delete holiday"
          destructive
          pending={deleteHoliday.isPending}
          onConfirm={() =>
            deleteHoliday.mutate(deleting.id, {
              onSuccess: () => {
                toast.success("Holiday deleted");
                setDeleting(null);
              },
              onError: (err) => toast.error(apiErrorMessage(err, "Could not delete the holiday.")),
            })
          }
        />
      ) : null}
    </Card>
  );
}

function EditHolidayDialog({ holiday, onClose }: { holiday: Holiday; onClose: () => void }) {
  const update = useUpdateHoliday();
  const [date, setDate] = useState(holiday.date);
  const [label, setLabel] = useState(holiday.label);

  function save() {
    if (!date) {
      toast.error("Pick a date for the holiday.");
      return;
    }
    update.mutate(
      { id: holiday.id, date, label: label.trim() || undefined },
      {
        onSuccess: () => {
          toast.success("Holiday updated");
          onClose();
        },
        onError: (err) => toast.error(apiErrorMessage(err, "Could not update the holiday.")),
      },
    );
  }

  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit holiday</DialogTitle>
          <DialogDescription>Changes apply to this store only.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="eh-date">Date</Label>
            <Input id="eh-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="eh-label">Label</Label>
            <Input id="eh-label" value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={update.isPending}>
            {update.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Add / edit shift dialog                                             */
/* ------------------------------------------------------------------ */

/** Mounted per open (and keyed per shift when editing) so it seeds from props. */
function ShiftDialog({
  open,
  onOpenChange,
  storeId,
  storeName,
  shift,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  storeId: string;
  storeName: string;
  /** Present = edit this shift; absent = add a new one. */
  shift?: Shift;
}) {
  const createShift = useCreateShift();
  const updateShift = useUpdateShift();
  const [name, setName] = useState(shift?.name ?? "");
  const [code, setCode] = useState(shift?.code ?? "");
  const [startTime, setStartTime] = useState(shift?.startTime ?? "");
  const [endTime, setEndTime] = useState(shift?.endTime ?? "");
  const [bufferMins, setBufferMins] = useState(String(shift?.bufferMins ?? 15));
  const [isNightBatch, setIsNightBatch] = useState(shift?.isNightBatch ?? false);
  const [isFlexible, setIsFlexible] = useState(shift?.isFlexible ?? false);
  const pending = createShift.isPending || updateShift.isPending;

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
    const fields = {
      name: name.trim(),
      startTime,
      endTime,
      bufferMins: Number.isFinite(buffer) ? buffer : undefined,
      isNightBatch,
    };
    const done = {
      onSuccess: () => {
        toast.success(shift ? "Shift updated" : "Shift added", {
          description: `${fields.name} · ${startTime}–${endTime} · ${storeName}.`,
        });
        onOpenChange(false);
      },
      onError: (err: unknown) =>
        toast.error(
          apiErrorMessage(err, shift ? "Could not update the shift." : "Could not add the shift."),
        ),
    };
    if (shift) {
      updateShift.mutate({ id: shift.id, ...fields, code: code.trim() || null, isFlexible }, done);
    } else {
      // New fields only when used, so an API that predates them still accepts the add.
      createShift.mutate(
        {
          storeId,
          ...fields,
          ...(code.trim() ? { code: code.trim() } : {}),
          ...(isFlexible ? { isFlexible } : {}),
        },
        done,
      );
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{shift ? "Edit shift" : "Add shift"}</DialogTitle>
          <DialogDescription>
            Shifts belong to {storeName}. Lateness is scored against this
            shift&apos;s start&nbsp;+&nbsp;buffer.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-[1fr_6rem] gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="shift-name">Shift name</Label>
              <Input
                id="shift-name"
                placeholder="e.g. Morning / Second batch"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="shift-code">Code</Label>
              <Input
                id="shift-code"
                placeholder="S"
                maxLength={8}
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
              />
            </div>
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
          <label className="flex items-start gap-3 rounded-lg border px-3 py-2.5 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4"
              checked={isFlexible}
              onChange={(e) => setIsFlexible(e.target.checked)}
            />
            <span>
              <span className="font-medium">Flexible shift</span>
              <span className="block text-xs text-muted-foreground">
                No fixed start: never marked late or early-out.
              </span>
            </span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={pending}>
            {pending ? "Saving…" : shift ? "Save shift" : "Add shift"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
