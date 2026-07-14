"use client";

import { Building2, CalendarClock } from "lucide-react";
import { format, parseISO } from "date-fns";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatINRCompact } from "@/lib/format";
import { useNewStoreProjects } from "@/lib/queries/new-store";

/**
 * Expansion pipeline = the live new-store launch programme (Module 11).
 * Each launch project is rendered as a cost/readiness card. New-store data is
 * area_manager+ only; lower roles get an empty state instead of an error.
 */
export function ExpansionCards() {
  const { data, isLoading } = useNewStoreProjects();

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-48 rounded-xl" />
        ))}
      </div>
    );
  }

  const projects = data?.projects ?? [];

  if (data?.forbidden || projects.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          No expansion projects in the pipeline.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {projects.map((p) => {
        const hasBudget = p.budget > 0;
        const launch = p.launchDate ? parseISO(p.launchDate) : null;
        return (
          <Card key={p.id}>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center justify-between gap-2 text-base">
                <span className="flex min-w-0 items-center gap-2">
                  <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{p.name}</span>
                </span>
              </CardTitle>
              <p className="text-xs text-muted-foreground">{p.city}</p>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <p className="text-muted-foreground">Budget</p>
                  <p className="num font-semibold">
                    {hasBudget ? formatINRCompact(p.budget) : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">Spent</p>
                  <p className="num font-semibold">
                    {formatINRCompact(p.spent)}
                  </p>
                </div>
              </div>
              {launch ? (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <CalendarClock className="h-3.5 w-3.5" />
                  Target launch {format(launch, "dd MMM yyyy")}
                </div>
              ) : null}
              <div>
                <div className="mb-1 flex justify-between text-xs">
                  <span className="text-muted-foreground">Readiness</span>
                  <span className="num font-medium">{p.overallProgress}%</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{
                      width: `${Math.min(100, Math.max(0, p.overallProgress))}%`,
                    }}
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
