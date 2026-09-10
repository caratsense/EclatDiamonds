"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { QRCodeSVG } from "qrcode.react";
import {
  Camera,
  Check,
  ChevronRight,
  ClipboardList,
  Copy,
  ExternalLink,
  FileText,
  Link2,
  MapPin,
  Phone,
  QrCode,
  RefreshCw,
  Users,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { AuthedImage } from "@/components/ui/authed-image";
import {
  useFloorDay,
  useFloorForms,
  useFloorVisits,
  type FloorForm,
  type FloorVisit,
} from "@/lib/queries/instore-floor";
import {
  useCallingQueue,
  useCallingSummary,
  type CallingBucket,
  type QueueTask,
} from "@/lib/queries/calling";
import { useUpdateTaskStatus } from "@/lib/queries/dashboard";
import { apiErrorMessage } from "@/lib/utils";

/**
 * The floor app's Visits, Today, Tasks and Forms tabs.
 *
 * These four were placeholder cards with a button pointing at a desktop screen
 * — and in the Forms tab's case, at a screen a salesperson is locked out of, so
 * the button led to a refusal. They are now the workflows themselves, against
 * store-scoped server aggregates.
 *
 * Everything here is written for a phone held in one hand with a customer
 * waiting: one column, large touch targets, no nested dialogs, and no figure
 * counted in the browser from a page of rows.
 */

/* ================================================================= shared */

function Panel({
  title,
  count,
  onRefresh,
  refreshing,
  children,
}: {
  title: string;
  count?: string;
  onRefresh: () => void;
  refreshing: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-[family-name:var(--font-display-face)] text-lg">{title}</h2>
        <div className="flex items-center gap-1">
          {count ? (
            <span className="text-sm tabular-nums text-muted-foreground">{count}</span>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label={`Refresh ${title.toLowerCase()}`}
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>
      {children}
    </div>
  );
}

function Loading({ rows = 2 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-28 w-full" />
      ))}
    </div>
  );
}

function Failed({ error, what }: { error: unknown; what: string }) {
  return (
    <Card>
      <CardContent className="py-8 text-center text-sm text-muted-foreground">
        {apiErrorMessage(error, `Could not load ${what}.`)}
      </CardContent>
    </Card>
  );
}

/* ================================================================= visits */

const VISIT_TONE: Record<FloorVisit["status"], "success" | "destructive" | "secondary"> = {
  converted: "success",
  walked_out: "destructive",
  open: "secondary",
};
const VISIT_WORD: Record<FloorVisit["status"], string> = {
  converted: "Converted",
  walked_out: "Walked out",
  open: "Open",
};

