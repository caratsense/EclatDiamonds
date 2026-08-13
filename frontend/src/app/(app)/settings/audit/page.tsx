"use client";

import { useState } from "react";
import Link from "next/link";
import { Download, Lock, ScrollText } from "lucide-react";
import * as XLSX from "xlsx";
import { toast } from "sonner";

import { SectionHeader } from "@/components/section/section-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  exportAudit,
  useAuditLog,
  type AuditEntry,
} from "@/lib/queries/audit";
import { ROLE_LABELS, ROLE_RANK } from "@/lib/types";
import { useSession } from "@/store/use-session";

const PAGE_SIZE = 50;

/**
 * Deep-link map: entityType → the module list page for context. The app is
 * list-driven with few dynamic detail routes, so we link to the module page,
 * not an invented /:id route. Types with no matching route (e.g. Sale) fall
 * through to plain text.
 */
const ENTITY_ROUTES: Record<string, string> = {
  Lead: "/crm",
  Quote: "/quotation",
  Payment: "/payments",
  Return: "/returns",
  DiscountRequest: "/discounts",
  StockItem: "/inventory",
  StockTransfer: "/stock-transfers",
  Task: "/dashboards",
  Handoff: "/dashboards",
  Store: "/settings/stores",
  User: "/settings/team",
};

/** Sensitive actions worth filtering by. "" = all actions. */
const ACTION_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "All actions" },
  { value: "discount.approve", label: "Discount approved" },
  { value: "discount.reject", label: "Discount rejected" },
  { value: "return.approve", label: "Return approved" },
  { value: "return.reject", label: "Return rejected" },
  { value: "leave.approve", label: "Leave approved" },
  { value: "leave.reject", label: "Leave rejected" },
  { value: "user.role_change", label: "Role changed" },
  { value: "target.set", label: "Target set" },
  { value: "store.create", label: "Store created" },
];

/** Past-tense verbs so "discount.approve" reads "Discount approved". */
const VERB_PAST: Record<string, string> = {
  approve: "approved",
  reject: "rejected",
  create: "created",
  update: "updated",
  delete: "deleted",
  assign: "assigned",
  reassign: "reassigned",
  cancel: "cancelled",
  settle: "settled",
  change: "changed",
  reset: "reset",
  login: "signed in",
  logout: "signed out",
};

/** "discount.approve" → "Discount approved"; degrades gracefully. */
function humanizeAction(action: string): string {
  const parts = action.split(/[._]/).filter(Boolean);
  if (parts.length === 0) return action;
  const [entity, ...rest] = parts;
  const entityLabel = entity.charAt(0).toUpperCase() + entity.slice(1);
  const verbKey = rest.join("_");
  const verbLabel =
    VERB_PAST[verbKey] ??
    VERB_PAST[rest[rest.length - 1] ?? ""] ??
    rest.join(" ");
  return `${entityLabel} ${verbLabel}`.trim();
}

