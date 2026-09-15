"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Copy,
  Gift,
  KeyRound,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import {
  DELIVERY_STATUS,
  type DeliveryStatus,
  ENTRY_KIND,
  useLoyaltyMembers,
  useManualMovement,
  useMemberLedger,
  useProgrammeSettings,
  useRetryAnnouncements,
  useRetryWebhookDelivery,
  useRotateApiKey,
  useRotateSigningSecret,
  useUpdateProgrammeSettings,
  useWebhookDeliveries,
  useWebhookDelivery,
} from "@/lib/queries/loyalty-programme";
import { formatINR, formatNumber } from "@/lib/format";
import { apiErrorMessage } from "@/lib/utils";
import { useSession } from "@/store/use-session";

/**
 * The points programme, and the door the tenant's own website comes in through.
 *
 * Three things the screen says out loud rather than leaving to be inferred.
 * Earning is OFF until both halves of the rate are set, and the banner says so
 * — a website that silently earns nothing looks like a broken integration for
 * weeks. A credential is shown once and never again, so it is presented as
 * something to copy now rather than a field to come back to. And a movement the
 * website was never told about is listed as exactly that, because a stale
 * balance on a customer-facing page is the failure people actually notice.
 */
export default function LoyaltyProgrammePage() {
  const role = useSession((s) => s.role);
  const stores = useSession((s) => s.stores);
  const isHo = role === "head_office";
  const canMove = isHo || role === "store_manager";
  const canReadDeliveries = canMove || role === "area_manager";

  const settings = useProgrammeSettings();
  const save = useUpdateProgrammeSettings();
  const rotateKey = useRotateApiKey();
  const rotateSecret = useRotateSigningSecret();
  const retry = useRetryAnnouncements();
  const move = useManualMovement();

  const [q, setQ] = useState("");
  const [openPhone, setOpenPhone] = useState<string | null>(null);
  const members = useLoyaltyMembers({ q: q.trim() || undefined });
  const ledger = useMemberLedger(openPhone);

  /** Shown once, held in component state only, never cached by a query. */
  const [issued, setIssued] = useState<{ label: string; value: string; note: string } | null>(
    null,
  );

  const [form, setForm] = useState<Record<string, string>>({});
  const field = (name: keyof typeof form, fallback: unknown) =>
    form[name] ?? (fallback == null ? "" : String(fallback));

  const onSave = () => {
    // Only what the form actually holds. An empty box is "clear it" (null), a
    // box the operator never opened is absent, so the server leaves it alone.
    const parse = (name: string): number | null | undefined => {
      if (!(name in form)) return undefined;
      const raw = form[name].trim();
      if (!raw) return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    };
    const payload: Record<string, unknown> = {};
    for (const name of [
      "earnPoints",
      "earnPerAmount",
      "redeemValuePerPoint",
      "maxRedeemPointsPerTransaction",
    ]) {
      const v = parse(name);
      if (v !== undefined) payload[name] = v;
    }
    const min = parse("minRedeemPoints");
    if (min != null) payload.minRedeemPoints = min;
    if ("webhookUrl" in form) payload.webhookUrl = form.webhookUrl.trim() || null;

    if (!Object.keys(payload).length) {
      toast.info("Nothing changed.");
      return;
    }
    save.mutate(payload, {
      onSuccess: () => {
        setForm({});
        toast.success("Programme saved.");
      },
      onError: (e) => toast.error(apiErrorMessage(e, "Could not save that.")),
    });
  };

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Copied.");
    } catch {
      // Clipboard access can be refused outright; the value is on screen to
      // select by hand, so this is worth saying rather than failing silently.
      toast.error("Your browser would not let the page copy. Select it by hand.");
    }
  };

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Link
          href="/loyalty"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" /> Loyalty
        </Link>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Gift className="size-5" /> Points programme
        </h1>
        <p className="text-sm text-muted-foreground">
          What a purchase earns, what a point is worth, and the key your website signs in with.
        </p>
      </div>

      {/* ---------------------------------------------------------------- */}
      {settings.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : settings.data && !settings.data.configured ? (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="size-4" /> Earning is switched off
            </CardTitle>
            <CardDescription>
              A purchase cannot award points until both halves of the rate are set: how many
              points, and per how much spend. Your website will be told so rather than quietly
              earning nothing.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">The rate</CardTitle>
          <CardDescription>
            CaratOS computes what a purchase earns. Your website reports the spend, not the
            points &mdash; so this stays the one place the rule lives.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Money
              id="earnPoints"
              label="Points awarded"
              value={field("earnPoints", settings.data?.earnPoints)}
              onChange={(v) => setForm((f) => ({ ...f, earnPoints: v }))}
              disabled={!isHo}
            />
            <Money
              id="earnPerAmount"
              label="Per spend of (₹)"
              value={field("earnPerAmount", settings.data?.earnPerAmount)}
              onChange={(v) => setForm((f) => ({ ...f, earnPerAmount: v }))}
              disabled={!isHo}
            />
            <Money
              id="redeemValuePerPoint"
              label="One point is worth (₹)"
              value={field("redeemValuePerPoint", settings.data?.redeemValuePerPoint)}
              onChange={(v) => setForm((f) => ({ ...f, redeemValuePerPoint: v }))}
              disabled={!isHo}
            />
            <Money
              id="minRedeemPoints"
              label="Redeem from (points)"
              value={field("minRedeemPoints", settings.data?.minRedeemPoints)}
              onChange={(v) => setForm((f) => ({ ...f, minRedeemPoints: v }))}
              disabled={!isHo}
            />
            <Money
              id="maxRedeemPointsPerTransaction"
              label="Most per sale (points)"
              value={field(
                "maxRedeemPointsPerTransaction",
                settings.data?.maxRedeemPointsPerTransaction,
              )}
              onChange={(v) =>
                setForm((f) => ({ ...f, maxRedeemPointsPerTransaction: v }))
              }
              disabled={!isHo}
            />
            <div className="space-y-1">
              <Label htmlFor="webhookUrl">Announce movements to (https)</Label>
              <Input
                id="webhookUrl"
                placeholder="https://yourshop.example/loyalty-hook"
                value={field("webhookUrl", settings.data?.webhookUrl)}
                onChange={(e) => setForm((f) => ({ ...f, webhookUrl: e.target.value }))}
                disabled={!isHo}
              />
            </div>
          </div>
          {isHo ? (
            <div className="flex flex-wrap gap-2">
              <Button onClick={onSave} disabled={save.isPending}>
                {save.isPending ? "Saving…" : "Save programme"}
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  retry.mutate(undefined, {
                    onSuccess: (r) =>
                      toast.success(
                        r.queued
                          ? `${r.queued} announcement(s) queued. Watch them below.`
                          : "Nothing was waiting to be queued.",
                      ),
                    onError: (e) => toast.error(apiErrorMessage(e, "Could not retry those.")),
                  })
                }
                disabled={retry.isPending}
              >
                <RefreshCw className="size-4" /> Retry missed announcements
              </Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Head office sets the rate. What somebody earns is not a branch decision.
            </p>
          )}
        </CardContent>
      </Card>

      {/* ---------------------------------------------------------------- */}
      {isHo ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="size-4" /> The website&rsquo;s credentials
            </CardTitle>
            <CardDescription>
              Both are shown once and stored only as a hash or encrypted. If one is lost, issue
              another &mdash; there is no screen that can show it again.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() =>
                  rotateKey.mutate(undefined, {
                    onSuccess: (r) =>
                      setIssued({ label: "API key", value: r.key, note: r.warning }),
                    onError: (e) => toast.error(apiErrorMessage(e, "Could not issue a key.")),
                  })
                }
                disabled={rotateKey.isPending}
              >
                <KeyRound className="size-4" /> Issue a new API key
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  rotateSecret.mutate(undefined, {
                    onSuccess: (r) =>
                      setIssued({ label: "Signing secret", value: r.secret, note: r.warning }),
                    onError: (e) =>
                      toast.error(apiErrorMessage(e, "Could not issue a secret.")),
                  })
                }
                disabled={rotateSecret.isPending}
              >
                <ShieldCheck className="size-4" /> Issue a new signing secret
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Issuing a new one stops the old one working immediately. That is the point of
              rotating, so change your website first if it is live.
            </p>

            {issued ? (
              <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
                <div className="text-sm font-medium">{issued.label}</div>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-xs">
                    {issued.value}
                  </code>
                  <Button size="sm" variant="outline" onClick={() => copy(issued.value)}>
                    <Copy className="size-3.5" /> Copy
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">{issued.note}</p>
                <Button size="sm" variant="ghost" onClick={() => setIssued(null)}>
                  I have copied it
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {canReadDeliveries ? <Announcements canRetry={isHo} /> : null}

      {/* ---------------------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="max-w-xs"
          placeholder="Search by name or number"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {members.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : (members.data ?? []).length === 0 ? (
        <EmptyState
          icon={Gift}
          title="No members yet"
          description="Members appear here as they join, whether at the counter or on your website."
        />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead className="text-right">Worth</TableHead>
                <TableHead className="text-right">Earned</TableHead>
                <TableHead className="text-right">Spent</TableHead>
                <TableHead>State</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(members.data ?? []).map((m) => (
                <TableRow key={m.id}>
                  <TableCell>
                    <button
                      type="button"
                      className="font-medium hover:underline"
                      onClick={() => setOpenPhone(openPhone === m.phone ? null : m.phone)}
                    >
                      {m.name ?? m.phone}
                    </button>
                    <div className="text-xs text-muted-foreground">
                      {m.phone}
                      {m.tier ? ` · ${m.tier}` : ""}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {m.storeId
                      ? stores.find((s) => s.id === m.storeId)?.name ?? "—"
                      : "Joined online"}
                  </TableCell>
                  <TableCell className="text-right">
                    {m.adjustmentDebt > 0 ? (
                      <>
                        {/*
                          Labelled, not just coloured. A negative number in a
                          "balance" column reads as points somebody has; this is
                          the opposite — a cancelled sale took back what had
                          already been spent, and they owe it.
                        */}
                        <div className="num font-semibold text-rose-600 dark:text-rose-400">
                          &minus;{formatNumber(m.adjustmentDebt)}
                        </div>
                        <StatusPill tone="bad">Owed back</StatusPill>
                      </>
                    ) : (
                      <div className="num font-semibold">
                        {formatNumber(m.spendablePoints)}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="num text-right text-muted-foreground">
                    {settings.data?.redeemValuePerPoint == null
                      ? "—"
                      : m.adjustmentDebt > 0
                        ? // Nothing to spend. Never a negative discount.
                          formatINR(0)
                        : formatINR(m.spendablePoints * settings.data.redeemValuePerPoint)}
                  </TableCell>
                  <TableCell className="num text-right text-muted-foreground">
                    {formatNumber(m.lifetimeEarned)}
                  </TableCell>
                  <TableCell className="num text-right text-muted-foreground">
                    {formatNumber(m.lifetimeRedeemed)}
                  </TableCell>
                  <TableCell>
                    <StatusPill tone={m.status === "active" ? "good" : "bad"}>
                      {m.status}
                    </StatusPill>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {openPhone ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Statement — {openPhone}</CardTitle>
            <CardDescription>
              Every movement, with the balance it produced. This is what a disputed balance is
              settled from.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {canMove ? (
              <ManualMovement
                phone={openPhone}
                canAdjust={isHo}
                pending={move.isPending}
                onSubmit={(payload) =>
                  move.mutate(
                    { phone: openPhone, ...payload },
                    {
                      onSuccess: (r) =>
                        toast.success(
                          `${r.points > 0 ? "+" : ""}${r.points} points · balance ${r.balance}`,
                        ),
                      onError: (e) =>
                        toast.error(apiErrorMessage(e, "Could not move those points.")),
                    },
                  )
                }
              />
            ) : null}

            {ledger.isLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>What</TableHead>
                      <TableHead>Where</TableHead>
                      <TableHead className="text-right">Points</TableHead>
                      <TableHead className="text-right">Balance</TableHead>
                      <TableHead>Reference</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(ledger.data?.entries ?? []).map((e) => (
                      <TableRow key={e.id}>
                        <TableCell className="num whitespace-nowrap text-xs">
                          {new Date(e.createdAt).toLocaleString()}
                        </TableCell>
                        <TableCell>
                          <StatusPill tone={ENTRY_KIND[e.kind]?.tone ?? "mute"}>
                            {ENTRY_KIND[e.kind]?.label ?? e.kind}
                          </StatusPill>
                          {e.reason ? (
                            <div className="text-xs text-muted-foreground">{e.reason}</div>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {e.source === "website" ? "Website" : "Counter"}
                        </TableCell>
                        <TableCell
                          className={
                            e.points < 0
                              ? "num text-right text-rose-600 dark:text-rose-400"
                              : "num text-right text-emerald-700 dark:text-emerald-400"
                          }
                        >
                          {e.points > 0 ? `+${e.points}` : e.points}
                        </TableCell>
                        <TableCell className="num text-right">{e.balanceAfter}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {e.reference ?? "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

/**
 * Every announcement to the website and what became of it.
 *
 * "Retrying" and "Dead" are kept apart on purpose: the first needs nobody, the
 * queue will try again on its own; the second has given up and needs a person
 * to fix the website and press Retry. Nothing here can show a secret — the
 * server returns the destination without its query string and the payload only
 * as field names and a digest.
 */
function Announcements({ canRetry }: { canRetry: boolean }) {
  const [status, setStatus] = useState<DeliveryStatus | undefined>(undefined);
  const [openId, setOpenId] = useState<string | null>(null);
  const deliveries = useWebhookDeliveries(status, true);
  const detail = useWebhookDelivery(openId);
  const retry = useRetryWebhookDelivery();

  const counts = deliveries.data?.counts;
  const filters: { value: DeliveryStatus | undefined; label: string; count?: number }[] = [
    { value: undefined, label: "All" },
    ...(Object.keys(DELIVERY_STATUS) as DeliveryStatus[]).map((s) => ({
      value: s,
      label: DELIVERY_STATUS[s].label,
      count: counts?.[s],
    })),
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Send className="size-4" /> Website announcements
        </CardTitle>
        <CardDescription>
          Each points movement is posted to your website, signed. It counts as delivered only when
          your website answers with success; otherwise it is retried with growing gaps and marked
          dead after the last attempt.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {filters.map((f) => (
            <Button
              key={f.label}
              size="sm"
              variant={status === f.value ? "default" : "outline"}
              onClick={() => {
                setStatus(f.value);
                setOpenId(null);
              }}
            >
              {f.label}
              {f.count != null ? ` (${f.count})` : ""}
            </Button>
          ))}
        </div>

        {deliveries.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : (deliveries.data?.items ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing here.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Queued</TableHead>
                  <TableHead>Movement</TableHead>
                  <TableHead>Destination</TableHead>
                  <TableHead className="text-right">Attempts</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead className="text-right">Answer</TableHead>
                  <TableHead>Next / done</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(deliveries.data?.items ?? []).map((d) => (
                  <TableRow
                    key={d.id}
                    className="cursor-pointer"
                    onClick={() => setOpenId(openId === d.id ? null : d.id)}
                  >
                    <TableCell className="num whitespace-nowrap text-xs">
                      {new Date(d.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-xs">
                      {ENTRY_KIND[d.movement.kind]?.label ?? d.movement.kind}{" "}
                      <span className="num">
                        {d.movement.points > 0 ? `+${d.movement.points}` : d.movement.points}
                      </span>
                      {d.movement.reference ? (
                        <div className="text-muted-foreground">{d.movement.reference}</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="max-w-[16rem] truncate text-xs text-muted-foreground">
                      {d.destination ?? "—"}
                    </TableCell>
                    <TableCell className="num text-right">
                      {d.attempts}
                    </TableCell>
                    <TableCell>
                      <StatusPill tone={DELIVERY_STATUS[d.status].tone}>
                        {DELIVERY_STATUS[d.status].label}
                      </StatusPill>
                    </TableCell>
                    <TableCell className="num text-right text-xs">{d.responseCode ?? "—"}</TableCell>
                    <TableCell className="num whitespace-nowrap text-xs text-muted-foreground">
                      {d.deliveredAt
                        ? new Date(d.deliveredAt).toLocaleString()
                        : d.nextAttemptAt
                          ? new Date(d.nextAttemptAt).toLocaleString()
                          : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {openId && detail.data ? (
          <div className="space-y-3 rounded-md border p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-medium">
                {detail.data.eventType}{" "}
                <StatusPill tone={DELIVERY_STATUS[detail.data.status].tone}>
                  {DELIVERY_STATUS[detail.data.status].label}
                </StatusPill>
              </div>
              {canRetry && detail.data.canRetry ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={retry.isPending}
                  onClick={() =>
                    retry.mutate(detail.data.id, {
                      onSuccess: (r) =>
                        r.requeued
                          ? toast.success("Queued again. It will be tried within a minute.")
                          : toast.info("It is no longer dead, so nothing was queued."),
                      onError: (e) => toast.error(apiErrorMessage(e, "Could not retry it.")),
                    })
                  }
                >
                  <RefreshCw className="size-3.5" /> Retry
                </Button>
              ) : null}
            </div>

            <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
              <Meta label="Event id" value={detail.data.eventId} />
              <Meta label="Ledger entry" value={detail.data.entryId} />
              <Meta label="Destination" value={detail.data.destination ?? "—"} />
              <Meta label="Signed with" value={`${detail.data.signature.header} (${detail.data.signature.scheme})`} />
              <Meta label="Payload SHA-256" value={detail.data.payload.sha256 ?? "not sent yet"} />
              <Meta label="Fields sent" value={detail.data.payload.fields.join(", ")} />
              <Meta label="Queue job" value={detail.data.jobId ?? "—"} />
              <Meta
                label="Attempts"
                value={`${detail.data.attempts} (up to ${detail.data.maxAttempts} per queueing${
                  detail.data.manualRetries ? `, retried by hand ${detail.data.manualRetries}×` : ""
                })`}
              />
            </dl>
            {detail.data.lastError ? (
              <p className="text-xs text-rose-600 dark:text-rose-400">{detail.data.lastError}</p>
            ) : null}

            {detail.data.attemptLog.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Attempted</TableHead>
                    <TableHead className="text-right">Answer</TableHead>
                    <TableHead className="text-right">Took</TableHead>
                    <TableHead>Reason</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.data.attemptLog.map((a) => (
                    <TableRow key={a.at}>
                      <TableCell className="num whitespace-nowrap text-xs">
                        {new Date(a.at).toLocaleString()}
                      </TableCell>
                      <TableCell className="num text-right text-xs">{a.responseCode ?? "—"}</TableCell>
                      <TableCell className="num text-right text-xs">{a.durationMs} ms</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {a.error ?? "Delivered"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-all font-mono">{value}</dd>
    </div>
  );
}

function Money({
  id,
  label,
  value,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      />
    </div>
  );
}

/**
 * Earning, redeeming or adjusting at the counter.
 *
 * An adjustment demands a reason before the button works, because a balance
 * that changed for no recorded reason cannot be defended to the customer who
 * asks about it six months later.
 */
function ManualMovement({
  phone,
  canAdjust,
  pending,
  onSubmit,
}: {
  phone: string;
  canAdjust: boolean;
  pending: boolean;
  onSubmit: (payload: {
    kind: "earn" | "redeem" | "adjustment";
    points?: number;
    amount?: number;
    reason?: string;
    reference?: string;
  }) => void;
}) {
  const [kind, setKind] = useState<"earn" | "redeem" | "adjustment">("earn");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");

  const needsReason = kind === "adjustment";
  const n = Number(value);
  const ready = Number.isFinite(n) && n !== 0 && (!needsReason || reason.trim().length > 0);

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-md border p-3">
      <div className="space-y-1">
        <Label htmlFor={`kind-${phone}`}>Movement</Label>
        <select
          id={`kind-${phone}`}
          className="h-9 rounded-md border bg-background px-3 text-sm"
          value={kind}
          onChange={(e) => setKind(e.target.value as typeof kind)}
        >
          <option value="earn">Earn on a bill</option>
          <option value="redeem">Redeem points</option>
          {canAdjust ? <option value="adjustment">Adjust by hand</option> : null}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`value-${phone}`}>
          {kind === "earn" ? "Bill amount (₹)" : "Points"}
        </Label>
        <Input
          id={`value-${phone}`}
          className="w-32"
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`ref-${phone}`}>Invoice</Label>
        <Input
          id={`ref-${phone}`}
          className="w-36"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
        />
      </div>
      <div className="min-w-[12rem] flex-1 space-y-1">
        <Label htmlFor={`reason-${phone}`}>
          Reason{needsReason ? " (required)" : ""}
        </Label>
        <Input
          id={`reason-${phone}`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <Button
        disabled={!ready || pending}
        onClick={() =>
          onSubmit({
            kind,
            ...(kind === "earn" ? { amount: n } : { points: Math.abs(Math.round(n)) }),
            ...(kind === "adjustment" ? { points: Math.round(n) } : {}),
            reason: reason.trim() || undefined,
            reference: reference.trim() || undefined,
          })
        }
      >
        {pending ? "Recording…" : "Record"}
      </Button>
    </div>
  );
}
