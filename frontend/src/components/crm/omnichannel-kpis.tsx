"use client";

import { useMemo, useState } from "react";
import {
  ChevronDown,
  Megaphone,
  MessageCircle,
  Store as StoreIcon,
  TrendingUp,
  Users,
} from "lucide-react";

import { useT } from "@/lib/i18n";
import { useOmnichannelSummary, type OmnichannelSummary } from "@/lib/queries/omnichannel";

/**
 * The omnichannel headline bar.
 *
 * Every figure is fetched from `/crm/omnichannel/summary`, which measures it in
 * the database. Nothing is computed from the list of leads below it: that list
 * is one page, and a total taken from a page is wrong as soon as there is a
 * second one.
 *
 * Where a number cannot be produced it says so. An intent chart with nothing
 * assessed is not a donut of zeroes — a chart of zeroes reads as "we looked and
 * everyone is cold", which is a different and much worse claim than "nobody has
 * scored these yet".
 *
 * The words are the tenant's. Intent bands come from their own qualification
 * policy, and "customer" / "enquiry" pass through `useT()`, so a clinic reads
 * its vocabulary and a mill reads its own.
 */

const WINDOWS = [
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "12 months" },
];

/** Distinct hues per band key, so the same band keeps its colour across screens. */
const BAND_TONE: Record<string, string> = {
  hot: "var(--chart-1, #16a34a)",
  warm: "var(--chart-2, #d97706)",
  cold: "var(--chart-3, #64748b)",
  negative: "var(--chart-4, #b91c1c)",
};
const FALLBACK_TONE = "var(--chart-5, #6366f1)";

