"use client";

import { useState } from "react";
import { Pencil, Plus, Trash2, UserCog } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { Skeleton } from "@/components/ui/skeleton";
import { ReasonDialog } from "@/components/hrms/attendance-edit-dialog";
import type { Shift } from "@/lib/mock/hrms";
import { useStaff } from "@/lib/queries/users";
import {
  useCreateShiftAssignment,
  useDeleteShiftAssignment,
  useShiftAssignments,
  useUpdateShiftAssignment,
  type ShiftAssignmentRow,
} from "@/lib/queries/hrms-ops";
import { apiErrorMessage } from "@/lib/utils";

const day = (s: string | null) => (s ? s.slice(0, 10) : "");

function shiftText(s: Shift): string {
  return `${s.code ? `${s.code} · ` : ""}${s.name} · ${s.isFlexible ? "Flexible" : `${s.startTime}–${s.endTime}`}`;
}

/**
 * Who works which shift from when. A new assignment closes the person's open
 * one the day before; lateness and day-close use the one effective that day.
 */
export function ShiftAssignments({
  storeId,
  shifts,
  canEdit,
}: {
  storeId: string;
  shifts: Shift[];
  canEdit: boolean;
}) {
  const query = useShiftAssignments({ storeId: storeId || undefined });
  const { data: staff = [] } = useStaff(storeId || undefined, { enabled: !!storeId });
  const create = useCreateShiftAssignment();
  const del = useDeleteShiftAssignment();
  const [userId, setUserId] = useState("");
  const [shiftId, setShiftId] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toLocaleDateString("en-CA"));
  const [editing, setEditing] = useState<ShiftAssignmentRow | null>(null);
  const [deleting, setDeleting] = useState<ShiftAssignmentRow | null>(null);

  const staffName = (r: ShiftAssignmentRow) =>
    r.userName ?? r.name ?? staff.find((s) => s.id === r.userId)?.name ?? "Unknown";
  const shiftName = (r: ShiftAssignmentRow) => {
    const s = shifts.find((x) => x.id === r.shiftId);
    return s ? shiftText(s) : (r.shiftName ?? r.shift?.name ?? "Unknown shift");
  };

  const rows = [...(query.data ?? [])].sort(
    (a, b) => staffName(a).localeCompare(staffName(b)) || b.effectiveFrom.localeCompare(a.effectiveFrom),
  );

  function add() {
    if (!storeId) {
      toast.error("Select a store first.");
      return;
    }
    if (!userId || !shiftId || !effectiveFrom) {
      toast.error("Choose the person, the shift and the start date.");
      return;
    }
    create.mutate(
      { userId, shiftId, effectiveFrom },
      {
        onSuccess: () => {
          toast.success("Shift assigned");
          setUserId("");
          setShiftId("");
        },
        onError: (err) => toast.error(apiErrorMessage(err, "Could not assign the shift.")),
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserCog className="h-4 w-4 text-muted-foreground" />
          Shift assignments
        </CardTitle>
        <CardDescription>
          Who works which shift, from which date. Assigning a new shift ends the
          person&apos;s current one the day before.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {canEdit && storeId ? (
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end">
            <div className="grid gap-1.5">
              <Label htmlFor="sa-user">Employee</Label>
              <Select value={userId} onValueChange={setUserId}>
                <SelectTrigger id="sa-user">
                  <SelectValue placeholder="Choose" />
                </SelectTrigger>
                <SelectContent>
                  {staff.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="sa-shift">Shift</Label>
              <Select value={shiftId} onValueChange={setShiftId}>
                <SelectTrigger id="sa-shift">
                  <SelectValue placeholder={shifts.length ? "Choose" : "Add a shift first"} />
                </SelectTrigger>
                <SelectContent>
                  {shifts.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {shiftText(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="sa-from">From</Label>
              <Input
                id="sa-from"
                type="date"
                value={effectiveFrom}
                onChange={(e) => setEffectiveFrom(e.target.value)}
              />
            </div>
            <Button variant="outline" onClick={add} disabled={create.isPending}>
              <Plus className="h-4 w-4" />
              Assign
            </Button>
          </div>
        ) : null}

        {!storeId ? (
          <p className="rounded-lg border border-dashed py-6 text-center text-xs text-muted-foreground">
            Pick a store to see its shift assignments.
          </p>
        ) : query.isLoading ? (
          <Skeleton className="h-14 rounded-lg" />
        ) : query.isError ? (
          <p className="text-sm text-destructive">
            Couldn&apos;t load assignments.{" "}
            <button type="button" className="underline" onClick={() => query.refetch()}>
              Retry
            </button>
          </p>
        ) : rows.length === 0 ? (
          <p className="rounded-lg border border-dashed py-6 text-center text-xs text-muted-foreground">
            Nobody has an assigned shift yet — everyone falls back to the store&apos;s default shift.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {rows.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">{staffName(r)}</p>
                  <p className="text-xs text-muted-foreground">{shiftName(r)}</p>
                </div>
                <div className="flex items-center gap-1.5">
                  <Badge variant={r.effectiveTo ? "outline" : "success"} className="num">
                    {day(r.effectiveFrom)} → {r.effectiveTo ? day(r.effectiveTo) : "open"}
                  </Badge>
                  {canEdit ? (
                    <>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Edit assignment for ${staffName(r)}`}
                        onClick={() => setEditing(r)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="text-destructive"
                        aria-label={`Delete assignment for ${staffName(r)}`}
                        onClick={() => setDeleting(r)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {editing ? (
        <EditAssignmentDialog
          key={editing.id}
          row={editing}
          name={staffName(editing)}
          shifts={shifts}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {deleting ? (
        <ReasonDialog
          key={deleting.id}
          open
          onOpenChange={(o) => (o ? null : setDeleting(null))}
          title={`Remove ${staffName(deleting)}'s assignment?`}
          description={`${shiftName(deleting)} from ${day(deleting.effectiveFrom)}. Days in that range fall back to the store's default shift.`}
          withReason={false}
          confirmLabel="Remove"
          destructive
          pending={del.isPending}
          onConfirm={() =>
            del.mutate(deleting.id, {
              onSuccess: () => {
                toast.success("Assignment removed");
                setDeleting(null);
              },
              onError: (err) => toast.error(apiErrorMessage(err, "Could not remove the assignment.")),
            })
          }
        />
      ) : null}
    </Card>
  );
}

function EditAssignmentDialog({
  row,
  name,
  shifts,
  onClose,
}: {
  row: ShiftAssignmentRow;
  name: string;
  shifts: Shift[];
  onClose: () => void;
}) {
  const update = useUpdateShiftAssignment();
  const [shiftId, setShiftId] = useState(row.shiftId);
  const [effectiveFrom, setEffectiveFrom] = useState(day(row.effectiveFrom));
  const [effectiveTo, setEffectiveTo] = useState(day(row.effectiveTo));

  function save() {
    if (effectiveTo && effectiveTo < effectiveFrom) {
      toast.error("The end date is before the start date.");
      return;
    }
    update.mutate(
      { id: row.id, shiftId, effectiveFrom, effectiveTo: effectiveTo || null },
      {
        onSuccess: () => {
          toast.success("Assignment updated");
          onClose();
        },
        onError: (err) => toast.error(apiErrorMessage(err, "Could not update the assignment.")),
      },
    );
  }

  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit shift assignment</DialogTitle>
          <DialogDescription>{name}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="ea-shift">Shift</Label>
            <Select value={shiftId} onValueChange={setShiftId}>
              <SelectTrigger id="ea-shift">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {shifts.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {shiftText(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="ea-from">From</Label>
              <Input id="ea-from" type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ea-to">To (blank = open)</Label>
              <Input
                id="ea-to"
                type="date"
                value={effectiveTo}
                min={effectiveFrom}
                onChange={(e) => setEffectiveTo(e.target.value)}
              />
            </div>
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
