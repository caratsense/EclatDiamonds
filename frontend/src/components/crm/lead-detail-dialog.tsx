"use client";

import { MetaFormAnswers } from "@/components/crm/meta-form-answers";
import { LeadTagsField } from "@/components/crm/lead-tags-field";
import { useState } from "react";
import {
  Bell,
  Cake,
  CalendarClock,
  Check,
  Heart,
  MapPin,
  MessageCircle,
  Phone,
  StickyNote,
  Store as StoreIcon,
  User,
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
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  ACTIVITY_KIND_LABELS,
  LEAD_SOURCE_LABELS,
  LEAD_STAGES,
  type ActivityKind,
  type Lead,
} from "@/lib/mock/crm";
import {
  useAddFollowUp,
  useLogActivity,
  useSetOutcome,
} from "@/lib/queries/leads";
import { useSession } from "@/store/use-session";
import { apiErrorMessage } from "@/lib/utils";
import { reminderLabel } from "@/lib/reminder";

interface LeadDetailDialogProps {
  lead: Lead | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the updated lead after a mutation returns (keeps the
   *  dialog fresh even when the lead drops out of the filtered list). */
  onLeadChange?: (lead: Lead) => void;
}

function storeName(stores: { id: string; name: string }[], id: string) {
  return stores.find((s) => s.id === id)?.name ?? id;
}

/**
 * One row of the unified record timeline (Zoho-style): either a logged
 * activity (note/call/visit/whatsapp) or a scheduled follow-up.
 */
type TimelineEntry =
  | {
      type: "activity";
      key: string;
      /** Sort key — ISO timestamp (falls back to the legacy `at` date). */
      ts: string;
      kindLabel: string;
      text: string;
      meta: string;
    }
  | {
      type: "followup";
      key: string;
      ts: string;
      dueDate: string;
      done: boolean;
      note: string | null;
      reminder: string | null;
    };

/** Merge activities + follow-ups into one list, newest first. */
function buildTimeline(lead: Lead): TimelineEntry[] {
  const activities: TimelineEntry[] = lead.notes.map((n) => ({
    type: "activity",
    key: `a-${n.id}`,
    ts: n.createdAt ?? n.at,
    kindLabel: ACTIVITY_KIND_LABELS[n.kind] ?? "Note",
    text: n.text,
    meta: `${n.author} · ${n.at}`,
  }));
  // A done follow-up sits at its completion time; a pending one at its due
  // date — so an upcoming follow-up naturally floats to the top as the
  // "next action" on the record.
  const followUps: TimelineEntry[] = (lead.followUps ?? []).map((f) => ({
    type: "followup",
    key: `f-${f.id}`,
    ts: f.doneAt ?? f.dueDate,
    dueDate: f.dueDate,
    done: f.done,
    note: f.note ?? null,
    reminder: reminderLabel(f.reminder),
  }));
  return [...activities, ...followUps].sort((a, b) =>
    b.ts.localeCompare(a.ts),
  );
}

export function LeadDetailDialog({
  lead,
  open,
  onOpenChange,
  onLeadChange,
}: LeadDetailDialogProps) {
  if (!lead) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        {/* Keyed by lead so inline-form state never bleeds across leads. */}
        <LeadDetailBody key={lead.id} lead={lead} onLeadChange={onLeadChange} />
      </DialogContent>
    </Dialog>
  );
}

