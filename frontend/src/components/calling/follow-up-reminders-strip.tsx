"use client";

import Link from "next/link";
import { BellRing } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { useReminders } from "@/lib/queries/reminders";
import { formatLocalReminder } from "@/lib/reminder";

/**
 * Lead follow-ups due today, with their reminders, beside the task queue.
 *
 * They are a different record from calling tasks — booked at the counter or on
 * the lead — and live on Reminders; showing them here (rather than copying them
 * into tasks) keeps one source for each while the caller still sees them.
 */
export function FollowUpRemindersStrip() {
  const today = useReminders("today");
  const items = (today.data ?? []).filter((r) => !r.done);
  if (!items.length) return null;

  return (
    <Card>
      <CardContent className="space-y-2 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <BellRing className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm font-medium">Lead follow-ups due today</p>
          <Badge variant="secondary">
            <span className="num">{items.length}</span>
          </Badge>
          <Link href="/reminders" className="ml-auto text-xs underline underline-offset-4 hover:no-underline">
            Open Reminders
          </Link>
        </div>
        <ul className="flex flex-wrap gap-2">
          {items.slice(0, 8).map((r) => (
            <li key={r.id} className="rounded-md border px-2.5 py-1.5 text-xs">
              <span className="font-medium">{r.customer}</span>
              <span className="text-muted-foreground"> · {r.leadRef}</span>
              {r.reminder ? (
                <span className="ml-1.5 text-muted-foreground">
                  {r.reminder.state === "sent" ? "reminded" : "reminder"}{" "}
                  {formatLocalReminder(r.reminder.local).split(", ")[1]}
                </span>
              ) : null}
            </li>
          ))}
          {items.length > 8 ? (
            <li className="px-1 py-1.5 text-xs text-muted-foreground">+{items.length - 8} more</li>
          ) : null}
        </ul>
      </CardContent>
    </Card>
  );
}