/** Turn a tenant's own field key into something readable without renaming it. */
function humanise(key: string): string {
  const spaced = key.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Only the tenant fields that are actually printable. An object is not a value. */
function printableFields(fields: Record<string, unknown> | null): [string, string][] {
  if (!fields) return [];
  return Object.entries(fields)
    .filter(([, v]) => typeof v === "string" || typeof v === "number")
    .map(([k, v]) => [humanise(k), String(v)] as [string, string])
    .filter(([, v]) => v.trim().length > 0);
}

function VisitCard({ visit }: { visit: FloorVisit }) {
  const [showPhoto, setShowPhoto] = useState(false);
  const fields = printableFields(visit.fields);

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-medium">{visit.customerName}</p>
            <p className="font-[family-name:var(--font-mono-face)] text-xs text-muted-foreground">
              {visit.timeInLocal ?? "—"}
              {visit.timeOutLocal ? ` – ${visit.timeOutLocal}` : " · still in"}
              {visit.customerId ? ` · ${visit.customerId}` : ""}
            </p>
          </div>
          <Badge variant={VISIT_TONE[visit.status]} className="shrink-0 text-[10px]">
            {VISIT_WORD[visit.status]}
          </Badge>
        </div>

        {visit.attendedBy || visit.purpose ? (
          <div className="flex flex-wrap gap-1.5">
            {visit.purpose ? (
              <Badge variant="outline" className="text-[10px]">
                {humanise(visit.purpose)}
              </Badge>
            ) : null}
            {visit.attendedBy ? (
              <Badge variant="outline" className="text-[10px]">
                {visit.attendedBy.name}
              </Badge>
            ) : null}
          </div>
        ) : null}

        {fields.length ? (
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            {fields.map(([k, v]) => (
              <div key={k} className="min-w-0">
                <dt className="truncate text-muted-foreground">{k}</dt>
                <dd className="truncate">{v}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        {visit.enquiries.length ? (
          <ul className="space-y-1.5 border-t border-border pt-2.5">
            {visit.enquiries.map((e) => (
              <li key={e.id} className="flex items-start gap-2 text-xs">
                {e.converted ? (
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden />
                ) : (
                  <span
                    className="mt-1 h-2 w-2 shrink-0 rounded-full border border-border"
                    aria-hidden
                  />
                )}
                <span className="min-w-0 flex-1">
                  <span className="break-words">{e.name ?? "Item"}</span>
                  {e.quantity && e.quantity > 1 ? (
                    <span className="text-muted-foreground"> × {e.quantity}</span>
                  ) : null}
                  {e.dropOffReason ? (
                    <span className="block text-muted-foreground">{e.dropOffReason}</span>
                  ) : null}
                </span>
                {e.category ? (
                  <span className="shrink-0 text-[10px] text-muted-foreground">{e.category}</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        {visit.notes ? (
          <p className="border-t border-border pt-2.5 text-xs text-muted-foreground">
            {visit.notes}
          </p>
        ) : null}

        <div className="flex gap-2">
          {visit.photoUrl ? (
            <Button
              size="sm"
              variant="outline"
              className="flex-1"
              onClick={() => setShowPhoto((v) => !v)}
              aria-expanded={showPhoto}
            >
              <Camera className="mr-1.5 h-3.5 w-3.5" />
              {showPhoto ? "Hide photo" : "Photo"}
            </Button>
          ) : null}
          {visit.partyId ? (
            <Button size="sm" variant="outline" className="flex-1" asChild>
              <Link href={`/customers/${visit.partyId}`}>
                Customer
                <ChevronRight className="ml-1 h-3.5 w-3.5" />
              </Link>
            </Button>
          ) : null}
        </div>

        {showPhoto && visit.photoUrl ? (
          <AuthedImage
            src={visit.photoUrl}
            alt={`Photo taken when ${visit.customerName} visited`}
            className="aspect-[4/3] w-full rounded-md object-cover"
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

export function VisitsTab({ storeId }: { storeId?: string }) {
  const visits = useFloorVisits({ storeId });

  return (
    <Panel
      title="Today’s visits"
      count={visits.data ? String(visits.data.items.length) : undefined}
      onRefresh={() => void visits.refetch()}
      refreshing={visits.isFetching}
    >
      {visits.isLoading ? (
        <Loading />
      ) : visits.isError ? (
        <Failed error={visits.error} what="today’s visits" />
      ) : !visits.data?.items.length ? (
        <EmptyState
          icon={MapPin}
          title="Nobody has been recorded today"
          description="Visits you record from the Leads tab appear here, with what each customer asked about."
        />
      ) : (
        <div className="space-y-3">
          {visits.data.items.map((v) => (
            <VisitCard key={v.id} visit={v} />
          ))}
          {visits.data.nextCursor ? (
            <p className="pb-2 text-center text-xs text-muted-foreground">
              Showing the first {visits.data.items.length}. Older visits are on the check-ins
              report.
            </p>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

/* ================================================================== today */

function Tile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "warn";
}) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="truncate text-xs text-muted-foreground" title={hint ?? label}>
        {label}
      </div>
      <div
        className={`font-[family-name:var(--font-display-face)] text-2xl tabular-nums ${
          tone === "warn" ? "text-destructive" : ""
        }`}
      >
        {value}
      </div>
    </div>
  );
}

export function DayTab({ storeId }: { storeId?: string }) {
  const day = useFloorDay({ storeId });
  const d = day.data;

  /** An unknown figure is a dash, never a zero. */
  const n = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString());

  return (
    <Panel
      title="Today"
      onRefresh={() => void day.refetch()}
      refreshing={day.isFetching}
    >
      {day.isLoading ? (
        <Loading rows={1} />
      ) : day.isError ? (
        <Failed error={day.error} what="today’s figures" />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <Tile label="Footfall" value={n(d?.footfall)} hint="Visits recorded today" />
            <Tile label="Converted" value={n(d?.converted)} hint="Visits that closed a sale" />
            <Tile
              label="Walked out"
              value={n(d?.walkOuts)}
              hint="Visits closed without a sale"
              tone={d?.walkOuts ? "warn" : undefined}
            />
            <Tile
              label="Drop-off"
              // Null when nobody came in. There is no rate of nothing, and 0%
              // would read as "nobody walked out".
              value={d?.dropOffRate == null ? "—" : `${d.dropOffRate}%`}
              hint="Share of today’s visits that walked out"
            />
            <Tile label="Still in" value={n(d?.stillIn)} hint="Visits with no close recorded" />
            <Tile label="My visits" value={n(d?.myVisits)} hint="Visits you attended today" />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Tile
              label="Open enquiries"
              value={n(d?.openEnquiries)}
              hint="Every enquiry still open at this branch, not only today's"
            />
            <Tile label="New enquiries" value={n(d?.newLeads)} hint="Enquiries opened today" />
          </div>

          <div className="rounded-md border border-border p-4">
            <h3 className="mb-2 text-sm font-medium">What people asked about</h3>
            {/*
              Null means nothing was logged. An empty chart in its place would
              read as "nobody was interested in anything", which is a different
              and much worse claim.
            */}
            {!d?.topCategories ? (
              <p className="text-sm text-muted-foreground">
                Nothing has been logged against an item today. Scan or pick items when you record
                a visit and this fills in.
              </p>
            ) : (
              <ul className="space-y-2">
                {d.topCategories.map((c) => {
                  const max = d.topCategories?.[0]?.count ?? 1;
                  return (
                    <li key={c.name} className="flex items-center gap-3 text-sm">
                      <span className="w-24 shrink-0 truncate text-muted-foreground">{c.name}</span>
                      <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                        <span
                          className="block h-full rounded-full bg-foreground/70"
                          style={{ width: `${Math.max((c.count / max) * 100, 4)}%` }}
                        />
                      </span>
                      <span className="w-8 shrink-0 text-right tabular-nums">{c.count}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <p className="text-center text-[11px] text-muted-foreground">
            {d ? `${d.date} · ${d.timezone}` : null}
          </p>
        </div>
      )}
    </Panel>
  );
}

/* ================================================================== tasks */

const BUCKETS: { value: CallingBucket; label: string }[] = [
  { value: "overdue", label: "Overdue" },
  { value: "today", label: "Today" },
  { value: "upcoming", label: "Upcoming" },
  { value: "completed", label: "Done" },
];

function TaskCard({ task }: { task: QueueTask }) {
  const complete = useUpdateTaskStatus();
  const late = task.overdueDays !== null && task.overdueDays > 0 ? task.overdueDays : null;

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-medium">{task.customer?.name ?? task.title}</p>
            <p className="line-clamp-2 text-xs text-muted-foreground">{task.title}</p>
          </div>
          {late ? (
            <Badge variant="destructive" className="shrink-0 text-[10px]">
              {late === 1 ? "1 day late" : `${late} days late`}
            </Badge>
          ) : null}
        </div>

        {task.customer?.contact ? (
          <p className="font-[family-name:var(--font-mono-face)] text-xs text-muted-foreground">
            {task.customer.contact}
            {!task.customer.canDial ? " · number withheld" : ""}
          </p>
        ) : null}

        <div className="flex gap-2">
          {/*
            A phone button only when there is a number to dial. `contact` comes
            back masked as ••••1122 for anyone who is neither a manager nor this
            task's owner, and a `tel:` built on that looks like a working link
            and dials nothing.
          */}
          {task.customer?.canDial && task.customer.contact ? (
            <Button size="sm" className="flex-1" asChild>
              <a href={`tel:${task.customer.contact}`}>
                <Phone className="mr-1.5 h-3.5 w-3.5" />
                Call
              </a>
            </Button>
          ) : null}
          {task.customer ? (
            <Button size="sm" variant="outline" className="flex-1" asChild>
              <Link href={`/conversations?partyId=${task.customer.id}`}>Open</Link>
            </Button>
          ) : null}
          {task.status !== "done" ? (
            <Button
              size="sm"
              variant="outline"
              className="flex-1"
              disabled={complete.isPending}
              onClick={() =>
                complete.mutate(
                  { id: task.id, status: "done" },
                  {
                    onSuccess: () => toast.success("Marked done."),
                    onError: (e) => toast.error(apiErrorMessage(e, "Could not mark it done.")),
                  },
                )
              }
            >
              <Check className="mr-1.5 h-3.5 w-3.5" />
              Done
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

export function TasksTab({ storeId }: { storeId?: string }) {
  const [bucket, setBucket] = useState<CallingBucket>("today");
  // `mine`, because this is the person's own queue on their own phone. It
  // resolves to the caller server-side; there is no id to pass.
  const summary = useCallingSummary({ mine: true, storeId });
  const queue = useCallingQueue({ bucket, mine: true, storeId });

  const counts: Record<CallingBucket, number | undefined> = {
    overdue: summary.data?.overdue,
    today: summary.data?.dueToday,
    upcoming: summary.data?.upcoming,
    completed: summary.data?.completed,
  };

  return (
    <Panel
      title="My follow-ups"
      onRefresh={() => {
        void summary.refetch();
        void queue.refetch();
      }}
      refreshing={summary.isFetching || queue.isFetching}
    >
      {/* Counts come from their own aggregates, never from the page below. */}
      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {BUCKETS.map((b) => (
          <button
            key={b.value}
            type="button"
            onClick={() => setBucket(b.value)}
            aria-pressed={bucket === b.value}
            className={`shrink-0 rounded-full border px-3 py-1.5 text-xs transition-colors ${
              bucket === b.value
                ? "border-foreground bg-foreground text-background"
                : "border-border text-muted-foreground"
            }`}
          >
            {b.label}
            <span className="ml-1.5 tabular-nums">
              {counts[b.value] === undefined ? "—" : counts[b.value]}
            </span>
          </button>
        ))}
      </div>

      {queue.isLoading ? (
        <Loading />
      ) : queue.isError ? (
        <Failed error={queue.error} what="your follow-ups" />
      ) : !queue.data?.items.length ? (
        <EmptyState
          icon={ClipboardList}
          title={bucket === "overdue" ? "Nothing overdue" : "Nothing here"}
          description={
            bucket === "completed"
              ? `Follow-ups you closed in the last ${summary.data?.completedWithinDays ?? 30} days appear here.`
              : "Follow-ups assigned to you appear here."
          }
        />
      ) : (
        <div className="space-y-3">
          {queue.data.items.map((t) => (
            <TaskCard key={t.id} task={t} />
          ))}
          {queue.data.nextCursor ? (
            <p className="pb-2 text-center text-xs text-muted-foreground">
              Showing the first {queue.data.items.length}. Open Tasks on a larger screen for the
              rest.
            </p>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

/* ================================================================== forms */

function FormCard({ form }: { form: FloorForm }) {
  const [showQr, setShowQr] = useState(false);

  // Built in the browser, because the public origin is the browser's own — a
  // server that guessed it would print a link to the wrong host on every
  // preview deployment.
  const url = useMemo(() => {
    if (typeof window === "undefined") return form.submitPath;
    return `${window.location.origin}${form.submitPath}`;
  }, [form.submitPath]);

  async function share() {
    // The platform sheet where there is one — that is how a link actually gets
    // to a customer from a phone. Clipboard is the fallback, not the goal.
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({ title: form.name, url });
        return;
      } catch {
        // Cancelled, or refused. Fall through to the clipboard.
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied.");
    } catch {
      toast.error("Could not copy the link. Long-press it to copy by hand.");
    }
  }

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-medium">{form.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {form.store?.name ?? "This branch"}
              {form.campaign ? ` · ${form.campaign}` : ""}
            </p>
          </div>
          {!form.enabled ? (
            <Badge variant="outline" className="shrink-0 text-[10px]">
              Turned off
            </Badge>
          ) : null}
        </div>

        <p className="text-xs text-muted-foreground">
          {form.submissions.total === 0
            ? "No enquiries through this form yet."
            : form.submissions.total === 1
              ? "1 enquiry through this form."
              : `${form.submissions.total.toLocaleString()} enquiries through this form.`}
          {form.submissions.latest ? (
            <>
              {" "}
              Last: {form.submissions.latest.customerName},{" "}
              {new Date(form.submissions.latest.createdAt).toLocaleDateString()}.
            </>
          ) : null}
        </p>

        {!form.enabled ? (
          <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
            This form is switched off, so the link will refuse anything sent to it. A manager can
            turn it back on.
          </p>
        ) : (
          <>
            <div className="flex gap-2">
              <Button size="sm" className="flex-1" onClick={() => void share()}>
                <Link2 className="mr-1.5 h-3.5 w-3.5" />
                Share link
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="flex-1"
                onClick={() => setShowQr((v) => !v)}
                aria-expanded={showQr}
              >
                <QrCode className="mr-1.5 h-3.5 w-3.5" />
                {showQr ? "Hide code" : "Show code"}
              </Button>
            </div>

            {showQr ? (
              <div className="flex flex-col items-center gap-2 rounded-md border border-border bg-white p-4">
                <QRCodeSVG value={url} size={168} marginSize={2} />
                <p className="break-all text-center text-[10px] text-neutral-600">{url}</p>
              </div>
            ) : null}

            <div className="flex gap-2">
              <Button size="sm" variant="ghost" className="flex-1" asChild>
                <a href={form.submitPath} target="_blank" rel="noreferrer">
                  <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                  Preview
                </a>
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="flex-1"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(url)
                    .then(() => toast.success("Link copied."))
                    .catch(() => toast.error("Could not copy the link."));
                }}
              >
                <Copy className="mr-1.5 h-3.5 w-3.5" />
                Copy
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function FormsTab({ storeId }: { storeId?: string }) {
  const forms = useFloorForms({ storeId });

  return (
    <Panel
      title="Enquiry forms"
      count={forms.data ? String(forms.data.length) : undefined}
      onRefresh={() => void forms.refetch()}
      refreshing={forms.isFetching}
    >
      {forms.isLoading ? (
        <Loading />
      ) : forms.isError ? (
        <Failed error={forms.error} what="the enquiry forms" />
      ) : !forms.data?.length ? (
        <EmptyState
          icon={FileText}
          title="No forms for this branch"
          description="A manager publishes enquiry forms from the Enquiry Forms screen. Once one exists for this branch, its link and code appear here."
        />
      ) : (
        <div className="space-y-3">
          {forms.data.map((f) => (
            <FormCard key={f.id} form={f} />
          ))}
          <p className="pb-2 text-center text-xs text-muted-foreground">
            <Users className="mr-1 inline h-3 w-3" />
            Anyone with a link can send an enquiry to this branch. Share it, do not post it.
          </p>
        </div>
      )}
    </Panel>
  );
}
