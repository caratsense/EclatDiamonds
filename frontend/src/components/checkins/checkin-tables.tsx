"use client";

import { useState } from "react";
import Link from "next/link";
import { CalendarClock, DoorOpen, LogOut, ScanLine, UserCheck } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RecordInterestDialog } from "@/components/crm/record-interest-dialog";
import {
  Avatar,
  AvatarFallback,
} from "@/components/ui/avatar";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { VISIT_OUTCOME_LABELS, type CheckIn } from "@/lib/mock/checkins";
import { reminderLabel } from "@/lib/reminder";

const OUTCOME_VARIANT: Record<
  string,
  "success" | "secondary" | "outline" | "default"
> = {
  in_store: "default",
  quote_given: "outline",
  sale_closed: "success",
  browsing_left: "secondary",
  // Backend CheckinOutcome uses "left" where the mock used "browsing_left".
  left: "secondary",
  follow_up: "outline",
};

const OUTCOME_LABEL_FALLBACK: Record<string, string> = {
  ...VISIT_OUTCOME_LABELS,
  left: "Browsed, left",
};

const ACTION_LABEL: Record<"call" | "whatsapp" | "visit", string> = {
  call: "Call",
  whatsapp: "WhatsApp",
  visit: "Visit",
};

/** The visit's automatic feedback ask, in plain words. Never "sent" unless it was. */
function feedbackLabel(f: NonNullable<CheckIn["feedback"]>): string {
  const day = f.scheduledFor
    ? new Date(f.scheduledFor).toLocaleDateString("en-IN", { day: "numeric", month: "short" })
    : null;
  switch (f.status) {
    case "scheduled":
    case "processing":
      return day ? `Feedback ask due ${day}` : "Feedback ask booked";
    case "sent":
      return "Feedback asked on WhatsApp";
    case "responded":
      return "Feedback received";
    case "cancelled":
      return "Feedback ask cancelled";
    default:
      return f.note ? "Feedback ask with staff" : "Feedback ask queued";
  }
}

