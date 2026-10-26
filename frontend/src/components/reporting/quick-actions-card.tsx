"use client";

import { ChevronRight, FileText, Files } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * The two things a manager opens this screen to do (design, 17 Oct).
 *
 * Both already exist elsewhere on the page — the File DSR button in the header,
 * the submitted-reports log further down — and that is the point: on a screen
 * this long, "file today's" and "read what was filed" were a scroll away from
 * the figures that prompt them. These are shortcuts, not new behaviour.
 */
export function QuickActionsCard({
  onFile,
  onViewSubmitted,
}: {
  onFile: () => void;
  onViewSubmitted: () => void;
}) {
  const actions = [
    {
      key: "file",
      icon: FileText,
      title: "File DSR",
      note: "Submit today's sales report",
      onClick: onFile,
    },
    {
      key: "view",
      icon: Files,
      title: "View submitted reports",
      note: "Check what each branch has filed",
      onClick: onViewSubmitted,
    },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Quick actions</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2">
        {actions.map((a) => (
          <button
            key={a.key}
            type="button"
            onClick={a.onClick}
            className="flex items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-accent/60"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent text-primary">
              <a.icon className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{a.title}</span>
              <span className="block truncate text-xs text-muted-foreground">{a.note}</span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          </button>
        ))}
      </CardContent>
    </Card>
  );
}
