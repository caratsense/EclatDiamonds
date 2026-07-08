"use client";

import { useState } from "react";
import { toast } from "sonner";

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
import { cn } from "@/lib/utils";
import {
  LEAVE_TYPE_LABELS,
  LEAVE_TYPE_ORDER,
  type LeaveType,
} from "@/lib/mock/hrms";
import { useApplyLeave } from "@/lib/queries/hrms";

/**
 * Apply-for-leave dialog (Module 6). Self-service: any staffer requests leave;
 * the backend computes working days (excludes weekly-off + holidays), guards the
 * paid balance, and returns the leave view. Festival is unpaid (no balance check).
 */
export function ApplyLeaveDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const applyLeave = useApplyLeave();
  const [type, setType] = useState<LeaveType>("casual");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [halfDay, setHalfDay] = useState(false);
  const [reason, setReason] = useState("");

  function reset() {
    setType("casual");
    setFromDate("");
    setToDate("");
    setHalfDay(false);
    setReason("");
  }

  function submit() {
    if (!fromDate || !toDate) {
      toast.error("Pick both a start and end date.");
      return;
    }
    if (toDate < fromDate) {
      toast.error("The end date can't be before the start date.");
      return;
    }
    applyLeave.mutate(
      {
        type,
        fromDate,
        toDate,
        halfDay: halfDay || undefined,
        reason: reason.trim() || undefined,
      },
      {
        onSuccess: (row) => {
          toast.success("Leave requested", {
            description: `${LEAVE_TYPE_LABELS[type]} · ${row.from} – ${row.to} · ${row.days}d — pending approval.`,
          });
          reset();
          onOpenChange(false);
        },
        onError: (err: unknown) => {
          // Surface the backend's balance-guard message when present.
          const msg =
            (err as { response?: { data?: { message?: string } } })?.response
              ?.data?.message ?? "Could not submit the leave request.";
          toast.error(Array.isArray(msg) ? msg[0] : msg);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Apply for leave</DialogTitle>
          <DialogDescription>
            Request time off. Days are counted excluding your weekly-off and store
            holidays. Festival leave is unpaid.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="leave-type">Leave type</Label>
            <Select value={type} onValueChange={(v) => setType(v as LeaveType)}>
              <SelectTrigger id="leave-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LEAVE_TYPE_ORDER.map((t) => (
                  <SelectItem key={t} value={t}>
                    {LEAVE_TYPE_LABELS[t]}
                    {t === "festival" ? " (unpaid)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="leave-from">From</Label>
              <Input
                id="leave-from"
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="leave-to">To</Label>
              <Input
                id="leave-to"
                type="date"
                value={toDate}
                min={fromDate || undefined}
                onChange={(e) => setToDate(e.target.value)}
              />
            </div>
          </div>
          <button
            type="button"
            aria-pressed={halfDay}
            onClick={() => setHalfDay((v) => !v)}
            className={cn(
              "flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
              halfDay
                ? "border-primary bg-primary/10"
                : "border-input hover:border-primary/40 hover:bg-accent",
            )}
          >
            <span className="text-sm">
              <span className="font-medium">Half day</span>
              <span className="block text-xs text-muted-foreground">
                Counts as 0.5 day against your balance.
              </span>
            </span>
            <span
              className={cn(
                "inline-flex h-5 w-9 shrink-0 items-center rounded-full border px-0.5 transition-colors",
                halfDay ? "bg-primary" : "bg-muted",
              )}
            >
              <span
                className={cn(
                  "h-4 w-4 rounded-full bg-background shadow transition-transform",
                  halfDay ? "translate-x-4" : "translate-x-0",
                )}
              />
            </span>
          </button>
          <div className="grid gap-1.5">
            <Label htmlFor="leave-reason">Reason</Label>
            <Textarea
              id="leave-reason"
              placeholder="Optional — e.g. family function, medical."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={applyLeave.isPending}>
            {applyLeave.isPending ? "Submitting…" : "Submit request"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
