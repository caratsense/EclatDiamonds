"use client";

import { useState } from "react";
import { KanbanSquare, Table as TableIcon, Users } from "lucide-react";
import { toast } from "sonner";

import { LeadCard } from "@/components/crm/lead-card";
import { LeadDetailDialog } from "@/components/crm/lead-detail-dialog";
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
  LEAD_SOURCE_LABELS,
  LEAD_SOURCE_OPTIONS,
  LEAD_STAGES,
  type Lead,
  type LeadSource,
  type LeadStage,
} from "@/lib/mock/crm";
import {
  useLeads,
  useMoveLeadStage,
  useCreateLead,
  type LeadOutcomeFilter,
} from "@/lib/queries/leads";
import { useSession } from "@/store/use-session";

const nav = getNavItem("crm")!;

/** Outcome facet tabs applied to the list view. */
const OUTCOME_TABS: { value: LeadOutcomeFilter; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
  { value: "all", label: "All" },
];

export default function CrmPage() {
  const { currentStore, role } = useSession();
  // Date-range filter (inclusive; API returns latest-first).
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
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
  } = useLeads({ from: from || undefined, to: to || undefined, outcome: "all" });
  const moveStage = useMoveLeadStage();
  const [view, setView] = useState<"board" | "list">("board");
  const [active, setActive] = useState<Lead | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);

  // Source facet applies to both views.
  const sourceScoped =
    sourceFilter === "all"
      ? leads
      : leads.filter((l) => l.source === sourceFilter);
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
      const label = LEAD_STAGES.find((s) => s.id === stage)?.label;
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
          onError: () => toast.error("Could not move lead."),
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

  const openCreateDialog = () => setAddOpen(true);

  return (
    <>
      <SectionHeader
        title={nav.title}
        purpose={nav.purpose}
        primaryAction={nav.primaryAction}
        onPrimaryAction={openCreateDialog}
      />

      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <p className="mb-1.5 text-sm text-muted-foreground">{scopeNote}</p>
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
                {LEAD_SOURCE_OPTIONS.map((opt) => (
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
        <Tabs value={view} onValueChange={(v) => setView(v as "board" | "list")}>
          <TabsList>
            <TabsTrigger value="board">
              <KanbanSquare className="mr-1.5 h-4 w-4" /> Board
            </TabsTrigger>
            <TabsTrigger value="list">
              <TableIcon className="mr-1.5 h-4 w-4" /> List
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-3">
          {LEAD_STAGES.map((s) => (
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
        from ||
        to ? (
          <EmptyState
            icon={Users}
            title="No leads match these filters"
            description="Adjust the outcome, source or date range to see more."
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
        <div className="grid gap-4 md:grid-cols-3">
          {LEAD_STAGES.map((stage) => {
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
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Lead</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Location / Area</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Stage</TableHead>
                <TableHead>Salesperson</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {listLeads.map((lead) => (
                <TableRow
                  key={lead.id}
                  className="cursor-pointer"
                  onClick={() => openLead(lead)}
                >
                  <TableCell className="font-medium">{lead.ref}</TableCell>
                  <TableCell>
                    <div>{lead.customer}</div>
                    <div className="text-xs text-muted-foreground">
                      {lead.interest}
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="text-xs font-medium">
                      {lead.location || lead.address || "—"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {LEAD_SOURCE_LABELS[lead.source]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {LEAD_STAGES.find((s) => s.id === lead.stage)?.label}
                  </TableCell>
                  <TableCell>{lead.assignedRep}</TableCell>
                  <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                    <Button
                      variant="ghost"
                      size="sm"
                      title="WhatsApp Re-engagement"
                      onClick={() => {
                        const cleanPhone = lead.phone.replace(/[^0-9]/g, "");
                        const waUrl = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(
                          `Hello ${lead.customer}, following up regarding your enquiry for ${lead.interest || "jewellery"}.`
                        )}`;
                        window.open(waUrl, "_blank");
                      }}
                    >
                      WhatsApp
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>

          </Table>
        </div>
      )}

      <LeadDetailDialog
        lead={activeLead}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        onLeadChange={setActive}
      />

      <AddLeadDialog open={addOpen} onOpenChange={setAddOpen} />
    </>
  );
}

function AddLeadDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { currentStore } = useSession();
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

  // Aggregate ("all") scope has no concrete store to write to — fall back
  // to the first real store id; broad roles normally pick a store first.
  const targetStoreId = currentStore.isAggregate ? "surat-main" : currentStore.id;

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
    // Validate all required fields up front so every offending field shows
    // its own inline message; the toast is just a summary.
    const next: Record<string, string> = {};
    if (!customer.trim()) next.customer = "Customer name is required.";
    // Phone is mandatory (Round-2) — block client-side before the call.
    if (!phone.trim()) next.phone = "Phone number is required to save a lead.";
    if (!source) next.source = "Lead source is required.";
    if (Object.keys(next).length > 0) {
      setErrors(next);
      toast.error("Please fill in the required fields.");
      return;
    }
    createLead.mutate(
      {
        storeId: targetStoreId,
        customerName: customer.trim(),
        phone: phone.trim(),
        // Validated non-empty just above; narrow away the "" union member.
        source: source as LeadSource,
        interest: interest.trim() || undefined,
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
        onError: () => toast.error("Could not save lead."),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add lead</DialogTitle>
          <DialogDescription>
            New leads are captured against{" "}
            {currentStore.isAggregate ? "Surat — Main" : currentStore.name}.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
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
              placeholder="+91 ..."
              value={phone}
              onChange={(e) => {
                setPhone(e.target.value);
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
            <Label htmlFor="interest">Interest / what they want</Label>
            <Input
              id="interest"
              placeholder="e.g. Bridal necklace set"
              value={interest}
              onChange={(e) => setInterest(e.target.value)}
            />
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
