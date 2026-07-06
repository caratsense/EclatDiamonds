"use client";

import {
  differenceInCalendarDays,
  format,
  max as maxDate,
  min as minDate,
  parseISO,
} from "date-fns";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Campaign, CampaignType } from "@/lib/mock/marketing";

/** Type -> bar colour, so the planner reads at a glance. */
const TYPE_COLOR: Record<CampaignType, string> = {
  bridal: "bg-rose-500",
  festive: "bg-amber-500",
  catalog: "bg-sky-500",
  always_on: "bg-emerald-500",
};

const TYPE_LABEL: Record<CampaignType, string> = {
  bridal: "Bridal",
  festive: "Festive",
  catalog: "Catalog",
  always_on: "Always-on",
};

/**
 * Gantt-style campaign planner. Lays every campaign on a shared timeline
 * spanning the earliest start to the latest end, with month gridlines.
 */
export function CampaignPlanner({ campaigns }: { campaigns: Campaign[] }) {
  const starts = campaigns.map((c) => parseISO(c.start));
  const ends = campaigns.map((c) => parseISO(c.end));
  const rangeStart = minDate(starts);
  const rangeEnd = maxDate(ends);
  const totalDays = Math.max(1, differenceInCalendarDays(rangeEnd, rangeStart));

  // Month tick marks across the range.
  const months: { label: string; left: number }[] = [];
  const cursor = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), 1);
  while (cursor <= rangeEnd) {
    const offset = differenceInCalendarDays(cursor, rangeStart);
    months.push({
      label: format(cursor, "MMM"),
      left: (offset / totalDays) * 100,
    });
    cursor.setMonth(cursor.getMonth() + 1);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Campaign planner</CardTitle>
        <div className="flex flex-wrap gap-3 pt-1">
          {(Object.keys(TYPE_LABEL) as CampaignType[]).map((t) => (
            <span
              key={t}
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
            >
              <span className={`h-2.5 w-2.5 rounded-sm ${TYPE_COLOR[t]}`} />
              {TYPE_LABEL[t]}
            </span>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {/* Month axis */}
        <div className="relative mb-2 ml-44 h-4 border-b border-border">
          {months.map((m) => (
            <span
              key={m.label + m.left}
              className="num absolute -translate-x-1/2 text-[11px] text-muted-foreground"
              style={{ left: `${m.left}%` }}
            >
              {m.label}
            </span>
          ))}
        </div>

        <div className="space-y-2">
          {campaigns.map((c) => {
            const start = parseISO(c.start);
            const end = parseISO(c.end);
            const left =
              (differenceInCalendarDays(start, rangeStart) / totalDays) * 100;
            const width = Math.max(
              2,
              (differenceInCalendarDays(end, start) / totalDays) * 100,
            );
            return (
              <div key={c.id} className="flex items-center gap-2">
                <span className="w-44 shrink-0 truncate text-xs font-medium">
                  {c.name}
                </span>
                <div className="relative h-6 flex-1 rounded bg-muted/50">
                  <div
                    className={`absolute top-0 flex h-6 items-center overflow-hidden rounded px-2 text-[11px] font-medium text-white ${TYPE_COLOR[c.type]}`}
                    style={{ left: `${left}%`, width: `${width}%` }}
                    title={`${format(start, "dd MMM")} – ${format(end, "dd MMM yyyy")}`}
                  >
                    <span className="num truncate">
                      {format(start, "dd MMM")} – {format(end, "dd MMM")}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
