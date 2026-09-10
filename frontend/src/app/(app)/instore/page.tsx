"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ClipboardList,
  FileText,
  LayoutDashboard,
  Loader2,
  MapPin,
  MessageSquare,
  RefreshCw,
  Search,
  Store,
  UserPlus,
  Users,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { AddVisitDialog } from "@/components/instore/add-visit-dialog";
import { DayTab, FormsTab, TasksTab, VisitsTab } from "@/components/instore/floor-tabs";
import { useT } from "@/lib/i18n";
import {
  useInStoreLeads,
  useInStoreProfile,
  useInStoreSearch,
  type InStoreLead,
} from "@/lib/queries/instore";
import { apiErrorMessage } from "@/lib/utils";
import { useSession } from "@/store/use-session";

/**
 * The floor / field application.
 *
 * Mobile-first because it is used standing up, one-handed, with a customer
 * waiting. Every number and every row on this screen comes from a
 * tenant-scoped endpoint — the version this replaced rendered a hardcoded
 * array, which compiled, looked complete, and would have shown a stranger's
 * customers to whoever opened it.
 */

const TABS = [
  { value: "leads", label: "Leads", icon: Users },
  { value: "visits", label: "Visits", icon: MapPin },
  { value: "dashboard", label: "Today", icon: LayoutDashboard },
  { value: "tasks", label: "Tasks", icon: ClipboardList },
  { value: "forms", label: "Forms", icon: FileText },
] as const;

type Tab = (typeof TABS)[number]["value"];

function sinceLabel(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return days < 31 ? `${days} d ago` : `${Math.floor(days / 30)} mo ago`;
}

