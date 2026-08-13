"use client";

import * as React from "react";
import { ArrowLeftRight, ArrowRight } from "lucide-react";

import { SectionHeader } from "@/components/section/section-header";
import { CreateTransferDialog } from "@/components/inventory/create-transfer-dialog";
import { TransferDetailDialog } from "@/components/inventory/transfer-detail-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { getNavItem } from "@/lib/navigation";
import { ROLE_LABELS } from "@/lib/types";
import { useSession } from "@/store/use-session";
import {
  TRANSFER_STATUS_LABELS,
  useStockTransfers,
  type TransferDirection,
  type TransferStatus,
} from "@/lib/queries/stock-transfers";
import { STATUS_VARIANT } from "./status-variant";

function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  return new Date(s).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const STATUS_OPTIONS: (TransferStatus | "all")[] = [
  "all",
  "draft",
  "submitted",
  "ho_approved",
  "dispatched",
  "received",
  "acknowledged",
  "rejected",
  "cancelled",
];

export default function StockTransfersPage() {
  const nav = getNavItem("stock-transfers");
  const { role, currentStore } = useSession();
  const isHeadOffice = role === "head_office";
  // Only store managers create transfers (source store); HO approves, others read.
  const canCreate = role === "store_manager";

  const [status, setStatus] = React.useState<TransferStatus | "all">("all");
  const [direction, setDirection] = React.useState<TransferDirection>("all");
  const [createOpen, setCreateOpen] = React.useState(false);
  const [detailId, setDetailId] = React.useState<string | null>(null);

  const { data: rows = [], isLoading, isError, refetch } = useStockTransfers({
    status,
    direction,
  });

  return (
    <>
      <SectionHeader
        title={nav?.title ?? "Stock Transfers"}
        purpose={nav?.purpose ?? ""}
        primaryAction={canCreate ? "New Transfer" : undefined}
        onPrimaryAction={canCreate ? () => setCreateOpen(true) : undefined}
      />

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle>Transfers</CardTitle>
              <CardDescription>
                {isHeadOffice
                  ? "Inter-store movements across all branches. Approve or reject submitted requests."
                  : `Stock moving in and out of ${currentStore.name}.`}
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              {/* Direction is meaningful for a store (in vs out); HO sees all. */}
              {!isHeadOffice ? (
                <Select
                  value={direction}
                  onValueChange={(v) => setDirection(v as TransferDirection)}
                >
                  <SelectTrigger className="h-9 w-[130px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">In &amp; out</SelectItem>
                    <SelectItem value="in">Incoming</SelectItem>
                    <SelectItem value="out">Outgoing</SelectItem>
                  </SelectContent>
                </Select>
              ) : null}
              <Select
                value={status}
                onValueChange={(v) => setStatus(v as TransferStatus | "all")}
              >
                <SelectTrigger className="h-9 w-[150px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s === "all" ? "All statuses" : TRANSFER_STATUS_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-11 w-full" />
              ))}
            </div>
          ) : isError ? (
            <div className="rounded-lg border bg-muted/40 p-6 text-center text-sm text-muted-foreground">
              <p>Couldn&apos;t load transfers.</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => refetch()}
              >
                Retry
              </Button>
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={ArrowLeftRight}
              title="No transfers"
              description={
                canCreate
                  ? "Move pieces to another branch — create a transfer, then submit it for Head-Office approval."
                  : "Inter-store transfers will appear here once raised."
              }
              actionLabel={canCreate ? "New Transfer" : undefined}
              onAction={canCreate ? () => setCreateOpen(true) : undefined}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ref</TableHead>
                  <TableHead>Route</TableHead>
                  <TableHead className="text-right">Pieces</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Requested by</TableHead>
                  <TableHead>Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow
                    key={r.id}
                    className="cursor-pointer"
                    onClick={() => setDetailId(r.id)}
                  >
                    <TableCell className="font-medium">
                      <span className="num">{r.ref}</span>
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5 text-sm">
                        {r.fromStoreName}
                        <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                        {r.toStoreName}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="num">{r.itemCount}</span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[r.status]}>
                        {TRANSFER_STATUS_LABELS[r.status]}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {r.requestedBy ? (
                        <>
                          <div>{r.requestedBy.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {ROLE_LABELS[r.requestedBy.role] ??
                              r.requestedBy.roleLabel}
                          </div>
                        </>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {fmtDate(r.updatedAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {canCreate ? (
        <CreateTransferDialog open={createOpen} onOpenChange={setCreateOpen} />
      ) : null}

      <TransferDetailDialog
        transferId={detailId}
        onOpenChange={(o) => {
          if (!o) setDetailId(null);
        }}
      />
    </>
  );
}
