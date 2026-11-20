"use client";

import Link from "next/link";
import { CalendarClock, ClipboardList, MapPin, UserCheck } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useAgenda, type AgendaType } from "@/lib/queries/dashboard";

const TYPE_META: Record<
  AgendaType,
  { icon: typeof CalendarClock; label: string }
> = {
  follow_up: { icon: UserCheck, label: "Follow-up" },
  task: { icon: ClipboardList, label: "Task" },
  checkin: { icon: MapPin, label: "Check-in" },
};

/** Consolidated calendar / to-do list for today, live from the API. */
export function AgendaPanel() {
  const { data, isLoading } = useAgenda();
  const items = data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Today&apos;s Agenda</CardTitle>
        <CardDescription>
          {isLoading
            ? "Loading agenda…"
            : `${items.length} item${items.length === 1 ? "" : "s"} for today`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-1">
        {isLoading ? (
          <>
            <Skeleton className="h-12 rounded-lg" />
            <Skeleton className="h-12 rounded-lg" />
            <Skeleton className="h-12 rounded-lg" />
          </>
        ) : items.length === 0 ? (
          <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
            Nothing scheduled for today
          </p>
        ) : (
          items.map((item) => {
            const meta = TYPE_META[item.type] ?? TYPE_META.task;
            const Icon = meta.icon;
            return (
              <Link
                key={item.id}
                href={item.href}
                className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {item.title}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {meta.label}
                  </span>
                </span>
                {item.time ? (
                  <Badge variant="outline" className="shrink-0 tabular-nums">
                    {item.time}
                  </Badge>
                ) : null}
              </Link>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