/** Compact relative time, e.g. "3h ago". */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Math.round((Date.now() - then) / 1000);
  if (diff < 45) return "just now";
  const mins = Math.round(diff / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(diff / 3600);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(diff / 86400);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

/** Absolute timestamp for the tooltip / second line. */
function absoluteTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Role label, but only when it isn't already the actor's name (avoids dupes). */
function roleLabel(entry: AuditEntry): string {
  return ROLE_LABELS[entry.actorRole] ?? entry.actorRole;
}

function storeLabel(entry: AuditEntry): string {
  return entry.storeName ?? entry.storeId ?? "—";
}

export default function AuditLogPage() {
  const role = useSession((s) => s.role);
  const stores = useSession((s) => s.stores);
  const canView = ROLE_RANK[role] >= ROLE_RANK.store_manager;
  // Only head office may filter across stores; a store manager is locked to
  // their own store server-side, so the picker is pointless (and misleading).
  const canFilterStore = role === "head_office";
  const realStores = stores.filter((s) => !s.isAggregate);

  const [action, setAction] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [storeId, setStoreId] = useState("");
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<AuditEntry | null>(null);
  const [exporting, setExporting] = useState(false);

  const filters = {
    action: action || undefined,
    from: from || undefined,
    to: to || undefined,
    storeId: storeId || undefined,
  };

  const { data, isLoading, isError, refetch, isFetching } = useAuditLog({
    ...filters,
    page,
    pageSize: PAGE_SIZE,
  });

  // store_manager+ only. Nav hides this for other roles; guard the page too so a
  // direct URL or a demo role switch can't reach it.
  if (!canView) {
    return (
      <>
        <SectionHeader
          title="Audit Log"
          purpose="Who did what across the business."
        />
        <div className="mx-auto max-w-md rounded-xl border bg-muted/30 p-8 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-muted">
            <Lock className="h-5 w-5 text-muted-foreground" />
          </div>
          <p className="text-sm font-medium">Store Manager &amp; above only</p>
          <p className="mt-1 text-xs text-muted-foreground">
            The audit log records sensitive actions and is limited to Store
            Managers and Head Office. Switch to a higher-level view to continue.
          </p>
        </div>
      </>
    );
  }

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasFilters = Boolean(action || from || to || storeId);

  function resetToFirstPage() {
    setPage(1);
  }

  async function handleExport() {
    setExporting(true);
    try {
      const res = await exportAudit(filters);
      const data = res.items.map((e) => ({
        "When (ISO)": e.createdAt,
        "When (readable)": absoluteTime(e.createdAt),
        Actor: e.actorName,
        Role: roleLabel(e),
        Action: humanizeAction(e.action),
        Summary: e.summary,
        "Entity Type": e.entityType,
        "Entity Id": e.entityId,
        Store: storeLabel(e),
      }));
      const ws = XLSX.utils.json_to_sheet(data);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Audit");
      XLSX.writeFile(wb, `audit-${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch {
      toast.error("Couldn't export the audit log. Please try again.");
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <SectionHeader
        title="Audit Log"
        purpose="Who did what across the business."
      />

      {/* Filters */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
        <div className="grid gap-1.5">
          <Label htmlFor="audit-action">Action</Label>
          <Select
            value={action || "all"}
            onValueChange={(v) => {
              setAction(v === "all" ? "" : v);
              resetToFirstPage();
            }}
          >
            <SelectTrigger id="audit-action" className="w-[220px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ACTION_OPTIONS.map((opt) => (
                // Radix Select needs a non-empty value; map "" to a sentinel.
                <SelectItem key={opt.value} value={opt.value || "all"}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {canFilterStore ? (
          <div className="grid gap-1.5">
            <Label htmlFor="audit-store">Store</Label>
            <Select
              value={storeId || "all"}
              onValueChange={(v) => {
                setStoreId(v === "all" ? "" : v);
                resetToFirstPage();
              }}
            >
              <SelectTrigger id="audit-store" className="w-[190px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All stores</SelectItem>
                {realStores.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <div className="grid gap-1.5">
          <Label htmlFor="audit-from">From</Label>
          <Input
            id="audit-from"
            type="date"
            className="w-[170px]"
            value={from}
            max={to || undefined}
            onChange={(e) => {
              setFrom(e.target.value);
              resetToFirstPage();
            }}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="audit-to">To</Label>
          <Input
            id="audit-to"
            type="date"
            className="w-[170px]"
            value={to}
            min={from || undefined}
            onChange={(e) => {
              setTo(e.target.value);
              resetToFirstPage();
            }}
          />
        </div>
        {hasFilters ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setAction("");
              setFrom("");
              setTo("");
              setStoreId("");
              resetToFirstPage();
            }}
          >
            Clear filters
          </Button>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          className="sm:ml-auto"
          onClick={handleExport}
          disabled={exporting || total === 0}
        >
          <Download className="h-4 w-4" />
          {exporting ? "Exporting…" : "Export to Excel"}
        </Button>
      </div>

      <div className="rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[170px]">When</TableHead>
              <TableHead className="w-[200px]">Actor</TableHead>
              <TableHead className="w-[190px]">Action</TableHead>
              <TableHead>Summary</TableHead>
              <TableHead className="w-[140px]">Store</TableHead>
              <TableHead className="w-[80px] text-right">Detail</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={6} className="py-3">
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : isError ? (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center">
                  <div className="mx-auto max-w-sm rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
                    <p>Couldn&apos;t load the audit log.</p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-3"
                      onClick={() => refetch()}
                    >
                      Retry
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ) : items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-12 text-center">
                  <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-muted">
                    <ScrollText className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <p className="text-sm font-medium">No entries</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Nothing matches these filters yet.
                  </p>
                </TableCell>
              </TableRow>
            ) : (
              items.map((e) => {
                const rl = roleLabel(e);
                // Don't repeat the role when the actor is literally named after it
                // (e.g. the "Head Office" user with the head_office role).
                const showRoleBadge = e.actorName ? rl !== e.actorName : false;
                return (
                  <TableRow
                    key={e.id}
                    className="cursor-pointer"
                    onClick={() => setDetail(e)}
                  >
                    <TableCell className="align-top">
                      <div className="text-sm">{relativeTime(e.createdAt)}</div>
                      <div className="num text-xs text-muted-foreground">
                        {absoluteTime(e.createdAt)}
                      </div>
                    </TableCell>
                    <TableCell className="align-top">
                      <div className="text-sm font-medium">
                        {e.actorName || rl}
                      </div>
                      {showRoleBadge ? (
                        <Badge variant="outline" className="mt-0.5">
                          {rl}
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell className="align-top">
                      <span className="text-sm">{humanizeAction(e.action)}</span>
                    </TableCell>
                    <TableCell className="align-top text-sm text-muted-foreground">
                      {e.summary}
                    </TableCell>
                    <TableCell className="align-top text-sm text-muted-foreground">
                      {storeLabel(e)}
                    </TableCell>
                    <TableCell className="align-top text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          setDetail(e);
                        }}
                      >
                        View
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {total > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 py-3">
          <p className="text-sm text-muted-foreground">
            Page <span className="num">{page}</span> of{" "}
            <span className="num">{lastPage}</span> ·{" "}
            <span className="num">{total}</span> entr
            {total === 1 ? "y" : "ies"}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1 || isFetching}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= lastPage || isFetching}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}

      <AuditDetailDialog entry={detail} onOpenChange={() => setDetail(null)} />
    </>
  );
}

/** A read-only definition row for the detail dialog. */
function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-3 py-1.5">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function AuditDetailDialog({
  entry,
  onOpenChange,
}: {
  entry: AuditEntry | null;
  onOpenChange: (open: boolean) => void;
}) {
  const route = entry ? ENTITY_ROUTES[entry.entityType] : undefined;
  const meta = entry?.metadata ?? null;
  const metaEntries = meta ? Object.entries(meta) : [];

  return (
    <Dialog open={!!entry} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Audit entry</DialogTitle>
          <DialogDescription>
            {entry ? humanizeAction(entry.action) : ""}
          </DialogDescription>
        </DialogHeader>
        {entry ? (
          <dl className="divide-y">
            <DetailRow label="When">
              <span className="num">{absoluteTime(entry.createdAt)}</span>
              <span className="ml-2 text-xs text-muted-foreground">
                {relativeTime(entry.createdAt)}
              </span>
            </DetailRow>
            <DetailRow label="Actor">
              {entry.actorName || "—"}
              <Badge variant="outline" className="ml-2">
                {roleLabel(entry)}
              </Badge>
            </DetailRow>
            <DetailRow label="Action">
              {humanizeAction(entry.action)}
              <code className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs">
                {entry.action}
              </code>
            </DetailRow>
            <DetailRow label="Store">{storeLabel(entry)}</DetailRow>
            <DetailRow label="Entity">
              {route ? (
                <Link
                  href={route}
                  className="text-[var(--gold)] underline underline-offset-2 hover:opacity-80"
                >
                  {entry.entityType}
                </Link>
              ) : (
                entry.entityType
              )}
              {entry.entityId ? (
                <span className="ml-2 text-xs text-muted-foreground num">
                  {entry.entityId}
                </span>
              ) : null}
            </DetailRow>
            <DetailRow label="Summary">{entry.summary || "—"}</DetailRow>
            {metaEntries.length > 0 ? (
              <div className="py-1.5">
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                  Details
                </p>
                <dl className="rounded-lg border bg-muted/30 p-3">
                  {metaEntries.map(([k, v]) => {
                    const nested = v !== null && typeof v === "object";
                    return (
                      <div
                        key={k}
                        className="grid grid-cols-[140px_1fr] gap-3 py-1 text-sm"
                      >
                        <dt className="text-xs text-muted-foreground">{k}</dt>
                        <dd className="min-w-0 break-words">
                          {nested ? (
                            <pre className="max-h-40 overflow-auto rounded bg-background p-2 text-xs">
                              {JSON.stringify(v, null, 2)}
                            </pre>
                          ) : (
                            String(v)
                          )}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              </div>
            ) : null}
          </dl>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
