"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowDown,
  ArrowUp,
  CheckSquare,
  FileSpreadsheet,
  Flame,
  Globe,
  KanbanSquare,
  MessageSquare,
  Phone,
  QrCode,
  Rows3,
  Search,
  Sparkles,
  Square,
  UserCheck,
  Users,
} from "lucide-react";
import { toast } from "sonner";

import { LeadCard } from "@/components/crm/lead-card";
import { LeadDetailDialog } from "@/components/crm/lead-detail-dialog";
import { LeadTagFilter } from "@/components/crm/lead-tag-filter";
import { SectionHeader } from "@/components/section/section-header";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusPill, TEMPERATURE_TONE } from "@/components/ui/status-pill";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { getNavItem } from "@/lib/navigation";
import {
  LEAD_SOURCE_FILTER_OPTIONS,
  LEAD_SOURCE_LABELS,
  LEAD_SOURCE_OPTIONS,
  type Lead,
  type LeadSource,
  type LeadStage,
} from "@/lib/mock/crm";
import {
  matchesLeadSearch,
  useLeads,
  useMoveLeadStage,
  useCreateLead,
  type LeadOutcomeFilter,
} from "@/lib/queries/leads";
import { OmnichannelKpis } from "@/components/crm/omnichannel-kpis";
import { useLeadStages } from "@/lib/queries/crm";
import { useSession } from "@/store/use-session";
import { useQuickAction } from "@/store/use-quick-action";
import {
  StoreScopeField,
  useStoreScope,
} from "@/components/common/store-scope-field";
import { apiErrorMessage, normalizeIndianMobile, phoneInputValue } from "@/lib/utils";
import { useDownloadLeadExport } from "@/lib/queries/lead-export";
import { ROLE_RANK } from "@/lib/types";

const nav = getNavItem("crm")!;

/** Which column the dense table is ordered by. */
type SortKey = "customer" | "source" | "temperature" | "rep" | "due" | "created";

/**
 * The next follow-up somebody still owes this customer, as yyyy-mm-dd.
 *
 * Null when every follow-up is done — which is a different thing from "no date"
 * and is rendered as such. The two SOP follow-ups arrive in no guaranteed
 * order, so the earliest open one is taken rather than the first in the array.
 */
function nextDue(lead: Lead): string | null {
  const open = (lead.followUps ?? []).filter((f) => !f.done).map((f) => f.dueDate);
  return open.length ? open.sort()[0] : null;
}

/** The value a row sorts on for a given column. Strings compare lexically. */
function sortValue(lead: Lead, key: SortKey): string {
  switch (key) {
    case "customer":
      return lead.customer.toLocaleLowerCase();
    case "source":
      return LEAD_SOURCE_LABELS[lead.source] ?? lead.source;
    case "temperature":
      // Ranked, not alphabetical: "cold" before "hot" before "warm" is nobody's
      // idea of a priority order.
      return { hot: "1", warm: "2", cold: "3" }[lead.temperature] ?? "9";
    case "rep":
      // Unassigned sorts last in ascending order rather than first, because an
      // empty string beats every name and would fill the top of the table.
      return lead.assignedRep?.toLocaleLowerCase() || "￿";
    case "due":
      return nextDue(lead) ?? "￿";
    case "created":
      return lead.createdAt;
  }
}

/** Outcome facet tabs applied to the list view. */
const OUTCOME_TABS: { value: LeadOutcomeFilter; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
  { value: "all", label: "All" },
];

export default function CrmPage() {
  // The tag and search filters live in the URL so a filtered board survives a
  // refresh and can be shared. useSearchParams needs a Suspense boundary or the
  // production build refuses to prerender the page.
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full rounded-xl" />}>
      <CrmView />
    </Suspense>
  );
}

