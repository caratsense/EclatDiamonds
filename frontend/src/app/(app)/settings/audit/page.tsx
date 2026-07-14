"use client";

import { useState } from "react";
import { Lock, ScrollText } from "lucide-react";

import { SectionHeader } from "@/components/section/section-header";
import { Badge } from "@/components/ui/badge";
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
import { useAuditLog } from "@/lib/queries/audit";
import { ROLE_LABELS, ROLE_RANK } from "@/lib/types";
import { useSession } from "@/store/use-session";

const PAGE_SIZE = 50;

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

export default function AuditLogPage() {
  const role = useSession((s) => s.role);
  const canView = ROLE_RANK[role] >= ROLE_RANK.area_manager;

  const [action, setAction] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);

  const { data, isLoading, isError, refetch, isFetching } = useAuditLog({
    action: action || undefined,
    from: from || undefined,
    to: to || undefined,
    page,
    pageSize: PAGE_SIZE,
  });

  // Area-manager+ only. Nav hides this for other roles; guard the page too so a
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
          <p className="text-sm font-medium">Area Manager &amp; above only</p>
          <p className="mt-1 text-xs text-muted-foreground">
            The audit log records sensitive actions and is limited to Area
            Managers and Head Office. Switch to a higher-level view to continue.
          </p>
        </div>
      </>
    );
  }

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function resetToFirstPage() {
    setPage(1);
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
        {action || from || to ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setAction("");
              setFrom("");
              setTo("");
              resetToFirstPage();
            }}
          >
            Clear filters
          </Button>
        ) : null}
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
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={5} className="py-3">
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : isError ? (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center">
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
                <TableCell colSpan={5} className="py-12 text-center">
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
              items.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="align-top">
                    <div className="text-sm">{relativeTime(e.createdAt)}</div>
                    <div className="num text-xs text-muted-foreground">
                      {absoluteTime(e.createdAt)}
                    </div>
                  </TableCell>
                  <TableCell className="align-top">
                    <div className="text-sm font-medium">{e.actorName}</div>
                    <Badge variant="outline" className="mt-0.5">
                      {ROLE_LABELS[e.actorRole] ?? e.actorRole}
                    </Badge>
                  </TableCell>
                  <TableCell className="align-top">
                    <span className="text-sm">{humanizeAction(e.action)}</span>
                  </TableCell>
                  <TableCell className="align-top text-sm text-muted-foreground">
                    {e.summary}
                  </TableCell>
                  <TableCell className="align-top text-sm text-muted-foreground">
                    {e.storeId}
                  </TableCell>
                </TableRow>
              ))
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
    </>
  );
}
