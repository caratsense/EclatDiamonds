"use client";

import { Bell, CalendarClock } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { LEAD_SOURCE_LABELS, type Lead } from "@/lib/mock/crm";
import { cn } from "@/lib/utils";

interface LeadCardProps {
  lead: Lead;
  onOpen: (lead: Lead) => void;
  /** HTML5 drag start — moves the lead between stages. */
  onDragStart?: (lead: Lead) => void;
  draggable?: boolean;
}

export function LeadCard({ lead, onOpen, onDragStart, draggable }: LeadCardProps) {
  const hasReminder = lead.reminders.length > 0;
  // Earliest still-pending SOP follow-up (the next date the manager must act on).
  const nextFollowUp = (lead.followUps ?? [])
    .filter((f) => !f.done)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];

  return (
    <button
      type="button"
      draggable={draggable}
      onDragStart={() => onDragStart?.(lead)}
      onClick={() => onOpen(lead)}
      className={cn(
        "w-full rounded-lg border bg-card p-3 text-left shadow-sm transition-colors hover:bg-accent/50",
        draggable && "cursor-grab active:cursor-grabbing",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{lead.customer}</p>
          <p className="truncate text-xs text-muted-foreground">
            {lead.interest}
          </p>
        </div>
        {hasReminder ? (
          <span
            title="Occasion reminder"
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
          >
            <Bell className="h-3 w-3" />
          </span>
        ) : null}
      </div>

      <div className="mt-2.5 flex items-center justify-between gap-2">
        <Badge variant="outline" className="text-[10px]">
          {LEAD_SOURCE_LABELS[lead.source]}
        </Badge>
        {nextFollowUp ? (
          <span
            title="Next follow-up"
            className="num inline-flex items-center gap-1 text-[11px] text-muted-foreground"
          >
            <CalendarClock className="h-3 w-3" />
            {nextFollowUp.dueDate}
          </span>
        ) : null}
      </div>

      <p className="mt-2 text-[11px] text-muted-foreground">
        {lead.ref} · {lead.assignedRep}
      </p>
    </button>
  );
}