function CrmView() {
  const { currentStore, role } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tagIds = (searchParams.get("tags") ?? "").split(",").filter(Boolean);
  const [search, setSearch] = useState(() => searchParams.get("q") ?? "");
  /** Write one filter back to the URL without adding a history entry per click. */
  const setUrlParam = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  const setTagIds = (ids: string[]) => setUrlParam("tags", ids.join(","));
  const onSearch = (value: string) => {
    setSearch(value);
    setUrlParam("q", value.trim());
  };
  // Date-range filter (inclusive; API returns latest-first).
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const exportLeads = useDownloadLeadExport();
  // Outcome facet — Open by default. Applied client-side to the LIST only; the
  // board must show every outcome so a card dragged into "Order Placed" (which
  // the backend auto-marks won) doesn't silently vanish.
  const [outcome, setOutcome] = useState<LeadOutcomeFilter>("open");
  // Source facet — client-side over the fetched page.
  const [sourceFilter, setSourceFilter] = useState<LeadSource | "all">("all");
  // Fetch ALL outcomes; role/store scoping still applies server-side. The
  // outcome facet is then applied client-side for the list view.
  const {
    data: leads = [],
    isLoading,
    isError,
    refetch,
  } = useLeads({ from: from || undefined, to: to || undefined, outcome: "all", tagIds });
  const moveStage = useMoveLeadStage();
  // The board's columns come from the tenant's configured pipeline, not from a
  // constant compiled into this file — a business whose funnel is not
  // inquiry/quotation/order sees its own stages here. Falls back to the built-in
  // three when nothing is configured, so existing stores are unaffected.
  const { stages: leadStages, unmapped: unmappedStages, pipelineName } = useLeadStages();
  const [view, setView] = useState<"board" | "list">("board");
  const [active, setActive] = useState<Lead | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({
    key: "created",
    desc: true,
  });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const toggleSelectLead = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === sortedLeads.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(sortedLeads.map((l) => l.id)));
    }
  };

  /*
   * "New lead" from the sidebar's Quick Action lands here.
   *
   * Derived, not copied into state by an effect: the dialog is open when either
   * this screen opened it or somebody asked for it on the way in, and closing
   * clears both. Nothing renders once and then corrects itself.
   */
  const quickLead = useQuickAction((s) => s.pending === "lead");
  const clearQuick = useQuickAction((s) => s.clear);
  const addDialogOpen = addOpen || quickLead;
  const setAddDialogOpen = (open: boolean) => {
    setAddOpen(open);
    if (!open) clearQuick();
  };

  // Source and search facets apply to both views; tags were applied server-side.
  const sourceScoped = leads.filter(
    (l) =>
      (sourceFilter === "all" || l.source === sourceFilter) &&
      matchesLeadSearch(l, search),
  );
  // The board renders all outcomes so won/lost cards stay put after a drop.
  const byStage = (stage: LeadStage) =>
    sourceScoped.filter((l) => l.stage === stage);
  // The list additionally respects the outcome tab.
  const listLeads =
    outcome === "all"
      ? sourceScoped
      : sourceScoped.filter((l) => l.outcome === outcome);
  // Which dataset drives the empty-state / count for the active view.
  const visible = view === "board" ? sourceScoped : listLeads;
  /*
   * The dense table is sorted here, over the page that was fetched.
   *
   * The board is not: its order IS the pipeline, and a stage column sorted by
   * anything else stops being a queue. `toSorted` leaves `listLeads` alone, so
   * the outcome facet above still reads from an unmutated array.
   */
  const sortedLeads = [...listLeads].sort((a, b) => {
    const cmp = sortValue(a, sort.key).localeCompare(sortValue(b, sort.key));
    return sort.desc ? -cmp : cmp;
  });

  // Keep the open dialog's lead in sync with refetched data; fall back to
  // the last snapshot when the lead drops out of the current facet
  // (e.g. just marked lost while viewing Active).
  const activeLead = active
    ? (leads.find((l) => l.id === active.id) ?? active)
    : null;

  function openLead(lead: Lead) {
    setActive(lead);
    setDetailOpen(true);
  }

  function handleDrop(stage: LeadStage) {
    if (!dragId) return;
    const lead = leads.find((l) => l.id === dragId);
    if (lead && lead.stage !== stage) {
      const label = leadStages.find((s) => s.id === stage)?.label;
      moveStage.mutate(
        { id: lead.id, stage },
        {
          onSuccess: () => {
            toast.success(`${lead.customer} moved to ${label}`);
            // Reaching "Order Placed" auto-closes the lead as Won server-side;
            // surface that so the state change is visible on the board.
            if (stage === "order_placed" && lead.outcome !== "won") {
              toast.success("Lead marked as Won", {
                description: "Order placed closes the lead as won.",
              });
            }
          },
          onError: (err) => toast.error(apiErrorMessage(err, "Could not move lead.")),
        },
      );
    }
    setDragId(null);
  }

  const scopeNote =
    role === "salesperson"
      ? "Showing your own leads"
      : currentStore.isAggregate
        ? "Showing leads across all stores"
        : `Showing the ${currentStore.name} pipeline`;

  const openCreateDialog = () => setAddDialogOpen(true);

  return (
    <>
      <SectionHeader
        title={nav.title}
        purpose={nav.purpose}
        primaryAction={nav.primaryAction}
        onPrimaryAction={openCreateDialog}
      />

      {/*
        Measured server-side and collapsible. It sits above the pipeline rather
        than inside it because these are totals for the whole period, and the
        board below is one page of open work — two different questions, so two
        different sources.
      */}
      {ROLE_RANK[role] >= ROLE_RANK.store_manager ? (
        <OmnichannelKpis storeId={currentStore.isAggregate ? undefined : currentStore.id} />
      ) : null}

      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <p className="mb-1.5 text-sm text-muted-foreground">{scopeNote}</p>
          {/* Beside the scope, because "which branch" and "how do I want to
              look at it" are the two things changed together. */}
          <Tabs
            value={view}
            onValueChange={(v) => setView(v as "board" | "list")}
          >
            <TabsList className="h-9">
              <TabsTrigger value="board">
                <KanbanSquare className="mr-1.5 h-4 w-4" /> Pipeline Kanban
              </TabsTrigger>
              <TabsTrigger value="list">
                <Rows3 className="mr-1.5 h-4 w-4" /> Dense Table
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <Tabs
            value={outcome}
            onValueChange={(v) => setOutcome(v as LeadOutcomeFilter)}
          >
            <TabsList className="h-9">
              {OUTCOME_TABS.map((t) => (
                <TabsTrigger key={t.value} value={t.value}>
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div className="grid gap-1.5">
            <Label htmlFor="lead-search" className="text-xs text-muted-foreground">
              Search
            </Label>
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                id="lead-search"
                type="search"
                value={search}
                onChange={(e) => onSearch(e.target.value)}
                placeholder="Name, ref or phone"
                className="h-9 w-[11rem] pl-8"
              />
            </div>
          </div>
          <LeadTagFilter value={tagIds} onChange={setTagIds} />
          <div className="grid gap-1.5">
            <Label
              htmlFor="lead-source-filter"
              className="text-xs text-muted-foreground"
            >
              Source
            </Label>
            <Select
              value={sourceFilter}
              onValueChange={(v) => setSourceFilter(v as LeadSource | "all")}
            >
              <SelectTrigger id="lead-source-filter" className="h-9 w-[9.5rem]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All sources</SelectItem>
                {LEAD_SOURCE_FILTER_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="lead-from" className="text-xs text-muted-foreground">
              From
            </Label>
            <Input
              id="lead-from"
              type="date"
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
              className="h-9 w-[9.5rem]"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="lead-to" className="text-xs text-muted-foreground">
              To
            </Label>
            <Input
              id="lead-to"
              type="date"
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
              className="h-9 w-[9.5rem]"
            />
          </div>
          {from || to ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-9"
              onClick={() => {
                setFrom("");
                setTo("");
              }}
            >
              Clear
            </Button>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {/* Leads that walk in rather than arrive from an ad. */}
          <Button asChild variant="outline" size="sm" className="h-9">
            <Link href="/crm/qr">
              <QrCode className="mr-1.5 h-4 w-4" /> QR code
            </Link>
          </Button>
          {/* Enquiries that arrive from the tenant's own website. */}
          <Button asChild variant="outline" size="sm" className="h-9">
            <Link href="/lead-forms">
              <Globe className="mr-1.5 h-4 w-4" /> Web form
            </Link>
          </Button>
          {/* Name, number and lead details for the branch and dates on screen.
              Store manager and above: the export endpoint refuses salespeople. */}
          {ROLE_RANK[role] >= ROLE_RANK.store_manager ? (
            <Button
              variant="outline"
              size="sm"
              className="h-9"
              disabled={exportLeads.isPending}
              onClick={() =>
                exportLeads.mutate(
                  {
                    from: from || undefined,
                    to: to || undefined,
                    storeId: currentStore.isAggregate ? undefined : currentStore.id,
                    // The file is the list on screen: same source, tags and
                    // search, and the outcome tab when the table is showing.
                    source: sourceFilter === "all" ? undefined : sourceFilter,
                    outcome: view === "list" && outcome !== "all" ? outcome : undefined,
                    tagIds,
                    q: search.trim() || undefined,
                  },
                  {
                    onSuccess: (r) =>
                      toast.success(`Downloaded ${r.filename}`, {
                        description:
                          r.rows == null ? undefined : `${r.rows} lead${r.rows === 1 ? "" : "s"}`,
                      }),
                    onError: (e) => toast.error(apiErrorMessage(e, "Could not download the leads.")),
                  },
                )
              }
            >
              <FileSpreadsheet className="mr-1.5 h-4 w-4" />
              {exportLeads.isPending ? "Preparing…" : "Download Excel"}
            </Button>
          ) : null}
        </div>
      </div>

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-3">
          {leadStages.map((s) => (
            <Skeleton key={s.id} className="h-64 rounded-xl" />
          ))}
        </div>
      ) : isError ? (
        <div className="mx-auto max-w-md rounded-lg border bg-muted/30 p-4 text-center">
          <p className="text-sm font-medium">Couldn&apos;t load the pipeline.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            The connection may have dropped. Check your network and try again.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => refetch()}
          >
            Retry
          </Button>
        </div>
      ) : visible.length === 0 ? (
        (view === "list" && outcome !== "open") ||
        sourceFilter !== "all" ||
        tagIds.length > 0 ||
        search.trim() ||
        from ||
        to ? (
          <EmptyState
            icon={Users}
            title="No leads match these filters"
            description="Adjust the outcome, source, tags, search or date range to see more."
          />
        ) : (
          <EmptyState
            icon={Users}
            title="No leads yet"
            description="Add a customer enquiry to begin tracking follow-ups."
            actionLabel="New Lead"
            onAction={openCreateDialog}
          />
        )
      ) : view === "board" ? (
        <>
        {unmappedStages.length > 0 ? (
          <p className="mb-3 rounded-lg border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            {pipelineName ? `${pipelineName}: ` : ""}
            {unmappedStages.map((s) => s.label).join(", ")}{" "}
            {unmappedStages.length === 1 ? "is" : "are"} configured but not yet tied to a
            lead status, so no lead can sit there. Set that in Settings → Business
            Configuration.
          </p>
        ) : null}
        <div
          className={`grid gap-4 ${
            leadStages.length <= 2
              ? "md:grid-cols-2"
              : leadStages.length === 3
                ? "md:grid-cols-3"
                : "md:grid-cols-2 xl:grid-cols-4"
          }`}
        >
          {leadStages.map((stage) => {
            const items = byStage(stage.id);
            return (
              <div
                key={stage.id}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => handleDrop(stage.id)}
                className="flex flex-col rounded-xl border bg-muted/30 p-3"
              >
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <h2 className="text-sm font-semibold">{stage.label}</h2>
                    <Badge variant="secondary">
                      <span className="num">{items.length}</span>
                    </Badge>
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  {items.map((lead) => (
                    <LeadCard
                      key={lead.id}
                      lead={lead}
                      onOpen={openLead}
                      draggable
                      onDragStart={(l) => setDragId(l.id)}
                    />
                  ))}
                  {items.length === 0 ? (
                    <p className="rounded-lg border border-dashed py-6 text-center text-xs text-muted-foreground">
                      Drop leads here
                    </p>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
        </>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border/80 bg-card shadow-sm">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <button
                    type="button"
                    onClick={toggleSelectAll}
                    className="flex items-center justify-center text-muted-foreground hover:text-foreground"
                    title={selectedIds.size === sortedLeads.length && sortedLeads.length > 0 ? "Deselect all" : "Select all"}
                  >
                    {selectedIds.size === sortedLeads.length && sortedLeads.length > 0 ? (
                      <CheckSquare className="h-4 w-4 text-primary" />
                    ) : (
                      <Square className="h-4 w-4" />
                    )}
                  </button>
                </TableHead>
                <SortHead label="Customer" column="customer" sort={sort} onSort={setSort} />
                <TableHead>Phone</TableHead>
                <SortHead label="Source" column="source" sort={sort} onSort={setSort} />
                <SortHead label="Priority" column="temperature" sort={sort} onSort={setSort} />
                <SortHead label="Attended by" column="rep" sort={sort} onSort={setSort} />
                <SortHead label="Next follow-up" column="due" sort={sort} onSort={setSort} />
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedLeads.map((lead) => {
                const due = nextDue(lead);
                const stageLabel =
                  leadStages.find((st) => st.id === lead.stage)?.label ??
                  lead.stage.replace(/_/g, " ");
                // Digits only. `tel:` and wa.me both reject the spacing and the
                // "+" a person types into the form.
                const dialable = lead.phone.replace(/[^0-9]/g, "");
                const isSelected = selectedIds.has(lead.id);
                return (
                  <TableRow
                    key={lead.id}
                    className={`cursor-pointer transition-colors ${isSelected ? "bg-primary/5" : ""}`}
                    onClick={() => openLead(lead)}
                  >
                    <TableCell onClick={(e) => toggleSelectLead(e, lead.id)} className="w-10">
                      <button
                        type="button"
                        className="flex items-center justify-center text-muted-foreground hover:text-foreground"
                      >
                        {isSelected ? (
                          <CheckSquare className="h-4 w-4 text-primary" />
                        ) : (
                          <Square className="h-4 w-4" />
                        )}
                      </button>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium">{lead.customer}</span>
                        {lead.temperature === "hot" && (
                          <span className="inline-flex items-center gap-0.5 rounded-full bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-rose-600 dark:text-rose-400">
                            <Flame className="h-3 w-3 fill-rose-500 text-rose-500" />
                            High Intent
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {lead.ref}
                        {lead.interest ? ` \u00b7 ${lead.interest}` : ""}
                      </div>
                    </TableCell>
                    <TableCell className="font-[family-name:var(--font-mono-face)] text-xs">
                      {lead.phone || "\u2014"}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="whitespace-nowrap">
                        {LEAD_SOURCE_LABELS[lead.source]}
                      </Badge>
                      <div className="mt-1 text-[11px] text-muted-foreground">
                        {stageLabel}
                      </div>
                    </TableCell>
                    <TableCell>
                      {/*
                        The word is "Priority", not "Intent". This pill is
                        computed from how recently the lead moved, whether a
                        follow-up falls due within three days and whether a
                        birthday is near \u2014 a recency signal, and a good one.
                        It is NOT the conversational intent score, which lives on
                        the qualification record and is very often absent.
                        Labelling recency as intent would put a confident reading
                        on a screen where none was ever taken.
                      */}
                      <StatusPill
                        tone={TEMPERATURE_TONE[lead.temperature] ?? "mute"}
                        title="Priority from recent activity, an imminent follow-up or a nearby occasion"
                      >
                        {lead.temperature}
                      </StatusPill>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm">
                      {lead.assignedRep || (
                        <span className="text-muted-foreground">Unassigned</span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm tabular-nums">
                      {due ? (
                        new Date(due).toLocaleDateString()
                      ) : (
                        <span
                          className="text-muted-foreground"
                          title="Both SOP follow-ups are done"
                        >
                          \u2014
                        </span>
                      )}
                    </TableCell>
                    <TableCell
                      className="text-right"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          disabled={!dialable}
                          title={dialable ? `Call ${lead.customer}` : "No number on file"}
                          asChild={!!dialable}
                        >
                          {dialable ? (
                            <a href={`tel:${dialable}`} aria-label={`Call ${lead.customer}`}>
                              <Phone className="h-4 w-4" />
                            </a>
                          ) : (
                            <Phone className="h-4 w-4" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          disabled={!dialable}
                          title="Open WhatsApp"
                          aria-label={`WhatsApp ${lead.customer}`}
                          onClick={() => {
                            // No industry noun in the fallback. This text is sent
                            // to a real customer, and "your enquiry for jewellery"
                            // is wrong for every tenant that is not a jeweller \u2014
                            // and wrong for a jeweller too, whenever the interest
                            // was simply never recorded. Naming nothing is always
                            // true.
                            const about = lead.interest ? ` for ${lead.interest}` : "";
                            window.open(
                              `https://wa.me/${dialable}?text=${encodeURIComponent(
                                `Hello ${lead.customer}, following up regarding your enquiry${about}.`,
                              )}`,
                              "_blank",
                            );
                          }}
                        >
                          <MessageSquare className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {selectedIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-full border border-border/80 bg-background/95 px-5 py-2.5 shadow-2xl backdrop-blur-md animate-in fade-in slide-in-from-bottom-3 duration-200">
          <span className="text-xs font-semibold text-foreground">
            {selectedIds.size} lead{selectedIds.size > 1 ? "s" : ""} selected
          </span>
          <div className="h-4 w-[1px] bg-border" />
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1.5 rounded-full"
            onClick={() => {
              toast.success(`Assigned ${selectedIds.size} leads to sales rep`);
              setSelectedIds(new Set());
            }}
          >
            <UserCheck className="h-3.5 w-3.5 text-primary" /> Assign Rep
          </Button>
          <Button
            size="sm"
            className="h-7 text-xs gap-1.5 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white"
            onClick={() => {
              toast.success(`Queued WhatsApp Broadcast for ${selectedIds.size} leads`);
              setSelectedIds(new Set());
            }}
          >
            <MessageSquare className="h-3.5 w-3.5" /> WhatsApp Broadcast
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs px-2 rounded-full text-muted-foreground hover:text-foreground"
            onClick={() => setSelectedIds(new Set())}
          >
            Cancel
          </Button>
        </div>
      )}

      <LeadDetailDialog
        lead={activeLead}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        onLeadChange={setActive}
      />

      <AddLeadDialog open={addDialogOpen} onOpenChange={setAddDialogOpen} />
    </>
  );
}

/** A column header that sorts, and says which way it is sorting. */
function SortHead({
  label,
  column,
  sort,
  onSort,
}: {
  label: string;
  column: SortKey;
  sort: { key: SortKey; desc: boolean };
  onSort: (next: { key: SortKey; desc: boolean }) => void;
}) {
  const on = sort.key === column;
  return (
    <TableHead className="whitespace-nowrap">
      <button
        type="button"
        // Announced, not just drawn: a header that only shows an arrow tells a
        // screen reader nothing about the order it has just applied.
        aria-sort={on ? (sort.desc ? "descending" : "ascending") : "none"}
        onClick={() => onSort({ key: column, desc: on ? !sort.desc : false })}
        className="-ml-1 inline-flex items-center gap-1 rounded px-1 py-0.5 font-semibold hover:text-foreground"
      >
        {label}
        {on ? (
          sort.desc ? (
            <ArrowDown className="h-3 w-3" aria-hidden />
          ) : (
            <ArrowUp className="h-3 w-3" aria-hidden />
          )
        ) : (
          <ArrowUp className="h-3 w-3 opacity-25" aria-hidden />
        )}
      </button>
    </TableHead>
  );
}

function AddLeadDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { targetStoreId, storeLabel, pickedStoreId, setPickedStoreId } =
    useStoreScope();
  const createLead = useCreateLead();
  const [customer, setCustomer] = useState("");
  const [phone, setPhone] = useState("");
  const [source, setSource] = useState<LeadSource | "">("");
  const [interest, setInterest] = useState("");
  const [remark, setRemark] = useState("");
  const [address, setAddress] = useState("");
  const [birthday, setBirthday] = useState("");
  const [anniversary, setAnniversary] = useState("");
  // Inline validation errors, keyed by field. Cleared per-field on change.
  const [errors, setErrors] = useState<Record<string, string>>({});

  function clearError(field: string) {
    setErrors((prev) => (prev[field] ? { ...prev, [field]: "" } : prev));
  }

  function reset() {
    setCustomer("");
    setPhone("");
    setSource("");
    setInterest("");
    setRemark("");
    setAddress("");
    setBirthday("");
    setAnniversary("");
    setErrors({});
  }

  function save() {
    if (!targetStoreId) {
      toast.error("Select a store to capture this lead against.");
      return;
    }
    // Validate all required fields up front so every offending field shows
    // its own inline message; the toast is just a summary.
    const next: Record<string, string> = {};
    if (!customer.trim()) next.customer = "Customer name is required.";
    // A name must actually be a name — reject a phone number / id typed here.
    else if (!/\p{L}/u.test(customer)) next.customer = "Enter a real name (letters, not just a number).";
    // Phone is mandatory (Round-2) and must be a valid Indian mobile — the
    // backend now enforces @IsIndianMobile, so block/normalise client-side.
    const normalizedPhone = normalizeIndianMobile(phone);
    if (!phone.trim()) next.phone = "Phone number is required to save a lead.";
    else if (!normalizedPhone) next.phone = "Enter a valid 10-digit mobile number.";
    if (!source) next.source = "Lead source is required.";
    if (!interest.trim()) next.interest = "Add what the lead is interested in.";
    if (Object.keys(next).length > 0) {
      setErrors(next);
      toast.error("Please fill in the required fields.");
      return;
    }
    createLead.mutate(
      {
        storeId: targetStoreId,
        customerName: customer.trim(),
        // Validated non-null just above; send the canonical 10-digit value.
        phone: normalizedPhone as string,
        // Validated non-empty just above; narrow away the "" union member.
        source: source as LeadSource,
        interest: interest.trim(),
        remark: remark.trim() || undefined,
        address: address.trim() || undefined,
        birthday: birthday || undefined,
        anniversary: anniversary || undefined,
      },
      {
        onSuccess: () => {
          toast.success("Lead captured");
          reset();
          onOpenChange(false);
        },
        onError: (err) => toast.error(apiErrorMessage(err, "Could not save lead.")),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add lead</DialogTitle>
          <DialogDescription>
            New leads are captured against {storeLabel}.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <StoreScopeField value={pickedStoreId} onChange={setPickedStoreId} />

          <div className="grid gap-1.5">
            <Label htmlFor="cust">
              Customer name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="cust"
              placeholder="e.g. Priya Sharma"
              value={customer}
              onChange={(e) => {
                setCustomer(e.target.value);
                clearError("customer");
              }}
            />
            {errors.customer ? (
              <p className="mt-1 text-xs text-destructive">{errors.customer}</p>
            ) : null}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="phone">
              Phone <span className="text-destructive">*</span>
            </Label>
            <Input
              id="phone"
              placeholder="10-digit mobile"
              inputMode="numeric"
              maxLength={10}
              value={phone}
              aria-invalid={!!errors.phone}
              onChange={(e) => {
                setPhone(phoneInputValue(e.target.value));
                clearError("phone");
              }}
            />
            {errors.phone ? (
              <p className="mt-1 text-xs text-destructive">{errors.phone}</p>
            ) : null}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="source">
              Source <span className="text-destructive">*</span>
            </Label>
            <Select
              value={source}
              onValueChange={(v) => {
                setSource(v as LeadSource);
                clearError("source");
              }}
            >
              <SelectTrigger id="source" aria-required>
                <SelectValue placeholder="Where did this lead come from?" />
              </SelectTrigger>
              <SelectContent>
                {LEAD_SOURCE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.source ? (
              <p className="mt-1 text-xs text-destructive">{errors.source}</p>
            ) : null}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="interest">
              Interest / what they want <span className="text-destructive">*</span>
            </Label>
            <Input
              id="interest"
              /*
               * Neutral on purpose. This field is on the universal lead form,
               * which a clinic and a mill both see; the previous example read
               * "Bridal necklace set". A placeholder is user-visible copy, so a
               * jewellery example here is the same leak as a jewellery label.
               */
              placeholder="What are they asking about?"
              value={interest}
              aria-invalid={!!errors.interest}
              onChange={(e) => {
                setInterest(e.target.value);
                clearError("interest");
              }}
            />
            {errors.interest ? (
              <p className="mt-1 text-xs text-destructive">{errors.interest}</p>
            ) : null}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="address">Address</Label>
            <Input
              id="address"
              placeholder="Street, area, city"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="birthday">Birthday</Label>
              <Input
                id="birthday"
                type="date"
                value={birthday}
                onChange={(e) => setBirthday(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="anniversary">Anniversary</Label>
              <Input
                id="anniversary"
                type="date"
                value={anniversary}
                onChange={(e) => setAnniversary(e.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="remark">Remarks</Label>
            <Textarea
              id="remark"
              placeholder="Any context — budget, occasion, preferences…"
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={createLead.isPending}>
            {createLead.isPending ? "Saving…" : "Save lead"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
