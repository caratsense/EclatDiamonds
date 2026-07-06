"use client";

import { Building2, CalendarClock } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatINRCompact } from "@/lib/format";
import { EXPANSION_PIPELINE, type ExpansionProject } from "@/lib/mock/finance";

const STAGE_LABELS: Record<ExpansionProject["stage"], string> = {
  scouting: "Scouting",
  fit_out: "Fit-out",
  hiring: "Hiring",
  launch: "Launch",
};

/** Expansion-pipeline cost cards. */
export function ExpansionCards() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {EXPANSION_PIPELINE.map((p) => (
        <Card key={p.id}>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center justify-between text-base">
              <span className="flex items-center gap-2">
                <Building2 className="h-4 w-4 text-muted-foreground" />
                {p.city}
              </span>
              <Badge variant="secondary">{STAGE_LABELS[p.stage]}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-muted-foreground">Setup Cost</p>
                <p className="num font-semibold">{formatINRCompact(p.setupCost)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Monthly Opex</p>
                <p className="num font-semibold">{formatINRCompact(p.monthlyOpex)}</p>
              </div>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <CalendarClock className="h-3.5 w-3.5" />
              Target launch {p.startDate}
            </div>
            <div>
              <div className="mb-1 flex justify-between text-xs">
                <span className="text-muted-foreground">Readiness</span>
                <span className="num font-medium">{p.progress}%</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${p.progress}%` }}
                />
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
