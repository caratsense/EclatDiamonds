"use client";

import { DoorOpen, LogOut, UserCheck } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  checkingOutId,
}: {
  checkins: CheckIn[];
  /** Check a customer out (PATCH /checkins/:id). */
  onCheckout?: (id: string) => void;
  /** Id of the check-in whose checkout is in flight. */
  checkingOutId?: string | null;
}) {
  const live = checkins.filter((c) => !c.timeOut);
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
                    in <span className="num">{c.timeIn}</span>
                  </Badge>
                </div>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <Badge variant="secondary">{c.purpose}</Badge>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <UserCheck className="h-3.5 w-3.5" />
                    {c.repName || "Unassigned"}
                  </div>
                </div>
                {onCheckout ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-3 w-full"
                    disabled={checkingOutId === c.id}
                    onClick={() => onCheckout(c.id)}
                  >
                    <LogOut className="h-3.5 w-3.5" />
                    Close visit
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </CardContent>
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
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
