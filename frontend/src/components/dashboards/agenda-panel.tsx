"use client";

import * as React from "react";
import { CalendarClock, CalendarDays, Flag, Wrench } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { AGENDA, type AgendaItem } from "@/lib/mock/dashboards";

const TYPE_META: Record<
  AgendaItem["type"],
  { icon: typeof CalendarDays; label: string }
> = {
  meeting: { icon: CalendarClock, label: "Meeting" },
  deadline: { icon: Flag, label: "Deadline" },
  event: { icon: CalendarDays, label: "Event" },
  task: { icon: Wrench, label: "Task" },
};

/** Consolidated calendar / to-do list for today. */
export function AgendaPanel() {
  const [items, setItems] = React.useState(AGENDA);

  const toggle = (id: string) =>
    setItems((prev) =>
      prev.map((i) => (i.id === id ? { ...i, done: !i.done } : i)),
    );

  const remaining = items.filter((i) => !i.done).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Today&apos;s Agenda</CardTitle>
        <CardDescription>
          {remaining} of {items.length} items remaining
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-1">
        {items.map((item) => {
          const meta = TYPE_META[item.type];
          const Icon = meta.icon;
          return (
            <button
              key={item.id}
              onClick={() => toggle(item.id)}
              className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent"
            >
              <span
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
                  item.done ? "bg-muted text-muted-foreground" : "bg-accent text-accent-foreground",
                )}
              >
                <Icon className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    "block truncate text-sm font-medium",
                    item.done && "text-muted-foreground line-through",
                  )}
                >
                  {item.title}
                </span>
                <span className="text-xs text-muted-foreground">{meta.label}</span>
              </span>
              <Badge variant="outline" className="shrink-0 tabular-nums">
                {item.time}
              </Badge>
            </button>
          );
        })}
      </CardContent>
    </Card>
  );
}
