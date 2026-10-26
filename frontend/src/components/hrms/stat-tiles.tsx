import type { LucideIcon } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export interface StatTile {
  label: string;
  value: string;
  hint?: string;
  icon: LucideIcon;
}

/**
 * The wide-screen column count, by how many tiles there are.
 *
 * This was fixed at four for every caller, but the six callers pass 3, 4, 5, 6
 * and 9 tiles — so a six-tile row (the month summary on Attendance) wrapped
 * two tiles onto a second line beside four empty columns, which is what the
 * comp (Figma 1382:2422) shows as a single row. Static strings because
 * Tailwind cannot see a class name assembled at runtime.
 */
const COLUMNS: Record<number, string> = {
  1: "sm:grid-cols-1",
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-3",
  4: "sm:grid-cols-2 lg:grid-cols-4",
  5: "sm:grid-cols-3 xl:grid-cols-5",
  6: "sm:grid-cols-3 xl:grid-cols-6",
};

/** Compact KPI tiles row, reused across the HRMS tabs. */
export function StatTiles({ tiles }: { tiles: StatTile[] }) {
  // Past six, a single row would squeeze each tile past legibility; those fall
  // back to the four-column grid and wrap.
  const columns = COLUMNS[tiles.length] ?? "sm:grid-cols-2 lg:grid-cols-4";
  return (
    <div className={cn("grid grid-cols-2 gap-3", columns)}>
      {tiles.map((t) => {
        const Icon = t.icon;
        return (
          <Card key={t.label}>
            <CardContent className="flex items-start justify-between gap-2 p-4">
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">{t.label}</p>
                <p className="num text-[15px] font-semibold">{t.value}</p>
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
