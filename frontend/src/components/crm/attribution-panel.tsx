"use client";

import { CircleHelp, Megaphone, MousePointerClick, UserRound } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { usePartyAttribution } from "@/lib/queries/crm-ai";
import { formatINR } from "@/lib/format";

/**
 * Where one customer came from.
 *
 * The evidence badge is the point of this component, not decoration. "Instagram"
 * shown identically whether it came from a tracked click or from a salesperson's
 * dropdown is how a marketing budget gets moved on somebody's recollection. So a
 * declared touch is labelled declared, every time, and the two are never added
 * into one number.
 */
export function AttributionPanel({ partyId }: { partyId: string }) {
  const { data, isLoading } = usePartyAttribution(partyId);

  if (isLoading) return <Skeleton className="h-40 w-full" />;

  if (!data || data.status === "unattributed") {
    return (
      <EmptyState
        icon={CircleHelp}
        title="Where this customer came from is not known"
        description={
          data?.reason ??
          "Nothing has been recorded. Capturing a source on the lead form, or connecting an advertising account, will start filling this in."
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <TouchCard label="First touch" touch={data.firstTouch} icon={MousePointerClick} />
        <TouchCard label="Last touch" touch={data.lastTouch} icon={UserRound} />
      </div>

      {data.revenue ? (
        <div className="rounded-lg border px-3 py-2">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Credited revenue
          </p>
          <p className="num text-lg font-semibold">{formatINR(Number(data.revenue.total))}</p>
          <p className="text-xs text-muted-foreground">
            {data.revenue.sales} sale{data.revenue.sales === 1 ? "" : "s"} · {data.revenue.note}
          </p>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Every recorded touch
        </p>
        {data.touches.map((t) => (
          <div
            key={t.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-xs"
          >
            <span className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{t.channel}</Badge>
              <span className="font-medium">{t.campaign?.name ?? t.source ?? "unknown source"}</span>
              <EvidenceBadge evidence={t.evidence} />
              {t.position === "first_touch" ? (
                <Badge variant="secondary" className="text-[10px]">
                  first
                </Badge>
              ) : null}
            </span>
            <span className="text-muted-foreground">
              {new Date(t.occurredAt).toLocaleDateString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TouchCard({
  label,
  touch,
  icon: Icon,
}: {
  label: string;
  touch: { channel: string; source: string | null; campaign: { name: string } | null; evidence: string; occurredAt: string } | null;
  icon: typeof Megaphone;
}) {
  return (
    <div className="rounded-lg border px-3 py-2">
      <p className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </p>
      {touch ? (
        <>
          <p className="font-medium">{touch.campaign?.name ?? touch.source ?? touch.channel}</p>
          <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            <EvidenceBadge evidence={touch.evidence} />
            {new Date(touch.occurredAt).toLocaleDateString()}
          </p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Not known</p>
      )}
    </div>
  );
}

/**
 * How this is known. Rendered on every touch without exception — an unlabelled
 * source is one that will eventually be read as measured.
 */
export function EvidenceBadge({ evidence }: { evidence: string }) {
  const copy: Record<string, { label: string; className: string; title: string }> = {
    measured: {
      label: "measured",
      className: "border-emerald-500/50 text-emerald-600",
      title: "Carried in by a tracked click or link.",
    },
    declared: {
      label: "declared",
      className: "border-amber-500/50 text-amber-600",
      title: "Someone chose this by hand. It has not been verified.",
    },
    inferred: {
      label: "inferred",
      className: "border-sky-500/50 text-sky-600",
      title: "A rule matched. Not the same as a tracked click.",
    },
  };
  const meta = copy[evidence] ?? {
    label: evidence,
    className: "text-muted-foreground",
    title: "",
  };
  return (
    <Badge variant="outline" className={`h-4 px-1.5 text-[10px] font-normal ${meta.className}`} title={meta.title}>
      {meta.label}
    </Badge>
  );
}
