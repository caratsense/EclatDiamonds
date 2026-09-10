"use client";

import { useState } from "react";
import {
  Activity,
  CalendarClock,
  Check,
  FileText,
  Loader2,
  Phone,
  PhoneOff,
  Route,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  CALL_DISPOSITIONS,
  useCallingWorkspace,
  useLogCall,
  type CallRow,
} from "@/lib/queries/calling";
import { apiErrorMessage } from "@/lib/utils";

/**
 * Take Action — everything about one follow-up on a single screen.
 *
 * Two rules this screen exists to keep:
 *
 *   1. No invented numbers. Total spend is shown only when there is order
 *      history; otherwise it says so. A caller reading a fabricated lifetime
 *      value to a customer is worse than a caller with no figure at all.
 *   2. Logging the call and deciding what happens next are ONE action.
 *      Splitting them lets an agent log a call and forget to reschedule, which
 *      is exactly how a follow-up queue rots.
 */

const TABS = [
  { value: "journey", label: "Journey", icon: Route },
  { value: "notes", label: "Notes", icon: FileText },
  { value: "calls", label: "Calls", icon: Phone },
  { value: "activity", label: "Activity", icon: Activity },
] as const;

/**
 * Today's date as the browser sees it, for the callback picker's floor.
 *
 * Local, not `toISOString().slice(0,10)`: that renders the UTC date, so before
 * 05:30 IST it offers yesterday as the earliest callback.
 */
