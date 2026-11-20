"use client";

import Link from "next/link";
import { ArrowLeft, Bot, Info, Radio } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusPill } from "@/components/ui/status-pill";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CHANNEL_LABEL, STATE_LABEL, useAdapterReport } from "@/lib/queries/adapters";

/**
 * What can actually reach a customer today.
 *
 * A read-only page whose whole purpose is to stop a conversation that otherwise
 * goes "why did that campaign send nothing". It is open to every role on
 * purpose: a salesperson who cannot see that Instagram is not connected will
 * keep telling customers somebody will message them there.
 *
 * Two things it refuses to round off. A channel is never shown as connected
 * because a credential was saved — `verified` means a real provider answered,
 * and the footer says plainly that none has. And "logged, not sent" gets its own
 * colour and its own sentence, because it is a finished path waiting on a
 * setting rather than a feature waiting on somebody else's approval.
 */
export default function ChannelsPage() {
  const report = useAdapterReport();

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Link
          href="/settings"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" /> Settings
        </Link>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Radio className="size-5" /> What can reach a customer
        </h1>
        <p className="text-sm text-muted-foreground">
          Every outbound channel, what it would do right now, and what is missing where it
          would not.
        </p>
      </div>

      {report.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : !report.data ? null : (
        <>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Channel</TableHead>
                  <TableHead>Right now</TableHead>
                  <TableHead>Why</TableHead>
                  <TableHead>Confirmed with provider</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.data.channels.map((c) => {
                  const state = STATE_LABEL[c.state];
                  return (
                    <TableRow key={c.channel}>
                      <TableCell>
                        <div className="font-medium">{CHANNEL_LABEL[c.channel] ?? c.channel}</div>
                        {c.capabilities ? (
                          <div className="text-xs text-muted-foreground">
                            {Object.entries(c.capabilities)
                              .filter(([, on]) => on)
                              .map(([name]) => name)
                              .join(", ") || "nothing enabled"}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <StatusPill tone={state.tone}>{state.label}</StatusPill>
                        <div className="max-w-xs text-xs text-muted-foreground">{state.hint}</div>
                      </TableCell>
                      <TableCell className="max-w-md text-sm text-muted-foreground">
                        {c.reason}
                      </TableCell>
                      <TableCell>
                        <StatusPill tone={c.verified ? "good" : "mute"}>
                          {c.verified ? "Yes" : "Not yet"}
                        </StatusPill>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          {/* ---------------------------------------------------------------- */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Bot className="size-4" /> The AI
              </CardTitle>
              <CardDescription>
                {report.data.ai.configured
                  ? `${report.data.ai.vendor} · ${report.data.ai.model}`
                  : "Not configured"}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {report.data.ai.reason ? (
                <p className="text-sm text-muted-foreground">{report.data.ai.reason}</p>
              ) : null}
              <div className="grid gap-2 sm:grid-cols-2">
                <AiRow
                  label="Reading a conversation for your signals"
                  enabled={report.data.ai.capabilities.extraction.enabled}
                  reason={report.data.ai.capabilities.extraction.reason}
                />
                <AiRow
                  label="Drafting a reply for approval"
                  enabled={report.data.ai.capabilities.drafting.enabled}
                  reason={report.data.ai.capabilities.drafting.reason}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                These are reported separately because they are separately implemented. One being
                off does not mean the other is.
              </p>
            </CardContent>
          </Card>

          {/* ---------------------------------------------------------------- */}
          <Card className="border-dashed">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Info className="size-4" /> About &ldquo;confirmed with provider&rdquo;
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">{report.data.verification.note}</p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function AiRow({
  label,
  enabled,
  reason,
}: {
  label: string;
  enabled: boolean;
  reason: string | null;
}) {
  return (
    <div className="space-y-1 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <StatusPill tone={enabled ? "good" : "mute"}>{enabled ? "On" : "Off"}</StatusPill>
      </div>
      {reason ? <p className="text-xs text-muted-foreground">{reason}</p> : null}
    </div>
  );
}
