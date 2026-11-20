"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Inbox, Send, ShieldCheck } from "lucide-react";

import { SectionHeader } from "@/components/section/section-header";
import { NewRequestDialog } from "@/components/requests/new-request-dialog";
import { RequestDetailDialog } from "@/components/requests/request-detail-dialog";
import {
  RequestPriorityBadge,
  RequestStatusBadge,
} from "@/components/requests/request-badges";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatINR } from "@/lib/format";
import { getNavItem } from "@/lib/navigation";
import { ROLE_RANK } from "@/lib/types";
import { useSession } from "@/store/use-session";
import {
  useSpecialRequests,
  type RequestScope,
} from "@/lib/queries/special-requests";

function prettyDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
  });
}

/**
 * Branch Requests — a branch asking someone above it for a decision.
 *
 * Two audiences on one screen, split by tab rather than by route:
 *  - **To decide** is the approver queue, filtered server-side to requests this
 *    person can actually act on (the escalation ladder, minus their own).
 *  - **My requests** is what the user raised and where each one got to.
 *
 * A salesperson sees only the second; the server enforces that regardless.
 */
export default function RequestsPage() {
  // `useSearchParams` in a client component forces the page out of static
  // prerendering unless it sits under a Suspense boundary — the Next docs are
  // explicit that a production build fails otherwise. The header renders
  // immediately; only the deep-link-aware body waits.
  return (
    <Suspense fallback={<RequestsFallback />}>
      <RequestsView />
    </Suspense>
  );
}

function RequestsFallback() {
  const nav = getNavItem("requests");
  return (
    <div className="space-y-6">
      <SectionHeader title={nav?.title ?? "Branch Requests"} purpose={nav?.purpose ?? ""} />
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-12 rounded-lg" />
        ))}
      </div>
    </div>
  );
}

function RequestsView() {
  const nav = getNavItem("requests");
  const { role } = useSession();
  const isApprover = ROLE_RANK[role] >= ROLE_RANK.store_manager;

  const params = useSearchParams();
  // Notifications deep-link straight to a request: /requests?open=<id>.
  const deepLinked = params.get("open");

  const [tab, setTab] = useState<RequestScope>(isApprover ? "inbox" : "mine");
  const [newOpen, setNewOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);

  const openId = activeId ?? deepLinked;

  return (
    <div className="space-y-6">
      <SectionHeader
        title={nav?.title ?? "Branch Requests"}
        purpose={nav?.purpose ?? ""}
        primaryAction={nav?.primaryAction}
        onPrimaryAction={() => setNewOpen(true)}
      />

      <Tabs value={tab} onValueChange={(v) => setTab(v as RequestScope)}>
        <TabsList>
          {isApprover ? (
            <TabsTrigger value="inbox">
              <Inbox className="mr-1.5 h-3.5 w-3.5" />
              To decide
            </TabsTrigger>
          ) : null}
          <TabsTrigger value="mine">
            <Send className="mr-1.5 h-3.5 w-3.5" />
            My requests
          </TabsTrigger>
          {isApprover ? (
            <TabsTrigger value="all">
              <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
              All
            </TabsTrigger>
          ) : null}
        </TabsList>

        {(["inbox", "mine", "all"] as RequestScope[]).map((scope) => (
          <TabsContent key={scope} value={scope} className="mt-4">
            <RequestTable scope={scope} onOpen={setActiveId} />
          </TabsContent>
        ))}
      </Tabs>

      <NewRequestDialog open={newOpen} onOpenChange={setNewOpen} />
      <RequestDetailDialog
        id={openId}
        open={!!openId}
        onOpenChange={(o) => {
          if (!o) setActiveId(null);
        }}
      />
    </div>
  );
}

function RequestTable({
  scope,
  onOpen,
}: {
  scope: RequestScope;
  onOpen: (id: string) => void;
}) {
  const { data, isLoading, isError, refetch } = useSpecialRequests({ scope });
  const rows = data ?? [];

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-12 rounded-lg" />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="mx-auto max-w-md rounded-lg border bg-muted/30 p-4 text-center">
        <p className="text-sm font-medium">Couldn&apos;t load requests.</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={() => refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={scope === "inbox" ? Inbox : Send}
        title={
          scope === "inbox"
            ? "Nothing waiting on you"
            : scope === "mine"
              ? "You haven't raised any requests"
              : "No requests yet"
        }
        description={
          scope === "inbox"
            ? "Requests your branches raise will land here for a decision."
            : "Ask your manager, area office or head office for a decision — a diamond rate, a price override, a transfer."
        }
      />
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Ref</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Request</TableHead>
            <TableHead>Branch</TableHead>
            <TableHead className="text-right">Value</TableHead>
            <TableHead>With</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Raised</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow
              key={r.id}
              className="cursor-pointer"
              onClick={() => onOpen(r.id)}
            >
              <TableCell className="num font-medium">{r.ref}</TableCell>
              <TableCell>
                <Badge variant="outline">{r.kindLabel}</Badge>
              </TableCell>
              <TableCell className="max-w-[18rem]">
                <div className="flex items-center gap-1.5">
                  <span className="truncate">{r.title}</span>
                  <RequestPriorityBadge priority={r.priority} />
                  {r.overdue ? <Badge variant="destructive">Overdue</Badge> : null}
                </div>
                {r.kind === "diamond_rate" && r.requestedRatePerCarat != null ? (
                  <p className="num text-xs text-muted-foreground">
                    {r.diamondSpec} · asking {formatINR(r.requestedRatePerCarat)}/ct
                    {r.currentRatePerCarat != null
                      ? ` (now ${formatINR(r.currentRatePerCarat)})`
                      : ""}
                  </p>
                ) : null}
              </TableCell>
              <TableCell className="text-muted-foreground">{r.storeName}</TableCell>
              <TableCell className="num text-right">
                {r.amount != null ? formatINR(r.amount) : "—"}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {r.status === "approved" || r.status === "rejected"
                  ? (r.decidedBy ?? "—")
                  : r.requiredRoleLabel}
              </TableCell>
              <TableCell>
                <RequestStatusBadge status={r.status} />
              </TableCell>
              <TableCell className="num text-right text-muted-foreground">
                {prettyDate(r.createdAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
