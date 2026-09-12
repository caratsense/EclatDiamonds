"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, Clock, PhoneOff, RefreshCw, Timer } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { STAT_LABEL, STAT_VALUE_SM } from "@/components/ui/stat";
import { StatusPill, type PillTone } from "@/components/ui/status-pill";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  formatResponseTime,
  useResponseSlaClocks,
  useResponseSlaSettings,
  useResponseSlaSummary,
  useSaveResponseSlaSettings,
  useSweepResponseSla,
  type ResponseSlaClock,
} from "@/lib/queries/response-sla";
import { apiErrorMessage } from "@/lib/utils";
import { useSession } from "@/store/use-session";

const STATE: Record<ResponseSlaClock["status"], { label: string; tone: PillTone }> = {
  waiting: { label: "Waiting", tone: "wait" },
  met: { label: "Answered in time", tone: "good" },
  breached: { label: "Missed", tone: "bad" },
};

const FILTERS: { key: ResponseSlaClock["status"] | "all"; label: string }[] = [
  { key: "breached", label: "Missed" },
  { key: "waiting", label: "Waiting" },
  { key: "met", label: "In time" },
  { key: "all", label: "Everything" },
];

/**
 * The five-minute promise, and who is not keeping it.
 *
 * Two things this screen deliberately does NOT do. It does not compute its own
 * counts from the rows in the table — every figure is the server's aggregate, so
 * "12 missed" is 12 missed and not "12 of the 50 rows we happen to be showing".
 * And it does not claim an automatic call will be placed: the switch says what
 * it would do, and beside it the reason it currently cannot.
 */
