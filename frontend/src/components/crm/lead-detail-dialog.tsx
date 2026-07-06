"use client";

import {
  Bell,
  CalendarClock,
  Check,
  Phone,
  Store as StoreIcon,
  User,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import {
  LEAD_SOURCE_LABELS,
  LEAD_STAGES,
  type Lead,
} from "@/lib/mock/crm";
import { cn } from "@/lib/utils";
import { useSession } from "@/store/use-session";

interface LeadDetailDialogProps {
  lead: Lead | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function storeName(stores: { id: string; name: string }[], id: string) {
  return stores.find((s) => s.id === id)?.name ?? id;
}

export function LeadDetailDialog({
  lead,
  open,
  onOpenChange,
}: LeadDetailDialogProps) {
  const { stores } = useSession();
  if (!lead) return null;

  const stageLabel =
    LEAD_STAGES.find((s) => s.id === lead.stage)?.label ?? lead.stage;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
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
          {/* Profile */}
          <div className="grid grid-cols-2 gap-3">
            <Field icon={<Phone className="h-3.5 w-3.5" />} label="Phone">
              {lead.phone}
            </Field>
            <Field icon={<User className="h-3.5 w-3.5" />} label="Assigned rep">
              {lead.assignedRep}
            </Field>
            <Field
              icon={<StoreIcon className="h-3.5 w-3.5" />}
              label="Store"
            >
              {storeName(stores, lead.storeId)}
            </Field>
            <Field label="Source">{LEAD_SOURCE_LABELS[lead.source]}</Field>
          </div>

          <div>
            <p className="text-xs text-muted-foreground">Interested in</p>
            <p className="font-medium">{lead.interest}</p>
          </div>

          {lead.remark ? (
            <div>
              <p className="text-xs text-muted-foreground">Remarks</p>
              <p className="whitespace-pre-line">{lead.remark}</p>
            </div>
          ) : null}

          <Separator />

          {/* Two SOP follow-ups (+7d / +30d) with done status. */}
          <div>
            <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <CalendarClock className="h-3.5 w-3.5" /> Follow-ups
            </p>
            {(lead.followUps ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No follow-ups scheduled.
              </p>
            ) : (
              <ul className="space-y-2">
                {[...(lead.followUps ?? [])]
                  .sort((a, b) => a.seq - b.seq)
                  .map((f) => (
                    <li
                      key={f.id}
                      className="flex items-center justify-between gap-2 rounded-lg border bg-muted/30 px-3 py-2"
                    >
                      <div>
                        <p className="text-sm font-medium">
                          Follow-up {f.seq}
                        </p>
                        <p className="num text-xs text-muted-foreground">
                          Due {f.dueDate}
                        </p>
                      </div>
                      <Badge
                        variant={f.done ? "success" : "warning"}
                        className={cn("gap-1")}
                      >
                        {f.done ? (
                          <>
                            <Check className="h-3 w-3" /> Done
                          </>
                        ) : (
                          "Pending"
                        )}
                      </Badge>
                    </li>
                  ))}
              </ul>
            )}
          </div>

          {lead.reminders.length > 0 ? (
            <>
              <Separator />
              <div>
                <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-300">
                  <Bell className="h-3.5 w-3.5" /> Occasion reminders
                </p>
                <div className="flex flex-wrap gap-2">
                  {lead.reminders.map((r) => (
                    <Badge
                      key={r.id}
                      variant="outline"
                      className="border-amber-300 text-amber-800 dark:text-amber-300"
                    >
                      {r.occasion} · {r.date}
                    </Badge>
                  ))}
                </div>
              </div>
            </>
          ) : null}

          <Separator />

          {/* Follow-up history */}
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              Follow-up notes &amp; history
            </p>
            {lead.notes.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No notes yet. Add a follow-up after your next interaction.
              </p>
            ) : (
              <ul className="space-y-3">
                {lead.notes.map((n) => (
                  <li key={n.id} className="border-l-2 border-muted pl-3">
                    <p className="text-sm">{n.text}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {n.author} · {n.at}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
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
