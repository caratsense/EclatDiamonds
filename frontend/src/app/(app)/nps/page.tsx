"use client";

import { useState } from "react";
import { Gauge, Inbox, Menu } from "lucide-react";

import { ExcelExportButton } from "@/components/common/excel-export-button";
import { SectionHeader } from "@/components/section/section-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { getNavItem } from "@/lib/navigation";
import {
  type NpsStage,
  type NpsUpdateRow,
  useNpsResponses,
  useNpsUpdates,
} from "@/lib/queries/nps";
import { cn } from "@/lib/utils";

type Screen = "updates" | "responses";

/** Stage colour follows meaning, not decoration: red needs a person. */
const STAGE_TONE: Record<NpsStage, string> = {
  pending_initial: "bg-muted text-muted-foreground",
  initial_sent: "bg-accent-soft text-accent-solid",
  awaiting_response: "bg-accent-soft text-accent-solid",
  reminder_due: "bg-warning/15 text-warning",
  reminder_sent: "bg-accent-soft text-accent-solid",
  completed: "bg-success/15 text-success",
  failed: "bg-destructive/15 text-destructive",
};

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—";

export default function NpsPage() {
  const nav = getNavItem("nps");
  const [screen, setScreen] = useState<Screen>("updates");

  return (
    <div className="space-y-4">
      <SectionHeader
        title={nav?.title ?? "NPS"}
        purpose={nav?.purpose ?? ""}
        actions={
          <div className="flex items-center gap-2">
            {/*
              The client asked for a hamburger inside NPS holding the two
              screens. It is a menu rather than tabs on purpose: more screens
              are coming (reconciliation, settings) and a menu grows without
              re-laying out the header.
            */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-8 gap-1.5">
                  <Menu className="h-3.5 w-3.5" />
                  {screen === "updates" ? "NPS Updates" : "NPS Responses"}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuLabel>NPS</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setScreen("updates")}>
                  NPS Updates
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setScreen("responses")}>
                  NPS Responses
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <ExcelExportButton path="/crm/nps/export" fallbackName="nps.xlsx" />
          </div>
        }
      />
      {screen === "updates" ? <Updates /> : <Responses />}
    </div>
  );
}

function Updates() {
  const { data, isLoading } = useNpsUpdates({ take: 200 });
  if (isLoading) return <Skeleton className="h-64 w-full" />;
  const rows = data?.rows ?? [];
  if (!rows.length) {
    return (
      <EmptyState
        icon={Gauge}
        title="No visits yet"
        description="Every checked-in customer appears here, whether or not they answered."
      />
    );
  }

  return (
    <Card>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="p-3">Customer</th>
                <th className="p-3">Store / visit</th>
                <th className="p-3">Stage</th>
                <th className="p-3">Message sent</th>
                <th className="p-3">Reminder</th>
                <th className="p-3">Replied</th>
                <th className="p-3">Form submitted</th>
                <th className="p-3">Follow-up</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Row key={r.checkInId} r={r} />
              ))}
            </tbody>
          </table>
        </div>
        <p className="border-t p-3 text-xs text-muted-foreground">
          Showing {rows.length} of {data?.total ?? rows.length}. The Excel export carries
          every authorised record, not just this page.
        </p>
      </CardContent>
    </Card>
  );
}

function Row({ r }: { r: NpsUpdateRow }) {
  return (
    <tr className="border-b last:border-0 align-top">
      <td className="p-3">
        <div className="font-medium">{r.customerName ?? "—"}</div>
        <div className="text-xs text-muted-foreground">{r.phone ?? "no number"}</div>
      </td>
      <td className="p-3">
        <div>{r.store ?? "—"}</div>
        <div className="text-xs text-muted-foreground">
          {when(r.visitAt)}
          {r.salesperson ? ` · ${r.salesperson}` : ""}
        </div>
      </td>
      <td className="p-3">
        <Badge className={cn("font-medium", STAGE_TONE[r.stage])}>{r.stageLabel}</Badge>
        {r.failureNote ? (
          <div className="mt-1 max-w-[18rem] text-xs text-destructive">{r.failureNote}</div>
        ) : null}
      </td>
      <td className="p-3 text-xs">{when(r.initialSentAt)}</td>
      <td className="p-3 text-xs">
        <div>due {when(r.reminderDueAt)}</div>
        <div className="text-muted-foreground">sent {when(r.reminderSentAt)}</div>
      </td>
      {/* Replied and submitted are separate columns, deliberately: a WhatsApp
          reply is not a completed form. */}
      <td className="p-3 text-xs">{when(r.repliedAt)}</td>
      <td className="p-3 text-xs">
        {when(r.submittedAt)}
        {r.score != null ? <div className="font-medium">score {r.score}</div> : null}
      </td>
      <td className="p-3 text-xs">
        {r.followups.length
          ? r.followups.map((f) => (
              <div key={f.id} className="max-w-[16rem] truncate">
                {f.response ?? "—"}
              </div>
            ))
          : "—"}
      </td>
    </tr>
  );
}

function Responses() {
  const { data, isLoading } = useNpsResponses();
  if (isLoading) return <Skeleton className="h-64 w-full" />;
  const rows = data?.rows ?? [];
  if (!rows.length) {
    return (
      <EmptyState
        icon={Inbox}
        title="No submissions yet"
        description="Responses from the NPS form appear here once the sheet is connected."
      />
    );
  }

  return (
    <Card>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="p-3">Submitted</th>
                <th className="p-3">Name / number</th>
                <th className="p-3">Score</th>
                <th className="p-3">Match</th>
                <th className="p-3">Liked</th>
                <th className="p-3">Could improve</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b last:border-0 align-top">
                  <td className="p-3 text-xs">{when(r.submittedAt)}</td>
                  <td className="p-3">
                    <div className="font-medium">{r.rawName ?? "—"}</div>
                    <div className="text-xs text-muted-foreground">{r.rawNumber ?? "—"}</div>
                  </td>
                  <td className="p-3">
                    <div className="font-medium">{r.score ?? "—"}</div>
                    <div className="max-w-[12rem] truncate text-xs text-muted-foreground">
                      {r.recommendAnswer ?? ""}
                    </div>
                  </td>
                  <td className="p-3">
                    {/* An unmatched or ambiguous response stays visible for a
                        person to reconcile — never quietly dropped. */}
                    <Badge
                      className={cn(
                        "font-medium",
                        r.matchState === "matched"
                          ? "bg-success/15 text-success"
                          : r.matchState === "ambiguous"
                            ? "bg-warning/15 text-warning"
                            : "bg-muted text-muted-foreground",
                      )}
                    >
                      {r.matchState}
                    </Badge>
                    <div className="mt-1 max-w-[16rem] text-xs text-muted-foreground">
                      {r.party?.name ?? r.matchNote ?? ""}
                    </div>
                  </td>
                  <td className="p-3 max-w-[16rem] text-xs">{r.likedMost ?? "—"}</td>
                  <td className="p-3 max-w-[16rem] text-xs">{r.couldImprove ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
