"use client";

import { createElement, use, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  BellRing,
  CalendarDays,
  DoorOpen,
  FileText,
  Gem,
  MessageSquare,
  Phone,
  Receipt,
  RotateCcw,
  ShoppingBag,
  Sparkles,
  Store as StoreIcon,
  Ticket,
  UserRound,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCustomer360, type TimelineEvent } from "@/lib/queries/crm";
import {
  useConfigBootstrap,
  useRecordProvenance,
  useTermLabel,
} from "@/lib/queries/tenant-config";
import { AttributionPanel } from "@/components/crm/attribution-panel";
import { QualificationPanel } from "@/components/crm/qualification-panel";
import { formatINR } from "@/lib/format";

/**
 * Customer 360 (CaratOS Phase A3/A11).
 *
 * One person, everything known about them, assembled from the modules that own
 * each part. Two things this screen is deliberately honest about:
 *
 *   1. SCOPE. A salesperson's totals cover only their own stores, and the page
 *      says so in words rather than showing a smaller number than head office
 *      sees with no explanation.
 *   2. ATTRIBUTION. Shown as "not tracked" rather than defaulted to organic. A
 *      fabricated attribution is worse than a blank one — budget gets spent
 *      against it.
 *
 * Industry-neutral: every vocabulary label (visit purpose, lead source) resolves
 * through the tenant's configuration, so a pharmacy sees its own words here
 * without this file knowing anything about pharmacies.
 */

const TIMELINE_ICONS: Record<string, typeof UserRound> = {
  "lead.created": Sparkles,
  "visit.recorded": StoreIcon,
  "sale.completed": ShoppingBag,
  "payment.recorded": Receipt,
  "message.received": MessageSquare,
  "message.queued": MessageSquare,
  "conversation.handoff": Ticket,
  "quote.created": FileText,
  "return.created": RotateCcw,
};

function timelineIcon(type: string) {
  if (TIMELINE_ICONS[type]) return TIMELINE_ICONS[type];
  if (type.startsWith("product.")) return Gem;
  return CalendarDays;
}

