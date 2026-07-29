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
import { useCreateRegularization } from "@/lib/queries/hrms";
import { apiErrorMessage } from "@/lib/utils";

/** Combine a YYYY-MM-DD date + HH:mm time into an ISO instant (local tz). */
function toISO(date: string, time: string): string | undefined {
  if (!date || !time) return undefined;
  const dt = new Date(`${date}T${time}`);
  return Number.isNaN(dt.getTime()) ? undefined : dt.toISOString();
}

/**
 * Regularization request dialog (Module 6). A staffer requests a fix for a
 * missed / wrong punch on a given day; a manager approves it to rewrite the
 * attendance record.
 */
export function RegularizeDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createReg = useCreateRegularization();
  const [date, setDate] = useState("");
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [reason, setReason] = useState("");

  function reset() {
    setDate("");
    setCheckIn("");
    setCheckOut("");
    setReason("");
  }

  function submit() {
    if (!date) {
      toast.error("Pick the date you're correcting.");
      return;
    }
    if (!checkIn && !checkOut) {
      toast.error("Enter a corrected check-in and/or check-out time.");
      return;
    }
    createReg.mutate(
      {
        date,
        requestedCheckIn: toISO(date, checkIn),
        requestedCheckOut: toISO(date, checkOut),
        reason: reason.trim() || undefined,
      },
      {
        onSuccess: () => {
          toast.success("Attendance fix requested", {
            description: "Sent to your manager for approval.",
          });
          reset();
          onOpenChange(false);
        },
        onError: (err) => toast.error(apiErrorMessage(err, "Could not submit the request.")),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Fix an attendance record</DialogTitle>
          <DialogDescription>
            Fix a missed or wrong punch. Your manager approves it to correct the
            record for that day.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="reg-date">Date</Label>
            <Input
              id="reg-date"
              type="date"
              value={date}
              max={new Date().toISOString().slice(0, 10)}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="reg-in">Check-in time</Label>
              <Input
                id="reg-in"
                type="time"
                value={checkIn}
                onChange={(e) => setCheckIn(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="reg-out">Check-out time</Label>
              <Input
                id="reg-out"
                type="time"
                value={checkOut}
                onChange={(e) => setCheckOut(e.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="reg-reason">Reason</Label>
            <Textarea
              id="reg-reason"
              placeholder="e.g. phone battery died, forgot to punch out."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={createReg.isPending}>
            {createReg.isPending ? "Submitting…" : "Submit request"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
