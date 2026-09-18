"use client";

import { useState } from "react";
import { toast } from "sonner";

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  ATTENDANCE_STATUS_LABELS,
  type AttendanceStatus,
} from "@/lib/mock/hrms";
import { useShifts } from "@/lib/queries/hrms";
import { useEditAttendance } from "@/lib/queries/hrms-ops";
import { apiErrorMessage } from "@/lib/utils";

/** Primary day states a correction may set. `late` is derived, never chosen. */
const EDIT_STATUSES: AttendanceStatus[] = [
  "present",
  "half_day",
  "absent",
  "on_leave",
  "week_off",
  "holiday",
];

export interface EditableAttendance {
  recordId: string;
  name: string;
  storeId: string;
  /** YYYY-MM-DD, store-local. */
  date?: string;
  status: string;
  /** HH:MM store-local. */
  checkIn: string | null;
  checkOut: string | null;
  shiftId?: string | null;
}

/**
 * Correct one register row. The backend recomputes late / early-out / overtime
 * / day credit and appends a manager punch for any time that changed.
 * Remount per record (`key={record.recordId}`) so the form seeds from props.
 */
export function AttendanceEditDialog({
  record,
  onClose,
}: {
  record: EditableAttendance | null;
  onClose: () => void;
}) {
  const edit = useEditAttendance();
  const { data: allShifts = [] } = useShifts();
  const shifts = allShifts.filter((s) => !record || s.storeId === record.storeId);
  // "late" rows are present-and-late; the correction speaks in primary states.
  const initialStatus =
    record?.status === "late" ? "present" : (record?.status as AttendanceStatus) ?? "present";
  const [status, setStatus] = useState<AttendanceStatus>(initialStatus);
  const [checkIn, setCheckIn] = useState(record?.checkIn ?? "");
  const [checkOut, setCheckOut] = useState(record?.checkOut ?? "");
  const [shiftId, setShiftId] = useState(record?.shiftId ?? "");
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState(false);

  function save() {
    if (!record) return;
    if (!note.trim()) {
      setNoteError(true);
      return;
    }
    edit.mutate(
      {
        id: record.recordId,
        ...(status !== initialStatus ? { status } : {}),
        ...(checkIn && checkIn !== record.checkIn ? { checkIn } : {}),
        ...(checkOut && checkOut !== record.checkOut ? { checkOut } : {}),
        ...(shiftId && shiftId !== record.shiftId ? { shiftId } : {}),
        note: note.trim(),
      },
      {
        onSuccess: () => {
          toast.success(`Attendance corrected for ${record.name}`);
          onClose();
        },
        onError: (err) => toast.error(apiErrorMessage(err, "Could not save the correction.")),
      },
    );
  }

  const worked = status === "present" || status === "half_day";

  return (
    <Dialog open={!!record} onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit attendance</DialogTitle>
          <DialogDescription>
            {record?.name}
            {record?.date ? ` · ${record.date}` : ""}. Times are store-local; the
            change is audited.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="ae-status">Status</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as AttendanceStatus)}>
              <SelectTrigger id="ae-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EDIT_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {ATTENDANCE_STATUS_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {worked ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="ae-in">Check-in</Label>
                <Input
                  id="ae-in"
                  type="time"
                  value={checkIn}
                  onChange={(e) => setCheckIn(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ae-out">Check-out</Label>
                <Input
                  id="ae-out"
                  type="time"
                  value={checkOut}
                  onChange={(e) => setCheckOut(e.target.value)}
                />
              </div>
            </div>
          ) : null}
          {worked && shifts.length > 0 ? (
            <div className="grid gap-1.5">
              <Label htmlFor="ae-shift">Shift</Label>
              <Select value={shiftId} onValueChange={setShiftId}>
                <SelectTrigger id="ae-shift">
                  <SelectValue placeholder="Keep current shift" />
                </SelectTrigger>
                <SelectContent>
                  {shifts.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.code ? `${s.code} · ` : ""}
                      {s.name} · {s.isFlexible ? "Flexible" : `${s.startTime}–${s.endTime}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="grid gap-1.5">
            <Label htmlFor="ae-note">
              Reason for the correction <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="ae-note"
              value={note}
              aria-invalid={noteError}
              placeholder="e.g. Biometric was down; confirmed with the store manager"
              onChange={(e) => {
                setNote(e.target.value);
                setNoteError(false);
              }}
            />
            {noteError ? (
              <p className="text-xs text-destructive">A reason is required.</p>
            ) : null}
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={edit.isPending}>
            {edit.isPending ? "Saving…" : "Save correction"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Confirmation with a typed reason — every destructive or decision action in
 * the attendance screens goes through this. Mount with a `key` per target so
 * the reason starts empty each time.
 */
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  label = "Reason",
  confirmLabel,
  destructive,
  required = true,
  withReason = true,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  label?: string;
  confirmLabel: string;
  destructive?: boolean;
  required?: boolean;
  /** false = a plain yes/no confirmation. */
  withReason?: boolean;
  pending?: boolean;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState(false);

  function confirm() {
    if (withReason && required && !reason.trim()) {
      setError(true);
      return;
    }
    onConfirm(reason.trim());
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {withReason ? (
        <div className="grid gap-1.5">
          <Label htmlFor="reason-text">
            {label}
            {required ? <span className="text-destructive"> *</span> : " (optional)"}
          </Label>
          <Textarea
            id="reason-text"
            value={reason}
            aria-invalid={error}
            onChange={(e) => {
              setReason(e.target.value);
              setError(false);
            }}
          />
          {error ? <p className="text-xs text-destructive">A reason is required.</p> : null}
        </div>
        ) : null}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            onClick={confirm}
            disabled={pending}
          >
            {pending ? "Working…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