function todayAtDesk(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function duration(seconds: number | null): string {
  if (seconds === null) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function CallCard({ call }: { call: CallRow }) {
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="outline">{call.direction}</Badge>
        {call.disposition ? <Badge variant="secondary">{call.disposition}</Badge> : null}
        <span className="text-muted-foreground">
          {new Date(call.startedAt).toLocaleString()} · {duration(call.durationSec)}
        </span>
        {/* 'manual' means a person typed this outcome; nothing on the network
            confirms it. Saying so keeps the two kinds of evidence apart. */}
        {call.provider === "manual" ? (
          <Badge variant="outline" className="text-[10px]">
            logged by hand
          </Badge>
        ) : (
          <Badge variant="outline" className="text-[10px]">
            {call.provider}
          </Badge>
        )}
      </div>

      {call.notes ? <p className="text-sm">{call.notes}</p> : null}

      {call.recordingState === "available" && call.recording ? (
        <audio controls preload="none" src={call.recording.url} className="w-full">
          Your browser cannot play this recording.
        </audio>
      ) : call.recordingState === "expired" ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <PhoneOff className="h-3.5 w-3.5" />
          The recording is no longer available from the provider.
        </p>
      ) : null}

      {call.summary ? (
        <div className="rounded-md bg-muted/50 p-2 text-xs">
          <p>{call.summary}</p>
          {call.summarySource ? (
            <p className="mt-1 text-[10px] text-muted-foreground">
              Summary produced by {call.summarySource}, not a transcript of what was said.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

interface Props {
  taskId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Set while a caller is working the queue in one sitting.
   *
   * When present, logging a call hands control back to the queue instead of
   * closing — the caller never returns to a list to find their place. The
   * PARENT must key this component by `taskId` so each call starts on a clean
   * form; without that the disposition and notes of the last call would still
   * be sitting in the boxes when the next customer answers.
   */
  session?: { index: number; total: number; onNext: () => void };
}

export function TakeActionDialog({ taskId, open, onOpenChange, session }: Props) {
  const [tab, setTab] = useState<string>("journey");
  const [disposition, setDisposition] = useState("");
  const [notes, setNotes] = useState("");
  const [then, setThen] = useState<"complete" | "reschedule" | "leave">("complete");
  const [rescheduleTo, setRescheduleTo] = useState("");

  const workspace = useCallingWorkspace(taskId);
  const logCall = useLogCall();

  const submit = () => {
    if (!disposition) {
      toast.error("Say what happened on the call.");
      return;
    }
    if (then === "reschedule" && !rescheduleTo) {
      toast.error("Choose when to call back.");
      return;
    }
    logCall.mutate(
      {
        taskId,
        disposition,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        then,
        // Midday, so no zone offset between the browser and the branch can
        // shift the chosen calendar date onto the day either side of it.
        ...(then === "reschedule"
          ? { rescheduleTo: `${rescheduleTo}T12:00:00.000Z` }
          : {}),
      },
      {
        onSuccess: (res) => {
          toast.success(
            res.rescheduledTo
              ? `Logged. Calling back on ${new Date(res.rescheduledTo).toLocaleDateString()}.`
              : then === "complete"
                ? "Logged and marked done."
                : "Logged.",
          );
          if (session) session.onNext();
          else onOpenChange(false);
        },
        onError: (e) => toast.error(apiErrorMessage(e, "Could not log this call.")),
      },
    );
  };

  const d = workspace.data;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] max-w-3xl overflow-y-auto">
        {workspace.isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-8 w-56" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : workspace.isError || !d ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {apiErrorMessage(workspace.error, "Could not open this task.")}
          </p>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{d.customer?.name ?? d.task.title}</DialogTitle>
              <DialogDescription>{d.task.title}</DialogDescription>
            </DialogHeader>

            {/* Customer summary — measured figures only. */}
            {d.customer ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Fact label="Orders" value={d.customer.totalOrders.toString()} />
                <Fact
                  label="Total spent"
                  value={d.customer.totalSpend ?? "No orders recorded"}
                  muted={!d.customer.totalSpend}
                />
                <Fact label="Visits" value={d.customer.totalVisits.toString()} />
                <Fact
                  label="Last visit"
                  value={
                    d.customer.lastVisitAt
                      ? new Date(d.customer.lastVisitAt).toLocaleDateString()
                      : "None recorded"
                  }
                  muted={!d.customer.lastVisitAt}
                />
              </div>
            ) : null}

            {d.customer ? (
              <div className="flex flex-wrap items-center gap-3 text-sm">
                {/*
                  A phone link only when there is a number to dial.
                  `contact` arrives masked as ••••1122 for anyone who is neither
                  a manager nor this task's assignee, and this used to wrap that
                  in `tel:` regardless — a link that looked exactly like a
                  working one and dialled nothing. Withheld now reads as
                  withheld.
                */}
                {d.customer.contact ? (
                  d.customer.canDial ? (
                    <a
                      href={`tel:${d.customer.contact}`}
                      className="flex items-center gap-1.5 font-[family-name:var(--font-mono-face)] underline-offset-4 hover:underline"
                    >
                      <Phone className="h-3.5 w-3.5" />
                      {d.customer.contact}
                    </a>
                  ) : (
                    <span
                      className="flex items-center gap-1.5 font-[family-name:var(--font-mono-face)] text-muted-foreground"
                      title="Only this task's owner and a manager see the full number."
                    >
                      <Phone className="h-3.5 w-3.5" />
                      {d.customer.contact}
                    </span>
                  )
                ) : null}
                {d.customer.lastAttendedBy ? (
                  <span className="text-xs text-muted-foreground">
                    Last attended by {d.customer.lastAttendedBy.name}
                    {d.customer.lastVisitStore ? ` at ${d.customer.lastVisitStore.name}` : ""}
                  </span>
                ) : null}
                {d.customer.blocked ? <Badge variant="destructive">Blocked</Badge> : null}
              </div>
            ) : null}

            <Tabs value={tab} onValueChange={setTab}>
              <TabsList>
                {TABS.map((x) => (
                  <TabsTrigger key={x.value} value={x.value}>
                    {x.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>

            <div className="min-h-[8rem] space-y-2">
              {tab === "journey" ? (
                d.lead ? (
                  <div className="space-y-2 rounded-md border border-border p-3 text-sm">
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="outline">{d.lead.source.replace(/_/g, " ")}</Badge>
                      <Badge variant="secondary">{d.lead.stage}</Badge>
                      {d.lead.ref ? <Badge variant="outline">{d.lead.ref}</Badge> : null}
                    </div>
                    {d.lead.interest ? <p>{d.lead.interest}</p> : null}
                    <p className="text-xs text-muted-foreground">
                      Raised {new Date(d.lead.createdAt).toLocaleDateString()}
                      {d.lead.owner ? ` · owned by ${d.lead.owner.name}` : ""}
                      {d.lead.store ? ` · ${d.lead.store.name}` : ""}
                    </p>
                  </div>
                ) : (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    This task is not attached to an enquiry.
                  </p>
                )
              ) : null}

              {tab === "notes" ? (
                d.notes.length ? (
                  d.notes.map((n) => (
                    <div key={n.id} className="rounded-md border border-border p-3 text-sm">
                      <p>{n.body}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {new Date(n.createdAt).toLocaleString()}
                      </p>
                    </div>
                  ))
                ) : (
                  <p className="py-6 text-center text-sm text-muted-foreground">No notes yet.</p>
                )
              ) : null}

              {tab === "calls" ? (
                d.calls.length ? (
                  d.calls.map((c) => <CallCard key={c.id} call={c} />)
                ) : (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    No calls logged against this task yet.
                  </p>
                )
              ) : null}

              {tab === "activity" ? (
                d.activity.length ? (
                  <ul className="space-y-1.5 text-sm">
                    {d.activity.map((a) => (
                      <li key={a.id} className="flex gap-2">
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {new Date(a.occurredAt).toLocaleDateString()}
                        </span>
                        <span>{a.summary}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    Nothing on this customer&apos;s timeline yet.
                  </p>
                )
              ) : null}
            </div>

            {/* Log + decide, together. */}
            <div className="space-y-4 border-t border-border pt-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>What happened?</Label>
                  <Select value={disposition} onValueChange={setDisposition}>
                    <SelectTrigger>
                      <SelectValue placeholder="Choose an outcome" />
                    </SelectTrigger>
                    <SelectContent>
                      {CALL_DISPOSITIONS.map((x) => (
                        <SelectItem key={x.value} value={x.value}>
                          {x.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label>Then</Label>
                  <Select
                    value={then}
                    onValueChange={(v) => setThen(v as "complete" | "reschedule" | "leave")}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="complete">Mark done</SelectItem>
                      <SelectItem value="reschedule">Call back later</SelectItem>
                      <SelectItem value="leave">Leave it open</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {then === "reschedule" ? (
                <div className="space-y-1.5">
                  <Label className="flex items-center gap-1.5">
                    <CalendarClock className="h-3.5 w-3.5" />
                    Call back on
                  </Label>
                  {/*
                    A date, not a datetime. `Task.dueDate` is a calendar date
                    with no time of day, so a time typed here was discarded on
                    the way in — and worse, a callback booked between midnight
                    and half past five landed on the previous day and the task
                    was born overdue. Asking for what can actually be stored is
                    the honest control.
                  */}
                  <Input
                    type="date"
                    min={todayAtDesk()}
                    value={rescheduleTo}
                    onChange={(e) => setRescheduleTo(e.target.value)}
                  />
                </div>
              ) : null}

              <div className="space-y-1.5">
                <Label>Notes</Label>
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={3}
                  maxLength={2000}
                  placeholder="What was said, and what you promised."
                />
              </div>

              <div className="flex flex-wrap items-center justify-end gap-2">
                {session ? (
                  <span className="mr-auto text-xs tabular-nums text-muted-foreground">
                    Call {session.index + 1} of {session.total}
                  </span>
                ) : null}
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                  {session ? "End session" : "Close"}
                </Button>
                {/* Skipping is a real outcome: the customer did not pick up and
                    there is nothing to log yet. Without it the only way past a
                    task is to invent a disposition for it. */}
                {session ? (
                  <Button variant="outline" onClick={session.onNext}>
                    Skip
                  </Button>
                ) : null}
                <Button onClick={submit} disabled={logCall.isPending}>
                  {logCall.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Check className="mr-2 h-4 w-4" />
                  )}
                  Log the call
                </Button>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Fact({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={`font-[family-name:var(--font-display-face)] text-lg ${
          muted ? "text-sm font-normal text-muted-foreground" : "tabular-nums"
        }`}
      >
        {value}
      </div>
    </div>
  );
}