export function OmnichannelKpis({ storeId }: { storeId?: string }) {
  const t = useT();
  const [days, setDays] = useState(90);
  const [open, setOpen] = useState(true);
  const summary = useOmnichannelSummary({ storeId, days });

  const data = summary.data;

  return (
    <section className="mb-6 rounded-lg border border-border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 text-sm font-medium"
          aria-expanded={open}
        >
          <ChevronDown
            className={`h-4 w-4 transition-transform ${open ? "" : "-rotate-90"}`}
            aria-hidden
          />
          Where your business came from
        </button>

        <div className="flex items-center gap-1" role="group" aria-label="Reporting window">
          {WINDOWS.map((w) => (
            <button
              key={w.days}
              type="button"
              onClick={() => setDays(w.days)}
              aria-pressed={days === w.days}
              className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                days === w.days
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:bg-muted/50"
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </header>

      {open ? (
        summary.isError ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            These figures could not be loaded. Nothing is missing from your data — only this
            summary failed to fetch.
          </p>
        ) : (
          <div className="space-y-5 p-4">
            <Totals data={data} loading={summary.isPending} t={t} />
            <div className="grid gap-4 lg:grid-cols-2">
              <Intent data={data} loading={summary.isPending} />
              <Channels data={data} loading={summary.isPending} />
            </div>
            <Funnel data={data} loading={summary.isPending} />
          </div>
        )
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ totals */

function Totals({
  data,
  loading,
  t,
}: {
  data?: OmnichannelSummary;
  loading: boolean;
  t: (key: string, fallback?: string) => string;
}) {
  const cards = [
    { key: "leads", label: t("lead_plural", "Leads"), value: data?.totals.leads, icon: TrendingUp },
    { key: "visits", label: "Visits", value: data?.totals.visits, icon: StoreIcon },
    { key: "enquiries", label: "Enquiries", value: data?.totals.enquiries, icon: MessageCircle },
    {
      key: "customers",
      label: t("customer_plural", "Customers"),
      value: data?.totals.customers,
      icon: Users,
    },
    {
      key: "paid",
      label: "Meta Ads",
      value: data?.channels.paidSocial,
      icon: Megaphone,
    },
    {
      key: "messaging",
      label: "WhatsApp",
      value: data?.channels.messaging,
      icon: MessageCircle,
    },
    {
      key: "withVisits",
      label: "Leads who came in",
      value: data?.totals.newLeadsWithVisits,
      icon: StoreIcon,
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-7">
      {cards.map((c) => (
        <div key={c.key} className="rounded-md border border-border p-3">
          <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <c.icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="truncate">{c.label}</span>
          </div>
          <div className="font-[family-name:var(--font-display-face)] text-2xl tabular-nums">
            {loading ? <span className="text-muted-foreground">—</span> : formatCount(c.value)}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ intent */

function Intent({ data, loading }: { data?: OmnichannelSummary; loading: boolean }) {
  const bands = data?.intent ?? null;
  const total = bands?.reduce((n, b) => n + b.count, 0) ?? 0;

  const arcs = useMemo(() => {
    if (!bands || !total) return [];
    // One circle, one stroke per band, offset by everything before it. A donut
    // drawn this way needs no charting library and no client-side maths beyond
    // a running total.
    let offset = 0;
    return bands
      .filter((b) => b.count > 0)
      .map((b) => {
        const fraction = b.count / total;
        const arc = { ...b, fraction, offset, tone: BAND_TONE[b.key] ?? FALLBACK_TONE };
        offset += fraction;
        return arc;
      });
  }, [bands, total]);

  return (
    <div className="rounded-md border border-border p-4">
      <h3 className="mb-3 text-sm font-medium">How warm they are</h3>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : !bands ? (
        <p className="text-sm text-muted-foreground">
          Nothing has been scored yet, so there is no breakdown to show. This fills in once
          qualification has run over your conversations.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-5">
          <svg viewBox="0 0 42 42" className="h-28 w-28 shrink-0" role="img"
            aria-label={`Intent breakdown across ${total} assessments`}>
            <circle cx="21" cy="21" r="15.9155" fill="none" stroke="var(--border)" strokeWidth="5" />
            {arcs.map((a) => (
              <circle
                key={a.key}
                cx="21"
                cy="21"
                r="15.9155"
                fill="none"
                stroke={a.tone}
                strokeWidth="5"
                strokeDasharray={`${a.fraction * 100} ${100 - a.fraction * 100}`}
                strokeDashoffset={`${25 - a.offset * 100}`}
              />
            ))}
            <text
              x="21"
              y="22.5"
              textAnchor="middle"
              className="fill-foreground text-[6px] tabular-nums"
            >
              {total}
            </text>
          </svg>

          <ul className="min-w-0 flex-1 space-y-1.5 text-sm">
            {bands.map((b) => (
              <li key={b.key} className="flex items-center gap-2">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ background: BAND_TONE[b.key] ?? FALLBACK_TONE }}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate">{b.label}</span>
                <span className="tabular-nums text-muted-foreground">{b.count}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- channels */

function Channels({ data, loading }: { data?: OmnichannelSummary; loading: boolean }) {
  const rows = data?.bySource ?? [];
  const max = rows.reduce((n, r) => Math.max(n, r.count), 0);

  return (
    <div className="rounded-md border border-border p-4">
      <h3 className="mb-3 text-sm font-medium">Which channel brought them</h3>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : !rows.length ? (
        <p className="text-sm text-muted-foreground">
          No leads in this period, so there is nothing to break down.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.source} className="flex items-center gap-3 text-sm">
              <span className="w-24 shrink-0 truncate text-muted-foreground">{r.label}</span>
              <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                <span
                  className="block h-full rounded-full bg-foreground/70"
                  style={{ width: max ? `${Math.max((r.count / max) * 100, 2)}%` : "0%" }}
                />
              </span>
              <span className="w-10 shrink-0 text-right tabular-nums">{r.count}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ funnel */

function Funnel({ data, loading }: { data?: OmnichannelSummary; loading: boolean }) {
  const stages = data?.funnel ?? [];
  const widest = stages.reduce((n, s) => Math.max(n, s.count ?? 0), 0);

  return (
    <div className="rounded-md border border-border p-4">
      <h3 className="mb-3 text-sm font-medium">How far they got</h3>
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <ol className="grid gap-2 sm:grid-cols-5">
          {stages.map((s) => (
            <li key={s.key} className="rounded-md border border-border px-3 py-2">
              <div className="text-xs text-muted-foreground">{s.label}</div>
              <div className="font-[family-name:var(--font-display-face)] text-xl tabular-nums">
                {s.count === null ? (
                  <span className="text-muted-foreground" title="Not recorded for this account">
                    —
                  </span>
                ) : (
                  s.count.toLocaleString()
                )}
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
                <span
                  className="block h-full rounded-full bg-foreground/60"
                  style={{
                    width: widest && s.count ? `${Math.max((s.count / widest) * 100, 2)}%` : "0%",
                  }}
                />
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** An unknown count is a dash, never a zero. */
function formatCount(value: number | null | undefined) {
  if (value === null || value === undefined) return <span className="text-muted-foreground">—</span>;
  return value.toLocaleString();
}
