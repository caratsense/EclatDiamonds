import type { LucideIcon } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";

export interface StatTile {
  label: string;
  value: string;
  hint?: string;
  icon: LucideIcon;
}

/** Compact KPI tiles row, reused across the HRMS tabs. */
export function StatTiles({ tiles }: { tiles: StatTile[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {tiles.map((t) => {
        const Icon = t.icon;
        return (
          <Card key={t.label}>
            <CardContent className="flex items-start justify-between gap-2 p-4">
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">{t.label}</p>
                <p className="num text-2xl font-semibold">{t.value}</p>
                {t.hint ? (
                  <p className="text-xs text-muted-foreground">{t.hint}</p>
                ) : null}
              </div>
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                <Icon className="h-4 w-4" />
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