export default function Customer360Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { data, isLoading, isError, error } = useCustomer360(id);
  // Where this record came from — a real answer either way ("Entered in
  // CaratOS" is not a blank), and the first thing support asks about.
  const { data: provenance } = useRecordProvenance("party", id);
  const { data: config } = useConfigBootstrap();
  const label = useTermLabel(config);
  const [tab, setTab] = useState("timeline");
  const [timelineFilter, setTimelineFilter] = useState<"all" | "whatsapp" | "sales" | "visits">("all");

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="space-y-4">
        <Link
          href="/customers"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          All customers
        </Link>
        <p className="py-12 text-center text-sm text-muted-foreground">
          {error instanceof Error ? error.message : "Could not load customer"}
        </p>
      </div>
    );
  }

  const { customer, summary, identity } = data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <Link
            href="/customers"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            All customers
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">{customer.name}</h1>
          <p className="text-sm text-muted-foreground">
            {[customer.phone, customer.email, customer.city].filter(Boolean).join(" · ") ||
              "No contact details on file"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {Number(summary.totalSpend) > 50000 || summary.saleCount >= 1 ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2.5 py-1 text-xs font-semibold text-amber-700 dark:text-amber-300 border border-amber-500/30">
              👑 VIP High Value
            </span>
          ) : null}
          {summary.leadCount >= 1 || summary.visitCount >= 1 ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-purple-500/15 px-2.5 py-1 text-xs font-semibold text-purple-700 dark:text-purple-300 border border-purple-500/30">
              💍 Solitaire Prospect
            </span>
          ) : null}
          {customer.isBlacklisted && <Badge variant="destructive">Blacklisted</Badge>}
          {identity.openMergeReviews > 0 && (
            <Badge variant="outline" className="gap-1 border-amber-500 text-amber-600">
              <AlertTriangle className="h-3 w-3" />
              {identity.openMergeReviews} merge review
              {identity.openMergeReviews === 1 ? "" : "s"}
            </Badge>
          )}

          {customer.phone && (
            <div className="flex items-center gap-1.5 ml-2">
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 border-emerald-500/30 text-emerald-600 hover:bg-emerald-500/10"
                onClick={() => {
                  const dialable = customer.phone?.replace(/[^0-9]/g, "");
                  if (dialable) {
                    window.open(
                      `https://wa.me/${dialable}?text=${encodeURIComponent(`Hello ${customer.name}, following up from Éclat Diamonds.`)}`,
                      "_blank",
                    );
                  }
                }}
              >
                <MessageSquare className="h-3.5 w-3.5 fill-emerald-600/20" />
                WhatsApp
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5"
                asChild
              >
                <a href={`tel:${customer.phone.replace(/[^0-9]/g, "")}`}>
                  <Phone className="h-3.5 w-3.5" />
                  Call
                </a>
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Summary. `scopeNote` is rendered verbatim: two users legitimately see
          different totals here, and the number alone would look like a bug. */}
      <Card>
        <CardContent className="grid gap-4 pt-6 sm:grid-cols-2 lg:grid-cols-5">
          <Stat label="Lifetime spend" value={formatINR(Number(summary.totalSpend))} />
          <Stat label="Received" value={formatINR(Number(summary.totalPaid))} />
          <Stat label="Purchases" value={String(summary.saleCount)} />
          <Stat label="Visits" value={String(summary.visitCount)} />
          <Stat label="Leads" value={String(summary.leadCount)} />
          <p className="col-span-full text-xs text-muted-foreground">{summary.scopeNote}</p>
        </CardContent>
      </Card>

      {/* Outstanding follow-ups sit above the tabs, not inside them: they are the
          only part of this screen that is someone's job today. */}
      {data.followUps.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <BellRing className="h-4 w-4 text-[var(--gold)]" />
              {data.followUps.length} follow-up
              {data.followUps.length === 1 ? "" : "s"} still open
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.followUps.map((f) => {
              const overdue = new Date(f.dueDate) < new Date(new Date().toDateString());
              return (
                <div
                  key={f.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
                >
                  <span className="text-sm">
                    {f.note ?? `Follow-up ${f.seq}`}
                    {f.lead ? (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {f.lead.ref}
                        {f.lead.interest ? ` · ${f.lead.interest}` : ""}
                      </span>
                    ) : null}
                  </span>
                  <Badge variant={overdue ? "destructive" : "outline"}>
                    {overdue ? "Overdue " : "Due "}
                    {new Date(f.dueDate).toLocaleDateString()}
                  </Badge>
                </div>
              );
            })}
            <p className="pt-1 text-xs text-muted-foreground">
              Mark these done from Reminders — this view does not duplicate that action.
            </p>
          </CardContent>
        </Card>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="identity">Identity</TabsTrigger>
          <TabsTrigger value="leads">Leads</TabsTrigger>
          <TabsTrigger value="visits">Visits</TabsTrigger>
          <TabsTrigger value="products">Products</TabsTrigger>
          <TabsTrigger value="purchases">Purchases</TabsTrigger>
          <TabsTrigger value="conversations">Conversations</TabsTrigger>
          <TabsTrigger value="qualification">Qualification</TabsTrigger>
          <TabsTrigger value="attribution">Attribution</TabsTrigger>
        </TabsList>

        <TabsContent value="timeline" className="mt-4">
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-4">
              <div>
                <CardTitle className="text-base">Omnichannel Journey & History</CardTitle>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Showing {timelineFilter === "all" ? "all events" : timelineFilter} across WhatsApp, calls, showroom visits, and sales.
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                {(
                  [
                    { id: "all", label: "All Activity" },
                    { id: "whatsapp", label: "💬 WhatsApp" },
                    { id: "sales", label: "🛍️ Sales & Quotes" },
                    { id: "visits", label: "🏬 Visits & Calls" },
                  ] as const
                ).map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setTimelineFilter(f.id)}
                    className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                      timelineFilter === f.id
                        ? "bg-primary text-primary-foreground font-semibold shadow-xs"
                        : "bg-muted/70 text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </CardHeader>
            <CardContent>
              {(() => {
                const events = data.timeline.filter((e) => {
                  if (timelineFilter === "all") return true;
                  if (timelineFilter === "whatsapp")
                    return e.type.startsWith("message.") || e.type.includes("conversation");
                  if (timelineFilter === "sales")
                    return (
                      e.type.startsWith("sale.") ||
                      e.type.startsWith("quote.") ||
                      e.type.startsWith("payment.") ||
                      e.type.startsWith("return.")
                    );
                  if (timelineFilter === "visits")
                    return (
                      e.type.startsWith("visit.") ||
                      e.type.startsWith("lead.") ||
                      e.type.startsWith("call.")
                    );
                  return true;
                });
                return events.length === 0 ? (
                  <EmptyState
                    icon={CalendarDays}
                    title="No events in this view"
                    description={`No ${timelineFilter === "all" ? "activity" : timelineFilter} records found for this customer.`}
                  />
                ) : (
                  <ol className="space-y-4">
                    {events.map((e) => (
                      <TimelineRow key={e.id} event={e} />
                    ))}
                  </ol>
                );
              })()}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="identity" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">How we reach this customer</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {provenance ? (
                <p className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  {provenance.description}
                </p>
              ) : null}
              {identity.contactPoints.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No verified contact details yet. Head office can build these from existing
                  customer records in Settings → Configuration.
                </p>
              ) : (
                identity.contactPoints.map((cp) => (
                  <div
                    key={cp.id}
                    className="flex items-center justify-between rounded-md border px-3 py-2"
                  >
                    <div className="flex items-center gap-2">
                      <Phone className="h-4 w-4 text-muted-foreground" />
                      <span className="font-medium">{cp.value}</span>
                      <Badge variant="secondary">{cp.kind}</Badge>
                      {cp.isPrimary && <Badge variant="outline">Primary</Badge>}
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {cp.source ? `via ${cp.source}` : ""}
                    </span>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="leads" className="mt-4">
          <Card>
            <CardContent className="pt-6">
              {data.leads.length === 0 ? (
                <p className="text-sm text-muted-foreground">No leads for this customer.</p>
              ) : (
                <div className="space-y-2">
                  {data.leads.map((l) => (
                    <div
                      key={l.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
                    >
                      <div>
                        <span className="font-medium">{l.ref}</span>
                        <span className="ml-2 text-sm text-muted-foreground">
                          {l.interest ?? "No stated interest"}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        {/* Labels come from the tenant's own vocabulary. */}
                        <Badge variant="secondary">{label("lead_source", l.source)}</Badge>
                        <Badge>{l.stage.replace(/_/g, " ")}</Badge>
                        {l.value && <span className="text-sm">{formatINR(Number(l.value))}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="visits" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">When they came in</CardTitle>
            </CardHeader>
            <CardContent>
              {data.visits.length === 0 ? (
                <EmptyState
                  icon={DoorOpen}
                  title="No recorded visits"
                  description="Check-ins logged at the counter appear here."
                />
              ) : (
                <div className="space-y-2">
                  {data.visits.map((v) => (
                    <div
                      key={v.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
                    >
                      <div className="flex items-center gap-2">
                        {/* Purpose is tenant vocabulary — a clinic's reasons for
                            a visit are its own. Outcome is a fixed enum, so it
                            renders as itself rather than through a lookup that
                            would always miss. */}
                        <Badge variant="secondary">
                          {label("checkin_purpose", v.purpose)}
                        </Badge>
                        <span className="text-sm">{v.outcome.replace(/_/g, " ")}</span>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {new Date(v.createdAt).toLocaleString()}
                        {v.store ? ` · ${v.store.name}` : ""}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="products" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">What they looked at</CardTitle>
            </CardHeader>
            <CardContent>
              {data.productInteractions.length === 0 ? (
                <EmptyState
                  icon={Gem}
                  title="No product interest recorded"
                  description="Record what a customer was shown or tried, and it appears here."
                />
              ) : (
                <div className="space-y-2">
                  {data.productInteractions.map((pi) => (
                    <div
                      key={pi.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
                    >
                      <div className="flex items-center gap-2">
                        <Badge variant="outline">{pi.kind}</Badge>
                        <span className="font-medium">
                          {pi.product?.name ?? pi.sku ?? "Unidentified item"}
                        </span>
                        {pi.product?.sku && (
                          <span className="text-xs text-muted-foreground">{pi.product.sku}</span>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {new Date(pi.occurredAt).toLocaleDateString()}
                        {pi.user ? ` · ${pi.user.name}` : ""}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="purchases" className="mt-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Quotes</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {data.quotes.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No quotes raised.</p>
                ) : (
                  data.quotes.map((q) => (
                    <div
                      key={q.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
                    >
                      <span className="font-medium">{q.ref}</span>
                      <span className="flex items-center gap-2">
                        <Badge variant="outline">{q.kind}</Badge>
                        <Badge variant="secondary">{q.status}</Badge>
                      </span>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Returns &amp; exchanges</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {data.returns.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Nothing returned or exchanged.
                  </p>
                ) : (
                  data.returns.map((r) => (
                    <div
                      key={r.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
                    >
                      <span className="font-medium">
                        {r.ref}
                        {r.item ? (
                          <span className="ml-2 text-xs text-muted-foreground">{r.item}</span>
                        ) : null}
                      </span>
                      <span className="flex items-center gap-2">
                        <Badge variant="outline">{r.type.replace(/_/g, " ")}</Badge>
                        <Badge variant="secondary">{r.status}</Badge>
                      </span>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Invoices</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {data.sales.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No purchases recorded.</p>
                ) : (
                  data.sales.map((s) => (
                    <div key={s.id} className="flex justify-between rounded-md border px-3 py-2">
                      <span className="font-medium">{s.docNo}</span>
                      <span>{formatINR(Number(s.totalAmount))}</span>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Payments</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {data.payments.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No payments recorded.</p>
                ) : (
                  data.payments.map((p) => (
                    <div key={p.id} className="flex justify-between rounded-md border px-3 py-2">
                      <span>
                        {p.mode}
                        {/* A reversal is a negative row, not a deleted one. */}
                        {p.reversesPaymentId && (
                          <Badge variant="outline" className="ml-2">
                            reversal
                          </Badge>
                        )}
                      </span>
                      <span>{formatINR(Number(p.amount))}</span>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="conversations" className="mt-4">
          <Card>
            <CardContent className="pt-6">
              {data.conversations.length === 0 ? (
                <EmptyState
                  icon={MessageSquare}
                  title="No conversations"
                  description="WhatsApp and other channel threads with this customer appear here."
                />
              ) : (
                <div className="space-y-2">
                  {data.conversations.map((c) => (
                    <Link
                      key={c.id}
                      href={`/conversations?thread=${c.id}`}
                      className="flex items-center justify-between rounded-md border px-3 py-2 hover:bg-accent"
                    >
                      <span className="flex items-center gap-2">
                        <Badge variant="secondary">{c.channel}</Badge>
                        <span>{c.subject ?? "Conversation"}</span>
                      </span>
                      <Badge variant={c.handling === "human" ? "default" : "outline"}>
                        {c.handling}
                      </Badge>
                    </Link>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="qualification" className="mt-4">
          {/* Scoped to the customer: the panel shows the most recent assessment
              across their leads and conversations. Assessment itself is offered
              where the conversation or lead is, since that is what gets read. */}
          <QualificationPanel partyId={id} />
        </TabsContent>

        <TabsContent value="attribution" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">How they found us</CardTitle>
            </CardHeader>
            <CardContent>
              {/* Real touches now (Phase A10). Declared and measured stay
                  labelled separately — see AttributionPanel. */}
              <AttributionPanel partyId={id} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}

function TimelineRow({ event }: { event: TimelineEvent }) {
  // createElement, not `const Icon = …`: the icon is looked up per row, and a
  // capitalised local reads to React (and to the linter) as a component defined
  // during render, which would remount the icon on every update.
  const icon = createElement(timelineIcon(event.type), {
    className: "h-4 w-4 text-muted-foreground",
  });
  return (
    <li className="flex gap-3">
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border bg-muted">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm">{event.summary}</p>
        <p className="text-xs text-muted-foreground">
          {new Date(event.occurredAt).toLocaleString()}
          {event.store ? ` · ${event.store.name}` : ""}
          {event.actorUser ? ` · ${event.actorUser.name}` : ""}
        </p>
      </div>
      <Separator orientation="vertical" className="hidden" />
    </li>
  );
}