export default function ResponseSlaPage() {
  const role = useSession((s) => s.role);
  const isHo = role === "head_office";
  const canSweep = isHo || role === "store_manager";

  const [status, setStatus] = useState<ResponseSlaClock["status"] | "all">("breached");
  const [days, setDays] = useState(7);

  const settings = useResponseSlaSettings();
  const summary = useResponseSlaSummary({ days });
  const clocks = useResponseSlaClocks({
    days,
    limit: 200,
    ...(status === "all" ? {} : { status }),
  });
  const save = useSaveResponseSlaSettings();
  const sweep = useSweepResponseSla();

  const [target, setTarget] = useState("");
  const [escalate, setEscalate] = useState("");

  const s = settings.data;
  const sum = summary.data;

  const onSave = () => {
    const parsed = target.trim() === "" ? null : Number(target);
    const parsedEscalate = escalate.trim() === "" ? null : Number(escalate);
    save.mutate(
      { firstResponseMinutes: parsed, escalateAfterMinutes: parsedEscalate },
      {
        onSuccess: (res) =>
          toast.success(
            res.firstResponseMinutes == null
              ? "First-response target turned off"
              : `First reply now expected within ${res.firstResponseMinutes} minutes`,
          ),
        onError: (e) => toast.error(apiErrorMessage(e, "Could not save that.")),
      },
    );
  };

  const onSweep = () => {
    sweep.mutate(undefined, {
      onSuccess: (res) =>
        toast.success(
          res.breached === 0 && res.escalated === 0
            ? "Nothing overdue right now"
            : `${res.breached} newly missed, ${res.escalated} escalated`,
        ),
      onError: (e) => toast.error(apiErrorMessage(e, "Could not check.")),
    });
  };

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Link
          href="/conversations"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" /> Conversations
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
              <Timer className="size-5" /> Response time
            </h1>
            <p className="text-sm text-muted-foreground">
              How long customers wait for a first reply, and which conversations went past it.
            </p>
          </div>
          {canSweep ? (
            <Button variant="outline" onClick={onSweep} disabled={sweep.isPending}>
              <RefreshCw className={sweep.isPending ? "size-4 animate-spin" : "size-4"} />
              Check now
            </Button>
          ) : null}
        </div>
      </div>

      {/* ---------------------------------------------------------------- */}
      {settings.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : s && !s.active ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No reply target is set</CardTitle>
            <CardDescription>
              Nothing is being measured. Set a number of minutes and every customer message from
              then on is timed from when it arrived.
            </CardDescription>
          </CardHeader>
          {isHo ? (
            <CardContent className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="sla-target">Reply within (minutes)</Label>
                <Input
                  id="sla-target"
                  inputMode="numeric"
                  className="w-32"
                  placeholder="5"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sla-escalate">Tell a manager after (minutes)</Label>
                <Input
                  id="sla-escalate"
                  inputMode="numeric"
                  className="w-40"
                  placeholder="Optional"
                  value={escalate}
                  onChange={(e) => setEscalate(e.target.value)}
                />
              </div>
              <Button onClick={onSave} disabled={save.isPending}>
                Start measuring
              </Button>
              <p className="w-full text-xs text-muted-foreground">
                Counted from the customer&rsquo;s message, so &ldquo;tell a manager&rdquo; cannot be
                sooner than the reply target.
              </p>
            </CardContent>
          ) : (
            <CardContent className="text-sm text-muted-foreground">
              Head office sets this.
            </CardContent>
          )}
        </Card>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {sum ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Tile label="Tracked" value={sum.tracked} />
          <Tile label="In time" value={sum.met} tone="text-emerald-600 dark:text-emerald-400" />
          <Tile
            label="Missed"
            value={sum.breached}
            tone={sum.breached > 0 ? "text-rose-600 dark:text-rose-400" : undefined}
          />
          <Tile label="Escalated" value={sum.escalated} />
          <Tile label="Still waiting" value={sum.awaiting} />
          <Tile
            label="Median reply"
            /* Null, not zero, when nothing has been measured. Zero would read as
               "we answer instantly", which is the opposite of the truth. */
            text={formatResponseTime(sum.medianResponseSeconds)}
          />
        </div>
      ) : null}

      {sum && sum.withinTargetPct != null ? (
        <p className="text-sm text-muted-foreground">
          <span className="num font-semibold text-foreground">{sum.withinTargetPct}%</span> answered
          within {sum.targetMinutes} minutes over the last {sum.windowDays} days. 90th percentile{" "}
          <span className="num">{formatResponseTime(sum.p90ResponseSeconds)}</span>.
        </p>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <Button
            key={f.key}
            size="sm"
            variant={status === f.key ? "default" : "outline"}
            onClick={() => setStatus(f.key)}
          >
            {f.label}
          </Button>
        ))}
        <span className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
          <Clock className="size-3.5" />
          {[1, 7, 30].map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={
                days === d
                  ? "font-semibold text-foreground underline underline-offset-4"
                  : "hover:text-foreground"
              }
            >
              {d}d
            </button>
          ))}
        </span>
      </div>

      {clocks.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : (clocks.data ?? []).length === 0 ? (
        <EmptyState
          icon={AlertTriangle}
          title={status === "breached" ? "Nothing missed" : "Nothing here"}
          description={
            status === "breached"
              ? "Every customer message in this window got a reply inside the target."
              : "No conversations match that filter in this window."
          }
        />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead>Channel</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>They messaged</TableHead>
                <TableHead className="text-right">Waited</TableHead>
                <TableHead>Answered by</TableHead>
                <TableHead>State</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(clocks.data ?? []).map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium">
                    <Link
                      href={`/conversations?id=${row.conversationId}`}
                      className="hover:underline"
                    >
                      {row.customerName ?? "Unknown caller"}
                    </Link>
                  </TableCell>
                  <TableCell className="capitalize text-muted-foreground">{row.channel}</TableCell>
                  <TableCell className="text-muted-foreground">{row.storeName ?? "—"}</TableCell>
                  <TableCell className="num text-muted-foreground">
                    {new Date(row.startedAt).toLocaleString()}
                  </TableCell>
                  <TableCell className="num text-right">
                    {formatResponseTime(row.responseSeconds)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {/* An approved AI reply is never shown as a person's. */}
                    {row.responderType === "ai"
                      ? "AI (approved)"
                      : (row.responderName ?? (row.respondedAt ? "—" : "Nobody yet"))}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <StatusPill tone={STATE[row.status].tone}>{STATE[row.status].label}</StatusPill>
                      {row.escalatedAt ? (
                        <StatusPill tone="bad" title="A manager was told">
                          Escalated
                        </StatusPill>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {isHo && s?.active ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">The promise</CardTitle>
            <CardDescription>
              Reply within {s.firstResponseMinutes} minutes
              {s.escalateAfterMinutes
                ? `, and a manager hears about it ${s.escalateAfterMinutes} minutes after the customer messaged.`
                : ". Nothing escalates."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="sla-target-2">Reply within (minutes)</Label>
                <Input
                  id="sla-target-2"
                  inputMode="numeric"
                  className="w-32"
                  placeholder={String(s.firstResponseMinutes ?? 5)}
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sla-escalate-2">Tell a manager after (minutes)</Label>
                <Input
                  id="sla-escalate-2"
                  inputMode="numeric"
                  className="w-40"
                  placeholder={s.escalateAfterMinutes ? String(s.escalateAfterMinutes) : "Never"}
                  value={escalate}
                  onChange={(e) => setEscalate(e.target.value)}
                />
              </div>
              <Button onClick={onSave} disabled={save.isPending}>
                Save
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Leave the reply target empty to stop measuring. Escalation stops with it.
            </p>

            {/*
              Said plainly rather than hidden. A switch labelled "call the
              customer automatically" that silently does nothing is worse than
              no switch at all.
            */}
            <div className="flex items-start gap-2 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
              <PhoneOff className="mt-0.5 size-4 shrink-0" />
              <span>
                {s.autoCallBlockedReason ??
                  "A missed reply will place an automatic call through the connected provider."}
              </span>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function Tile({
  label,
  value,
  text,
  tone,
}: {
  label: string;
  value?: number;
  text?: string;
  tone?: string;
}) {
  return (
    <div className="rounded-lg border p-3">
      <div className={STAT_LABEL}>{label}</div>
      <div className={tone ? `${STAT_VALUE_SM} ${tone}` : STAT_VALUE_SM}>{text ?? value ?? 0}</div>
    </div>
  );
}
