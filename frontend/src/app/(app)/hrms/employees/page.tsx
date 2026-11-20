"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { SectionHeader } from "@/components/section/section-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmployeesTab } from "@/components/hrms/employees-tab";
import { ROLE_RANK } from "@/lib/types";
import { useSession } from "@/store/use-session";

/**
 * Employees — the employee master, off the HRMS tab strip and onto its own
 * route. The panel is unchanged: same filters, same detail sheet, same masters
 * dialog, reading `/hrms/employees` as before.
 *
 * It sits under HR & Attendance rather than beside the four modules because it
 * is record-keeping, not the day's work — the landing's "People & pay" band.
 */
export default function EmployeesPage() {
  const role = useSession((s) => s.role);
  const isManager = ROLE_RANK[role] >= ROLE_RANK.store_manager;
  const isHeadOffice = role === "head_office";

  return (
    <>
      <Link
        href="/hrms"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" /> HR &amp; Attendance
      </Link>

      <SectionHeader
        title="Employees"
        purpose="The employee master — profiles, departments and designations, joining and separation."
      />

      {isManager ? (
        <EmployeesTab canManage={isManager} isHeadOffice={isHeadOffice} />
      ) : (
        /* `/hrms/employees` is @Roles('store_manager') and rolls up. Somebody
           who only has their own record is pointed at it instead of a list
           whose every row would 403. */
        <Card>
          <CardContent className="space-y-3 py-10 text-center text-sm text-muted-foreground">
            <p>The employee master is kept by your manager and head office.</p>
            <Button asChild variant="outline" size="sm">
              <Link href="/settings">See my own details</Link>
            </Button>
          </CardContent>
        </Card>
      )}
    </>
  );
}