function LeadDetailBody({
  lead,
  onLeadChange,
}: {
  lead: Lead;
  onLeadChange?: (lead: Lead) => void;
}) {
  const { stores } = useSession();
  const logActivity = useLogActivity();
  const addFollowUp = useAddFollowUp();
  const setOutcome = useSetOutcome();

  // Quick-log inline form (one kind open at a time).
  const [logKind, setLogKind] = useState<ActivityKind | null>(null);
  const [logText, setLogText] = useState("");
  // Add-follow-up inline form.
  const [fuOpen, setFuOpen] = useState(false);
  const [fuDate, setFuDate] = useState("");
  const [fuNote, setFuNote] = useState("");
  // Mark-lost inline form (reason is required by the API).
  const [lostOpen, setLostOpen] = useState(false);
  const [lostReason, setLostReason] = useState("");

  const stageLabel =
    LEAD_STAGES.find((s) => s.id === lead.stage)?.label ?? lead.stage;
  const timeline = buildTimeline(lead);

  function saveActivity() {
    if (!logKind || !logText.trim()) return;
    logActivity.mutate(
      { id: lead.id, kind: logKind, text: logText.trim() },
      {
        onSuccess: (updated) => {
          toast.success("Activity logged.");
          setLogKind(null);
          setLogText("");
          onLeadChange?.(updated);
        },
        onError: (err) => toast.error(apiErrorMessage(err, "Could not log the activity.")),
      },
    );
  }

  function saveFollowUp() {
    if (!fuDate) return;
    addFollowUp.mutate(
      { id: lead.id, dueDate: fuDate, note: fuNote.trim() || undefined },
      {
        onSuccess: () => {
          toast.success("Follow-up scheduled. It will appear in Reminders.");
          setFuOpen(false);
          setFuDate("");
          setFuNote("");
        },
        onError: (err) => toast.error(apiErrorMessage(err, "Could not schedule the follow-up.")),
      },
    );
  }

  function markLost() {
    if (!lostReason.trim()) return;
    setOutcome.mutate(
      { id: lead.id, outcome: "lost", lostReason: lostReason.trim() },
      {
        onSuccess: (updated) => {
          toast.success("Lead marked lost.");
          setLostOpen(false);
          setLostReason("");
          onLeadChange?.(updated);
        },
        onError: (err) => toast.error(apiErrorMessage(err, "Could not update the lead.")),
      },
    );
  }

  function reopen() {
    setOutcome.mutate(
      { id: lead.id, outcome: "open" },
      {
        onSuccess: (updated) => {
          toast.success("Lead reopened.");
          onLeadChange?.(updated);
        },
        onError: (err) => toast.error(apiErrorMessage(err, "Could not update the lead.")),
      },
    );
  }

  return (
    <>
      <DialogHeader>
        <div className="flex items-center justify-between gap-2 pr-6">
          <DialogTitle>{lead.customer}</DialogTitle>
          <Badge variant="secondary">{stageLabel}</Badge>
        </div>
        <DialogDescription>
          {lead.ref} · {LEAD_SOURCE_LABELS[lead.source]} lead
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4 text-sm">
        {/* Outcome — won / lost badge, or the mark-lost control while open. */}
        <div className="flex flex-wrap items-center gap-2">
          {lead.outcome === "won" ? (
            <Badge variant="success" className="gap-1">
              <Check className="h-3 w-3" /> Won
            </Badge>
          ) : lead.outcome === "lost" ? (
            <>
              <Badge variant="destructive">
                Lost{lead.lostReason ? ` — ${lead.lostReason}` : ""}
              </Badge>
              <Button
                variant="outline"
                size="sm"
                className="h-7"
                onClick={reopen}
                disabled={setOutcome.isPending}
              >
                Reopen
              </Button>
            </>
          ) : lostOpen ? (
            <div className="flex w-full flex-wrap items-center gap-2">
              <Input
                autoFocus
                placeholder="Reason (required) — e.g. bought elsewhere"
                value={lostReason}
                onChange={(e) => setLostReason(e.target.value)}
                className="h-8 flex-1"
              />
              <Button
                variant="destructive"
                size="sm"
                className="h-8"
                onClick={markLost}
                disabled={!lostReason.trim() || setOutcome.isPending}
              >
                {setOutcome.isPending ? "Saving…" : "Confirm lost"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8"
                onClick={() => {
                  setLostOpen(false);
                  setLostReason("");
                }}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-destructive"
              onClick={() => setLostOpen(true)}
            >
              Mark lost
            </Button>
          )}
        </div>

        {/* Profile */}
        <div className="grid grid-cols-2 gap-3">
          <Field icon={<Phone className="h-3.5 w-3.5" />} label="Phone">
            {lead.phone}
          </Field>
          <Field icon={<User className="h-3.5 w-3.5" />} label="Assigned rep">
            {lead.assignedRep}
          </Field>
          <Field icon={<StoreIcon className="h-3.5 w-3.5" />} label="Store">
            {storeName(stores, lead.storeId)}
          </Field>
          <Field label="Source">{LEAD_SOURCE_LABELS[lead.source]}</Field>
        </div>

        <div>
          <p className="text-xs text-muted-foreground">Interested in</p>
          <p className="font-medium">{lead.interest}</p>
        </div>

        <LeadTagsField leadId={lead.id} />

        {/* Renders itself only for a Meta Lead Ads lead; every other source has
            no questionnaire to show. */}
        <MetaFormAnswers lead={lead} />

        {lead.address ? (
          <Field icon={<MapPin className="h-3.5 w-3.5" />} label="Address">
            {lead.address}
          </Field>
        ) : null}

        {lead.birthday || lead.anniversary ? (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-3">
              {lead.birthday ? (
                <Field icon={<Cake className="h-3.5 w-3.5" />} label="Birthday">
                  <span className="num">{lead.birthday}</span>
                </Field>
              ) : null}
              {lead.anniversary ? (
                <Field
                  icon={<Heart className="h-3.5 w-3.5" />}
                  label="Anniversary"
                >
                  <span className="num">{lead.anniversary}</span>
                </Field>
              ) : null}
            </div>
            {/* Informational hints only — manual-first, no auto-send. */}
            <div className="flex flex-wrap gap-2">
              {lead.birthday ? (
                <Badge variant="outline">Birthday offer eligible</Badge>
              ) : null}
              {lead.anniversary ? (
                <Badge variant="outline">Anniversary</Badge>
              ) : null}
            </div>
          </div>
        ) : null}

        {lead.remark ? (
          <div>
            <p className="text-xs text-muted-foreground">Remarks</p>
            <p className="whitespace-pre-line">{lead.remark}</p>
          </div>
        ) : null}

        {lead.reminders.length > 0 ? (
          <>
            <Separator />
            <div>
              <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Bell className="h-3.5 w-3.5" /> Occasion reminders
              </p>
              <div className="flex flex-wrap gap-2">
                {lead.reminders.map((r) => (
                  <Badge key={r.id} variant="outline">
                    {r.occasion} · {r.date}
                  </Badge>
                ))}
              </div>
            </div>
          </>
        ) : null}

        <Separator />

        {/* Quick log bar — one-tap activity capture. */}
        <div>
          <div className="flex flex-wrap gap-2">
            <QuickLogButton
              icon={<Phone className="h-3.5 w-3.5" />}
              label="Log call"
              active={logKind === "call"}
              onClick={() => setLogKind(logKind === "call" ? null : "call")}
            />
            <QuickLogButton
              icon={<StoreIcon className="h-3.5 w-3.5" />}
              label="Log visit"
              active={logKind === "visit"}
              onClick={() => setLogKind(logKind === "visit" ? null : "visit")}
            />
            <QuickLogButton
              icon={<MessageCircle className="h-3.5 w-3.5" />}
              label="Log WhatsApp"
              active={logKind === "whatsapp"}
              onClick={() =>
                setLogKind(logKind === "whatsapp" ? null : "whatsapp")
              }
            />
            <QuickLogButton
              icon={<StickyNote className="h-3.5 w-3.5" />}
              label="Add note"
              active={logKind === "note"}
              onClick={() => setLogKind(logKind === "note" ? null : "note")}
            />
          </div>
          {logKind ? (
            <div className="mt-2 space-y-2">
              <Textarea
                autoFocus
                rows={2}
                placeholder={`What happened on this ${ACTIVITY_KIND_LABELS[
                  logKind
                ].toLowerCase()}?`}
                value={logText}
                onChange={(e) => setLogText(e.target.value)}
              />
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setLogKind(null);
                    setLogText("");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={saveActivity}
                  disabled={!logText.trim() || logActivity.isPending}
                >
                  {logActivity.isPending ? "Saving…" : "Save"}
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        {/* Add follow-up — flows into the Reminders page. */}
        <div>
          {fuOpen ? (
            <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label
                    htmlFor="fu-date"
                    className="text-xs text-muted-foreground"
                  >
                    Due date
                  </Label>
                  <Input
                    id="fu-date"
                    type="date"
                    value={fuDate}
                    onChange={(e) => setFuDate(e.target.value)}
                    className="h-8"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label
                    htmlFor="fu-note"
                    className="text-xs text-muted-foreground"
                  >
                    Note (optional)
                  </Label>
                  <Input
                    id="fu-note"
                    placeholder="e.g. Call after quote review"
                    value={fuNote}
                    onChange={(e) => setFuNote(e.target.value)}
                    className="h-8"
                  />
                </div>
              </div>
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  Scheduled follow-ups appear in Reminders.
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setFuOpen(false);
                      setFuDate("");
                      setFuNote("");
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    onClick={saveFollowUp}
                    disabled={!fuDate || addFollowUp.isPending}
                  >
                    {addFollowUp.isPending ? "Saving…" : "Schedule"}
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() => setFuOpen(true)}
            >
              <CalendarClock className="mr-1.5 h-3.5 w-3.5" /> Add follow-up
            </Button>
          )}
        </div>

        <Separator />

        {/* Unified timeline — activities + follow-ups, newest first. */}
        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            Timeline
          </p>
          {timeline.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No activity yet. Log a call, visit or note after your next
              interaction.
            </p>
          ) : (
            <ul className="space-y-3">
              {timeline.map((entry) =>
                entry.type === "activity" ? (
                  <li key={entry.key} className="border-l-2 border-muted pl-3">
                    <p className="text-xs font-medium text-muted-foreground">
                      {entry.kindLabel}
                    </p>
                    <p className="text-sm">{entry.text}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {entry.meta}
                    </p>
                  </li>
                ) : (
                  <li key={entry.key} className="border-l-2 border-muted pl-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-medium text-muted-foreground">
                        Follow-up ·{" "}
                        <span className="num">due {entry.dueDate}</span>
                        {entry.reminder && !entry.done ? (
                          <span className="font-normal"> · {entry.reminder}</span>
                        ) : null}
                      </p>
                      <Badge
                        variant={entry.done ? "success" : "warning"}
                        className="gap-1 text-[10px]"
                      >
                        {entry.done ? (
                          <>
                            <Check className="h-3 w-3" /> Done
                          </>
                        ) : (
                          "Pending"
                        )}
                      </Badge>
                    </div>
                    {entry.note ? (
                      <p className="mt-0.5 text-sm">{entry.note}</p>
                    ) : null}
                  </li>
                ),
              )}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}

function QuickLogButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant={active ? "secondary" : "outline"}
      size="sm"
      className="h-8"
      onClick={onClick}
    >
      {icon}
      <span className="ml-1.5">{label}</span>
    </Button>
  );
}

function Field({
  icon,
  label,
  children,
}: {
  icon?: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="flex items-center gap-1 text-xs text-muted-foreground">
        {icon}
        {label}
      </p>
      <p className="font-medium">{children}</p>
    </div>
  );
}