/** "18 Sep" from a yyyy-mm-dd follow-up date, read as a calendar date. */
function formatFollowUp(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

function RepCell({
  name,
  initials,
}: {
  name: string;
  initials: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <Avatar className="h-6 w-6">
        <AvatarFallback className="text-[10px]">{initials}</AvatarFallback>
      </Avatar>
      <span className="text-sm">{name}</span>
    </div>
  );
}

/** Live "currently in store" list — visits with no time-out yet. */
export function LiveInStore({
  checkins,
  onCheckout,
  onFollowUp,
  checkingOutId,
}: {
  checkins: CheckIn[];
  /** Check a customer out (PATCH /checkins/:id). */
  onCheckout?: (id: string) => void;
  /** Close the visit with a follow-up date and reminder already asked for. */
  onFollowUp?: (id: string) => void;
  /** Id of the check-in whose checkout is in flight. */
  checkingOutId?: string | null;
}) {
  const live = checkins.filter((c) => !c.timeOut);
  // The walk-in whose product interest is being recorded, or null.
  const [interestFor, setInterestFor] = useState<CheckIn | null>(null);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span className="h-2 w-2 shrink-0 rounded-full bg-success" />
          Currently in store
        </CardTitle>
        <CardDescription>
          {live.length} active {live.length === 1 ? "customer" : "customers"} being
          attended right now.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {live.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No customers in store right now — log a walk-in as they arrive.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {live.map((c) => (
              <div key={c.id} className="rounded-lg border p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-medium leading-tight">{c.customer}</p>
                    <p className="text-xs text-muted-foreground">
                      <span className="num">{c.partySize}</span>{" "}
                      {c.partySize === 1 ? "person" : "people"} ·{" "}
                      {c.returning ? "Returning" : "New"}
                    </p>
                  </div>
                  <Badge variant="outline" className="shrink-0">
                    {/* single span so the inline-flex badge keeps the space */}
                    <span>
                      since <span className="num">{c.timeIn}</span>
                    </span>
                  </Badge>
                </div>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <Badge variant="secondary">{c.purpose}</Badge>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <UserCheck className="h-3.5 w-3.5" />
                    {c.repName || "Unassigned"}
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {/* Only offered when the walk-in actually resolved to a
                      customer record — with no partyId there is nothing to
                      attach the interest to, and a button that fails is worse
                      than one that is absent. */}
                  {c.partyId ? (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        className="flex-1"
                        onClick={() => setInterestFor(c)}
                      >
                        <ScanLine className="h-3.5 w-3.5" />
                        Shown an item
                      </Button>
                      <Button asChild size="sm" variant="ghost">
                        <Link href={`/customers/${c.partyId}`}>History</Link>
                      </Button>
                    </>
                  ) : null}
                  {onFollowUp ? (
                    <Button
                      size="sm"
                      className="flex-1"
                      disabled={checkingOutId === c.id}
                      onClick={() => onFollowUp(c.id)}
                    >
                      <CalendarClock className="h-3.5 w-3.5" />
                      Follow up
                    </Button>
                  ) : null}
                  {onCheckout ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex-1"
                      disabled={checkingOutId === c.id}
                      onClick={() => onCheckout(c.id)}
                    >
                      <LogOut className="h-3.5 w-3.5" />
                      Close visit
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      {interestFor?.partyId ? (
        <RecordInterestDialog
          open
          onOpenChange={(o) => !o && setInterestFor(null)}
          partyId={interestFor.partyId}
          customerName={interestFor.customer}
          storeId={interestFor.storeId}
        />
      ) : null}
    </Card>
  );
}

/** Full walk-in log: time in/out, customer, attending rep, outcome. */
export function CheckInLog({ checkins }: { checkins: CheckIn[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <DoorOpen className="h-4 w-4 text-muted-foreground" />
          Walk-in log
        </CardTitle>
        <CardDescription>
          Today&apos;s check-ins with the sales executive who attended each
          customer.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>In</TableHead>
              <TableHead>Out</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Purpose</TableHead>
              <TableHead>Attended by</TableHead>
              <TableHead className="text-right">Dwell</TableHead>
              <TableHead>Outcome</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {checkins.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="py-10 text-center text-sm text-muted-foreground"
                >
                  No check-ins logged yet — log the first walk-in of the day.
                </TableCell>
              </TableRow>
            ) : null}
            {checkins.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="num">{c.timeIn}</TableCell>
                <TableCell className="num text-muted-foreground">
                  {c.timeOut ?? "—"}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{c.customer}</span>
                    {c.returning ? (
                      <Badge variant="outline" className="text-[10px]">
                        returning
                      </Badge>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">{c.phone}</p>
                </TableCell>
                <TableCell>
                  <Badge variant="secondary">{c.purpose}</Badge>
                </TableCell>
                <TableCell>
                  <RepCell name={c.repName} initials={c.repInitials} />
                </TableCell>
                <TableCell className="num text-right">
                  {c.durationMin != null ? `${c.durationMin}m` : "—"}
                </TableCell>
                <TableCell>
                  <Badge variant={OUTCOME_VARIANT[c.outcome] ?? "secondary"}>
                    {OUTCOME_LABEL_FALLBACK[c.outcome] ?? c.outcome}
                  </Badge>
                  {c.followUpDate ? (
                    <p className="mt-1 text-xs font-medium text-foreground">
                      Follow up {formatFollowUp(c.followUpDate)}
                      {c.preferredAction ? ` · ${ACTION_LABEL[c.preferredAction]}` : ""}
                    </p>
                  ) : null}
                  {c.reminder ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">{reminderLabel(c.reminder)}</p>
                  ) : null}
                  {c.feedback ? (
                    <p className="mt-0.5 text-xs text-muted-foreground" title={c.feedback.note ?? undefined}>
                      {feedbackLabel(c.feedback)}
                    </p>
                  ) : null}
                  {c.remark ? (
                    <p className="mt-0.5 max-w-56 truncate text-xs text-muted-foreground" title={c.remark}>
                      “{c.remark}”
                    </p>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