function LeadCard({
  lead,
  onVisit,
  onOpen,
}: {
  lead: InStoreLead;
  onVisit: () => void;
  onOpen: () => void;
}) {
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <button type="button" onClick={onOpen} className="w-full space-y-1 text-left">
          <div className="flex items-start justify-between gap-2">
            <p className="truncate font-medium">{lead.customerName}</p>
            <span className="shrink-0 text-xs text-muted-foreground">
              {sinceLabel(lead.createdAt)}
            </span>
          </div>
          {lead.customerId ? (
            <p className="font-[family-name:var(--font-mono-face)] text-xs text-muted-foreground">
              {lead.customerId}
            </p>
          ) : null}
          {lead.interest ? (
            <p className="line-clamp-2 text-xs text-muted-foreground">{lead.interest}</p>
          ) : null}
        </button>

        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline" className="text-[10px]">
            {lead.source.replace(/_/g, " ")}
          </Badge>
          <Badge variant="secondary" className="text-[10px]">
            {lead.stage}
          </Badge>
          {lead.hasWhatsApp ? (
            <Badge variant="outline" className="text-[10px]">
              WhatsApp
            </Badge>
          ) : null}
          {lead.store ? (
            <Badge variant="outline" className="text-[10px]">
              {lead.store.name}
            </Badge>
          ) : null}
        </div>

        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            asChild
            disabled={!lead.partyId}
          >
            <Link href={`/conversations?partyId=${lead.partyId ?? ""}`}>
              <MessageSquare className="mr-1.5 h-3.5 w-3.5" />
              Chat
            </Link>
          </Button>
          <Button size="sm" className="flex-1" onClick={onVisit} disabled={!lead.partyId}>
            <MapPin className="mr-1.5 h-3.5 w-3.5" />
            Record visit
          </Button>
        </div>

        {lead.owner ? (
          <p className="text-[11px] text-muted-foreground">Owner: {lead.owner.name}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** The 360 panel, opened from a lead or a search result. */
function CustomerPanel({
  partyId,
  onBack,
  onVisit,
}: {
  partyId: string;
  onBack: () => void;
  onVisit: () => void;
}) {
  const profile = useInStoreProfile(partyId);

  if (profile.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (profile.isError || !profile.data) {
    return (
      <div className="space-y-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <p className="text-sm text-muted-foreground">
          {apiErrorMessage(profile.error, "Could not load this customer.")}
        </p>
      </div>
    );
  }

  const d = profile.data as {
    party?: { name?: string; city?: string; code?: string; createdAt?: string };
    leads?: unknown[];
    visits?: unknown[];
    conversations?: unknown[];
    sales?: unknown[];
    tasks?: unknown[];
  };
  const party = d.party ?? {};

  const counts: { label: string; value: number }[] = [
    { label: "Enquiries", value: d.leads?.length ?? 0 },
    { label: "Visits", value: d.visits?.length ?? 0 },
    { label: "Chats", value: d.conversations?.length ?? 0 },
    { label: "Orders", value: d.sales?.length ?? 0 },
  ];

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2">
        <ArrowLeft className="mr-2 h-4 w-4" />
        Back
      </Button>

      <div>
        <h2 className="font-[family-name:var(--font-display-face)] text-xl">
          {party.name ?? "Customer"}
        </h2>
        <p className="text-xs text-muted-foreground">
          {party.code ? `${party.code} · ` : ""}
          {party.city ?? ""}
          {party.createdAt ? ` · with you ${sinceLabel(party.createdAt)}` : ""}
        </p>
      </div>

      <div className="grid grid-cols-4 gap-2">
        {counts.map((c) => (
          <div key={c.label} className="rounded-md border border-border p-2 text-center">
            <div className="font-[family-name:var(--font-display-face)] text-lg tabular-nums">
              {c.value}
            </div>
            <div className="text-[10px] text-muted-foreground">{c.label}</div>
          </div>
        ))}
      </div>

      <Button className="w-full" onClick={onVisit}>
        <MapPin className="mr-2 h-4 w-4" />
        Record a visit
      </Button>
    </div>
  );
}

export default function InStorePage() {
  const currentStore = useSession((s) => s.currentStore);
  const t = useT();
  const storeWord = t("label.store", "Branch");

  const [tab, setTab] = useState<Tab>("leads");
  const [query, setQuery] = useState("");
  const [openParty, setOpenParty] = useState<{ id: string; name: string } | null>(null);
  const [visitFor, setVisitFor] = useState<{ id: string; name: string } | null>(null);

  const leads = useInStoreLeads();
  const search = useInStoreSearch(query);
  const searching = query.trim().length >= 3;

  /*
   * The branch every tab below is scoped to.
   *
   * The aggregate ("All branches") pseudo-store is not a branch and the API
   * rejects it, so it is sent as undefined — which the server reads as "every
   * branch this person works at". That is the right answer for a head-office
   * user opening the floor app, and the only possible one for a salesperson,
   * who has exactly one.
   */
  const scopedStoreId =
    currentStore && !currentStore.isAggregate ? currentStore.id : undefined;

  return (
    <div className="pb-40 md:pb-24">
      {/* Scope, always visible. A salesperson has to know which branch they are
          filing against before they file anything. */}
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          <Store className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium">{currentStore?.name ?? storeWord}</span>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void leads.refetch()}
          disabled={leads.isFetching}
          aria-label="Refresh"
        >
          <RefreshCw className={`h-4 w-4 ${leads.isFetching ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {openParty ? (
        <CustomerPanel
          partyId={openParty.id}
          onBack={() => setOpenParty(null)}
          onVisit={() => setVisitFor(openParty)}
        />
      ) : (
        <>
          <div className="relative mb-4">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Phone, name or customer ID"
              className="h-11 pl-9"
              inputMode="search"
              autoComplete="off"
            />
          </div>

          {searching ? (
            <div className="space-y-3">
              {search.isLoading ? (
                <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Searching…
                </div>
              ) : search.isError ? (
                <p className="text-sm text-muted-foreground">
                  {apiErrorMessage(search.error, "Could not search just now.")}
                </p>
              ) : !search.data?.items.length ? (
                <Card>
                  <CardContent className="space-y-3 py-8 text-center">
                    <UserPlus className="mx-auto h-8 w-8 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium">Nobody matches “{query}”</p>
                      <p className="text-xs text-muted-foreground">
                        They may be new. Add them from the customer directory.
                      </p>
                    </div>
                    <Button size="sm" variant="outline" asChild>
                      <Link href="/customers">Open the directory</Link>
                    </Button>
                  </CardContent>
                </Card>
              ) : (
                search.data.items.map((p) => (
                  <Card key={p.partyId}>
                    <CardContent className="space-y-2 p-4">
                      <button
                        type="button"
                        className="w-full text-left"
                        onClick={() => setOpenParty({ id: p.partyId, name: p.name })}
                      >
                        <p className="font-medium">{p.name}</p>
                        <p className="font-[family-name:var(--font-mono-face)] text-xs text-muted-foreground">
                          {p.contact ?? "no number"}
                          {p.customerId ? ` · ${p.customerId}` : ""}
                        </p>
                      </button>
                      {p.activeLead ? (
                        <div className="flex flex-wrap gap-1.5">
                          <Badge variant="outline" className="text-[10px]">
                            {p.activeLead.source.replace(/_/g, " ")}
                          </Badge>
                          <Badge variant="secondary" className="text-[10px]">
                            open enquiry · {sinceLabel(p.activeLead.createdAt)}
                          </Badge>
                        </div>
                      ) : null}
                      <Button
                        size="sm"
                        className="w-full"
                        onClick={() => setVisitFor({ id: p.partyId, name: p.name })}
                      >
                        <MapPin className="mr-1.5 h-3.5 w-3.5" />
                        Record visit
                      </Button>
                    </CardContent>
                  </Card>
                ))
              )}
            </div>
          ) : tab === "leads" ? (
            <div className="space-y-3">
              <div className="flex items-baseline justify-between">
                <h2 className="font-[family-name:var(--font-display-face)] text-lg">Leads</h2>
                <span className="text-sm tabular-nums text-muted-foreground">
                  {leads.data ? leads.data.total.toLocaleString() : "—"}
                </span>
              </div>
              {leads.isLoading ? (
                <>
                  <Skeleton className="h-40 w-full" />
                  <Skeleton className="h-40 w-full" />
                </>
              ) : leads.isError ? (
                <p className="text-sm text-muted-foreground">
                  {apiErrorMessage(leads.error, "Could not load the lead feed.")}
                </p>
              ) : !leads.data?.items.length ? (
                <EmptyState
                  icon={Users}
                  title="No leads yet"
                  description="Leads from ads, the website, WhatsApp and the counter all appear here."
                />
              ) : (
                leads.data.items.map((lead) => (
                  <LeadCard
                    key={lead.id}
                    lead={lead}
                    onOpen={() =>
                      lead.partyId && setOpenParty({ id: lead.partyId, name: lead.customerName })
                    }
                    onVisit={() =>
                      lead.partyId && setVisitFor({ id: lead.partyId, name: lead.customerName })
                    }
                  />
                ))
              )}
            </div>
          ) : tab === "visits" ? (
            <VisitsTab storeId={scopedStoreId} />
          ) : tab === "dashboard" ? (
            <DayTab storeId={scopedStoreId} />
          ) : tab === "tasks" ? (
            <TasksTab storeId={scopedStoreId} />
          ) : (
            <FormsTab storeId={scopedStoreId} />
          )}
        </>
      )}

      {/*
        Bottom navigation, sitting ON TOP of the app's own mobile bar rather than
        underneath it.

        The global nav is `fixed bottom-0 z-40 h-16 md:hidden`. The first version
        of this was `bottom-0 z-20`, which put it behind that bar and made it
        invisible on exactly the device this screen exists for — caught by
        driving it at 390px, not by anything the compiler could see. On desktop
        the global bar is hidden, so this drops back to the bottom edge.
      */}
      <nav className="fixed inset-x-0 bottom-16 z-30 border-t border-border bg-background md:bottom-0 md:pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto flex max-w-lg">
          {TABS.map((x) => {
            const Icon = x.icon;
            const active = tab === x.value && !openParty;
            return (
              <button
                key={x.value}
                type="button"
                onClick={() => {
                  setTab(x.value);
                  setOpenParty(null);
                  setQuery("");
                }}
                className={`flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[10px] transition-colors ${
                  active ? "text-foreground" : "text-muted-foreground"
                }`}
              >
                <Icon className="h-5 w-5" />
                {x.label}
              </button>
            );
          })}
        </div>
      </nav>

      {visitFor ? (
        <AddVisitDialog
          open
          onOpenChange={(o) => !o && setVisitFor(null)}
          partyId={visitFor.id}
          customerName={visitFor.name}
        />
      ) : null}
    </div>
  );
}
