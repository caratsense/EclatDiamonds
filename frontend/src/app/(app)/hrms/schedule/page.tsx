"use client";

import Link from "next/link";
import { ArrowLeft, CalendarRange } from "lucide-react";

import { SectionHeader } from "@/components/section/section-header";
import { Button } from "@/components/ui/button";
import { RosterMySchedule } from "@/components/hrms/roster-my-schedule";
import { ROLE_RANK } from "@/lib/types";
import { useSession } from "@/store/use-session";

/**
 * My Schedule — the My Data half of Roster & Shifts on its own route.
 *
 * It is the same component the module page's My Data tab renders, not a second
 * copy: this route exists so an employee can be sent straight to their own week
 * (a notification, a quick link, a bookmark) without landing on a Team grid they
 * cannot open. A manager gets a link across to the roster from here.
 */
export default function MySchedulePage() {
  const role = useSession((s) => s.role);
  const isManager = ROLE_RANK[role] >= ROLE_RANK.store_manager;

  return (
    <>
      <Link
        href="/hrms"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" /> HRMS &amp; Attendance
      </Link>

      <SectionHeader
        title="My Schedule"
        purpose="Your shifts, your offs and your branch's holidays for the next four weeks."
      />

      {isManager ? (
        <div className="mb-4">
          <Button asChild variant="outline" size="sm">
            <Link href="/hrms/roster">
              <CalendarRange className="size-4" /> Plan the team&rsquo;s roster
            </Link>
          </Button>
        </div>
      ) : null}

      <RosterMySchedule />
    </>
  );
}
