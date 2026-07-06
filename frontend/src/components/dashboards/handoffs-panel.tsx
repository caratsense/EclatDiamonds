"use client";

import { ArrowRight, TriangleAlert } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { HANDOFFS, type Handoff } from "@/lib/mock/dashboards";

const STATUS_META: Record<
  Handoff["status"],
  { label: string; variant: "default" | "secondary" | "destructive" | "success" | "outline" }
> = {
  open: { label: "Open", variant: "outline" },
  in_progress: { label: "In Progress", variant: "secondary" },
  blocked: { label: "Blocked", variant: "destructive" },
  done: { label: "Done", variant: "success" },
};

/** Cross-department task hand-offs with escalation flags. */
export function HandoffsPanel() {
  const escalated = HANDOFFS.filter((h) => h.escalated).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Cross-Department Hand-offs
          {escalated > 0 ? (
            <Badge variant="destructive" className="gap-1">
              <TriangleAlert className="h-3 w-3" />
              {escalated} escalated
            </Badge>
          ) : null}
        </CardTitle>
        <CardDescription>
          Tasks passed between Sales, Design, Production and back-office
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {HANDOFFS.map((h) => {
          const status = STATUS_META[h.status];
          return (
            <div
              key={h.id}
              className={cn(
                "rounded-lg border p-3",
                h.escalated && "border-destructive/40 bg-destructive/5",
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{h.title}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {h.customer}
                  </p>
                </div>
                <Badge variant={status.variant} className="shrink-0">
                  {status.label}
                </Badge>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  {h.from}
                  <ArrowRight className="h-3 w-3" />
                  {h.to}
                </span>
                <span
                  className={cn(
                    "tabular-nums",
                    (h.due === "Overdue" || h.due === "Today") && "font-medium text-destructive",
                  )}
                >
                  Due: {h.due}
                </span>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
