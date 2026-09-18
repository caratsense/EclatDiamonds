"use client";

import { useState } from "react";
import { Ban, Plus } from "lucide-react";
import { toast } from "sonner";

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  StoreScopeField,
  useStoreScope,
} from "@/components/common/store-scope-field";
import { ReasonDialog } from "@/components/hrms/attendance-edit-dialog";
import { useStaff } from "@/lib/queries/users";
import {
  useAddPunch,
  usePunches,
  useVoidPunch,
  type RawPunch,
} from "@/lib/queries/hrms-ops";
import { apiErrorMessage } from "@/lib/utils";

export interface PunchTarget {
  userId: string;
  name: string;
  storeId: string;
  /** YYYY-MM-DD */
  date: string;
}

function localTime(p: RawPunch): string {
  return (
    p.local ??
    new Date(p.eventAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })
  );
}

/**
 * The raw punch ledger behind one register row. Punches are append-only: a
 * wrong one is voided (kept, struck through), never deleted.
 */
export function PunchLogSheet({
  target,
  onClose,
  canEdit,
}: {
  target: PunchTarget | null;
  onClose: () => void;
  canEdit: boolean;
}) {
  const query = usePunches(
    { from: target?.date ?? "", to: target?.date ?? "", userId: target?.userId },
    { enabled: !!target },
  );
  const voidPunch = useVoidPunch();
  const [voiding, setVoiding] = useState<RawPunch | null>(null);
  const [adding, setAdding] = useState(false);
  const punches = [...(query.data ?? [])].sort((a, b) => a.eventAt.localeCompare(b.eventAt));

  return (
    <Dialog open={!!target} onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent className="left-auto right-0 top-0 flex h-dvh max-w-md translate-x-0 translate-y-0 flex-col overflow-y-auto rounded-none sm:rounded-none">
        <DialogHeader>
          <DialogTitle>Punch log</DialogTitle>
          <DialogDescription>
            {target?.name} · <span className="num">{target?.date}</span>. Every punch
            as it arrived; the register row is computed from these.
          </DialogDescription>
        </DialogHeader>

        {canEdit ? (
          <Button size="sm" variant="outline" className="w-fit" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" />
            Add punch
          </Button>
        ) : null}

        <div className="space-y-2">
          {query.isLoading ? (
            <>
              <Skeleton className="h-16 rounded-lg" />
              <Skeleton className="h-16 rounded-lg" />
            </>
          ) : query.isError ? (
            <div className="rounded-lg border bg-muted/30 p-4 text-center">
              <p className="text-sm font-medium">Couldn&apos;t load the punches.</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => query.refetch()}>
                Retry
              </Button>
            </div>
          ) : punches.length === 0 ? (
            <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
              No punches recorded for this day.
            </p>
          ) : (
            punches.map((p) => (
              <div
                key={p.id}
                className={
                  "flex items-start justify-between gap-3 rounded-lg border p-3" +
                  (p.voidedAt ? " opacity-60" : "")
                }
              >
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={p.kind === "in" ? "success" : "secondary"}>
                      {p.kind === "in" ? "In" : "Out"}
                    </Badge>
                    <span className={"num font-medium" + (p.voidedAt ? " line-through" : "")}>
                      {localTime(p)}
                    </span>
                    <Badge variant="outline">{p.source}</Badge>
                    {p.voidedAt ? <Badge variant="destructive">Voided</Badge> : null}
                  </div>
                  {p.lat != null && p.lng != null ? (
                    <p className="num text-xs text-muted-foreground">
                      {p.lat.toFixed(5)}, {p.lng.toFixed(5)}
                      {p.accuracyM != null ? ` ±${p.accuracyM} m` : ""}
                    </p>
                  ) : null}
                  {p.note ? <p className="text-xs text-muted-foreground">{p.note}</p> : null}
                </div>
                {canEdit && !p.voidedAt ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Void ${p.kind} punch at ${localTime(p)}`}
                    onClick={() => setVoiding(p)}
                  >
                    <Ban className="h-4 w-4" />
                    Void
                  </Button>
                ) : null}
              </div>
            ))
          )}
        </div>

        {voiding ? (
          <ReasonDialog
            key={voiding.id}
            open
            onOpenChange={(o) => (o ? null : setVoiding(null))}
            title="Void this punch?"
            description={`The ${voiding.kind} punch at ${localTime(voiding)} stays in the log as evidence but no longer counts. Re-run processing or edit the day to recompute.`}
            confirmLabel="Void punch"
            destructive
            pending={voidPunch.isPending}
            onConfirm={(reason) =>
              voidPunch.mutate(
                { id: voiding.id, reason },
                {
                  onSuccess: () => {
                    toast.success("Punch voided");
                    setVoiding(null);
                  },
                  onError: (err) => toast.error(apiErrorMessage(err, "Could not void the punch.")),
                },
              )
            }
          />
        ) : null}

        {adding && target ? (
          <AddPunchDialog open onOpenChange={setAdding} preset={target} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Add a manager punch. With a `preset` the person and day are fixed (from a
 * register row); without one the manager picks the store and staff member.
 * Mount conditionally so each open starts blank.
 */
export function AddPunchDialog({
  open,
  onOpenChange,
  preset,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preset?: PunchTarget;
}) {
  const scope = useStoreScope();
  const storeId = preset?.storeId ?? scope.targetStoreId;
  const { data: staff = [] } = useStaff(storeId || undefined, { enabled: !preset && !!storeId });
  const addPunch = useAddPunch();
  const [userId, setUserId] = useState(preset?.userId ?? "");
  const [date, setDate] = useState(preset?.date ?? "");
  const [time, setTime] = useState("");
  const [kind, setKind] = useState<"in" | "out">("in");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Record<string, boolean>>({});

  function save() {
    const next = {
      store: !storeId,
      userId: !userId,
      date: !date,
      time: !time,
      note: !note.trim(),
    };
    if (Object.values(next).some(Boolean)) {
      setErrors(next);
      return;
    }
    // ponytail: the time is read in the browser's timezone — right while every
    // store and manager sits in IST; send store-local HH:MM if that changes.
    const at = new Date(`${date}T${time}:00`).toISOString();
    addPunch.mutate(
      { userId, storeId, kind, at, note: note.trim() },
      {
        onSuccess: () => {
          toast.success("Punch added", { description: "The day is recomputed from the punches." });
          onOpenChange(false);
        },
        onError: (err) => toast.error(apiErrorMessage(err, "Could not add the punch.")),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add punch</DialogTitle>
          <DialogDescription>
            {preset
              ? `For ${preset.name}. Recorded as a manager punch and audited.`
              : "Record a missed punch. It is recorded as a manager punch and audited."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          {preset ? null : (
            <>
              <StoreScopeField value={scope.pickedStoreId} onChange={scope.setPickedStoreId} />
              <div className="grid gap-1.5">
                <Label htmlFor="ap-staff">
                  Staff member <span className="text-destructive">*</span>
                </Label>
                <Select value={userId} onValueChange={setUserId}>
                  <SelectTrigger id="ap-staff" aria-invalid={errors.userId}>
                    <SelectValue placeholder={storeId ? "Select staff" : "Pick a store first"} />
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
            </>
          )}
          <div className="grid grid-cols-3 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="ap-kind">Kind</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as "in" | "out")}>
                <SelectTrigger id="ap-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="in">In</SelectItem>
                  <SelectItem value="out">Out</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ap-date">Date</Label>
              <Input
                id="ap-date"
                type="date"
                value={date}
                disabled={!!preset}
                aria-invalid={errors.date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ap-time">Time</Label>
              <Input
                id="ap-time"
                type="time"
                value={time}
                aria-invalid={errors.time}
                onChange={(e) => setTime(e.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ap-note">
              Reason <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="ap-note"
              value={note}
              aria-invalid={errors.note}
              placeholder="e.g. Forgot to punch out; seen closing the store at 20:05"
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          {Object.values(errors).some(Boolean) ? (
            <p className="text-xs text-destructive">
              Store, staff member, date, time and a reason are all required.
            </p>
          ) : null}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={addPunch.isPending}>
            {addPunch.isPending ? "Saving…" : "Add punch"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
