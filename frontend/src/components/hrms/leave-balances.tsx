"use client";

import { useMemo, useState } from "react";
import { CalendarPlus, Pencil, Plus } from "lucide-react";
import { toast } from "sonner";

import {
  Card,
  CardContent,
} from "@/components/ui/card";
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
  LEAVE_TYPE_LABELS,
  LEAVE_TYPE_ORDER,
  type LeaveBalance,
  type LeaveType,
} from "@/lib/mock/hrms";
import { useLeaveBalances } from "@/lib/queries/hrms";
import {
  useCreateLeaveBalance,
  useEditLeaveBalance,
} from "@/lib/queries/hrms-ops";
import { useStaff } from "@/lib/queries/users";
import { apiErrorMessage } from "@/lib/utils";
import { ApplyLeaveDialog } from "@/components/hrms/apply-leave-dialog";

/**
 * Leave balances row + "Apply for leave" action (Module 6). Balances are the
 * current user's own (self-service); managers approve requests below in the list.
 */
export function LeaveBalances({ canEditTeam = false }: { canEditTeam?: boolean }) {
  const { data: balances = [], isLoading } = useLeaveBalances();
  const [applyOpen, setApplyOpen] = useState(false);

  // Index by type so we render in a fixed display order.
  const byType = useMemo(() => {
    const map = new Map<string, LeaveBalance>();
    for (const b of balances) map.set(b.type, b);
    return map;
  }, [balances]);

  // Financial-year label from the balance rows (e.g. "2026–27"), if present.
  const fyLabel = balances.find((b) => b.financialYearLabel)?.financialYearLabel;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">
            My leave balances{fyLabel ? ` · FY ${fyLabel}` : ""}
          </h3>
          <p className="text-xs text-muted-foreground">
            Remaining paid leave for {fyLabel ?? new Date().getFullYear()}.
          </p>
        </div>
        <Button size="sm" onClick={() => setApplyOpen(true)}>
          <CalendarPlus className="h-4 w-4" />
          Apply for leave
        </Button>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {LEAVE_TYPE_ORDER.map((type) => {
            const b = byType.get(type);
            const isFestival = type === "festival";
            return (
              <Card key={type}>
                <CardContent className="space-y-1 p-4">
                  <p className="text-xs text-muted-foreground">
                    {LEAVE_TYPE_LABELS[type]}
                    {isFestival ? " · unpaid" : ""}
                  </p>
                  {isFestival ? (
                    <p className="text-2xl font-semibold text-muted-foreground">
                      Unpaid
                    </p>
                  ) : (
                    <>
                      <p className="num text-2xl font-semibold">
                        {b ? b.balance : "—"}
                        <span className="text-sm font-normal text-muted-foreground">
                          {" "}
                          left
                        </span>
                      </p>
                      <p className="num text-xs text-muted-foreground">
                        {b ? `${b.used} / ${b.allocated} used` : "no allocation"}
                      </p>
                    </>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <ApplyLeaveDialog open={applyOpen} onOpenChange={setApplyOpen} />

      {canEditTeam ? <TeamBalanceEditor /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Head office: correct any employee's balance                         */
/* ------------------------------------------------------------------ */

type BalanceEdit = { type: LeaveType; row?: LeaveBalance };

function TeamBalanceEditor() {
  const { data: staff = [] } = useStaff();
  const [staffId, setStaffId] = useState("");
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium">Employee leave balances</h3>
            <p className="text-xs text-muted-foreground">
              Head office corrections: opening balance or days used. Every change is audited.
            </p>
          </div>
          <Select value={staffId} onValueChange={setStaffId}>
            <SelectTrigger className="h-9 w-[220px]" aria-label="Employee">
              <SelectValue placeholder="Choose an employee" />
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
        {staffId ? (
          <StaffBalances
            key={staffId}
            staffId={staffId}
            name={staff.find((s) => s.id === staffId)?.name ?? ""}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

function StaffBalances({ staffId, name }: { staffId: string; name: string }) {
  const { data: balances = [], isLoading, isError, refetch } = useLeaveBalances(staffId);
  const [editing, setEditing] = useState<BalanceEdit | null>(null);
  const year = balances[0]?.year ?? new Date().getFullYear();

  if (isLoading) return <Skeleton className="h-24 rounded-lg" />;
  if (isError)
    return (
      <p className="text-sm text-destructive">
        Couldn&apos;t load balances.{" "}
        <button type="button" className="underline" onClick={() => refetch()}>
          Retry
        </button>
      </p>
    );

  return (
    <>
      <ul className="divide-y rounded-lg border">
        {LEAVE_TYPE_ORDER.filter((t) => t !== "festival").map((type) => {
          const row = balances.find((b) => b.type === type);
          return (
            <li key={type} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span className="text-sm font-medium">{LEAVE_TYPE_LABELS[type]}</span>
              <span className="flex items-center gap-2">
                <span className="num text-sm text-muted-foreground">
                  {row ? `${row.used} used / ${row.allocated} allotted · ${row.balance} left` : "no allocation"}
                </span>
                {row ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!row.id}
                    title={row.id ? undefined : "This balance can't be edited yet"}
                    onClick={() => setEditing({ type, row })}
                  >
                    <Pencil className="h-4 w-4" />
                    Edit
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => setEditing({ type })}>
                    <Plus className="h-4 w-4" />
                    Allot
                  </Button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {editing ? (
        <BalanceDialog
          key={editing.type}
          edit={editing}
          staffId={staffId}
          name={name}
          year={year}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}

function BalanceDialog({
  edit,
  staffId,
  name,
  year,
  onClose,
}: {
  edit: BalanceEdit;
  staffId: string;
  name: string;
  year: number;
  onClose: () => void;
}) {
  const update = useEditLeaveBalance();
  const create = useCreateLeaveBalance();
  const [allocated, setAllocated] = useState(String(edit.row?.allocated ?? ""));
  const [used, setUsed] = useState(String(edit.row?.used ?? 0));
  const [note, setNote] = useState("");
  const pending = update.isPending || create.isPending;

  function save() {
    const a = Number(allocated);
    const u = Number(used);
    if (allocated === "" || !Number.isFinite(a) || a < 0 || !Number.isFinite(u) || u < 0) {
      toast.error("Enter zero or more days.");
      return;
    }
    const done = {
      onSuccess: () => {
        toast.success(`${LEAVE_TYPE_LABELS[edit.type]} balance saved for ${name}`);
        onClose();
      },
      onError: (err: unknown) => toast.error(apiErrorMessage(err, "Could not save the balance.")),
    };
    if (edit.row?.id) {
      if (!note.trim()) {
        toast.error("Say why the balance is being corrected.");
        return;
      }
      update.mutate({ id: edit.row.id, allocated: a, used: u, note: note.trim() }, done);
    } else {
      create.mutate({ userId: staffId, type: edit.type, year, allocated: a }, done);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {edit.row ? "Correct" : "Allot"} {LEAVE_TYPE_LABELS[edit.type]} leave
          </DialogTitle>
          <DialogDescription>
            {name} · <span className="num">{year}</span>
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="lb-alloc">Allotted days</Label>
              <Input
                id="lb-alloc"
                type="number"
                min={0}
                step={0.5}
                inputMode="decimal"
                value={allocated}
                onChange={(e) => setAllocated(e.target.value)}
              />
            </div>
            {edit.row ? (
              <div className="grid gap-1.5">
                <Label htmlFor="lb-used">Used days</Label>
                <Input
                  id="lb-used"
                  type="number"
                  min={0}
                  step={0.5}
                  inputMode="decimal"
                  value={used}
                  onChange={(e) => setUsed(e.target.value)}
                />
              </div>
            ) : null}
          </div>
          {edit.row ? (
            <div className="grid gap-1.5">
              <Label htmlFor="lb-note">
                Reason <span className="text-destructive">*</span>
              </Label>
              <Textarea id="lb-note" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          ) : null}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
