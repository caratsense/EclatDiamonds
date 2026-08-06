"use client";

import { type ReactNode, useState } from "react";
import { Ban, Contact, Search } from "lucide-react";

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
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { PaginationBar } from "@/components/ui/pagination-bar";
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
import { formatINR } from "@/lib/format";
import {
  useParties,
  type PartyRow,
  type PartyTypeName,
} from "@/lib/queries/parties";
import { useDebouncedValue } from "@/lib/queries/search";

const nav = getNavItem("customers")!;

type TypeFilter = PartyTypeName | "all";

const TYPE_OPTIONS: { value: TypeFilter; label: string }[] = [
  { value: "customer", label: "Customers" },
  { value: "supplier", label: "Suppliers" },
  { value: "staff", label: "Staff" },
  { value: "all", label: "All parties" },
];

const TYPE_LABELS: Record<PartyTypeName, string> = {
  customer: "Customer",
  supplier: "Supplier",
  staff: "Staff",
  salesperson: "Salesperson",
  branch: "Branch",
  account: "Account",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** Birthdays/anniversaries — the year is noise, the day + month is the point. */
function fmtDayMonth(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "long" });
}

export default function CustomersPage() {
  const [type, setType] = useState<TypeFilter>("customer");
  const [rawQ, setRawQ] = useState("");
  const q = useDebouncedValue(rawQ, 300);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [active, setActive] = useState<PartyRow | null>(null);

  const { data, isLoading, isError, refetch } = useParties({
    page,
    pageSize,
    q: q.trim() || undefined,
    type,
  });

  const rows = data?.items ?? [];
  const total = data?.total ?? 0;

  return (
    <div>
      <SectionHeader title={nav.title} purpose={nav.purpose} />

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={rawQ}
            onChange={(e) => {
              setRawQ(e.target.value);
              setPage(1);
            }}
            placeholder="Search by name, phone, city, GST…"
            className="pl-9"
          />
        </div>
        <Select
          value={type}
          onValueChange={(v) => {
            setType(v as TypeFilter);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-full sm:w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TYPE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isError ? (
        <div className="rounded-xl border border-dashed bg-muted/20 px-6 py-14 text-center">
          <p className="text-sm text-muted-foreground">
            Couldn&apos;t load customers.
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
      ) : isLoading && rows.length === 0 ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Contact}
          title={q ? "No matches" : "No customers here yet"}
          description={
            q
              ? "No party matches your search in this store."
              : "Customers sync in from billing, or get added when you log a lead or a walk-in. Try switching the store or the filter above."
          }
        />
      ) : (
        <>
          <div className="rounded-xl border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead className="hidden md:table-cell">City</TableHead>
                  <TableHead className="text-right">Bills</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((p) => (
                  <TableRow
                    key={p.id}
                    className="cursor-pointer"
                    onClick={() => setActive(p)}
                  >
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-foreground">
                          {p.name}
                        </span>
                        {p.isBlacklisted ? (
                          <Badge variant="destructive" className="gap-1">
                            <Ban className="h-3 w-3" /> Blacklisted
                          </Badge>
                        ) : null}
                      </div>
                      {p.code ? (
                        <span className="num text-xs text-muted-foreground">
                          {p.code}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="num">{p.phone ?? "—"}</TableCell>
                    <TableCell className="hidden md:table-cell text-muted-foreground">
                      {[p.city, p.state].filter(Boolean).join(", ") || "—"}
                    </TableCell>
                    <TableCell className="num text-right">
                      {p.salesCount}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <PaginationBar
            page={page}
            pageSize={pageSize}
            total={total}
            onPageChange={setPage}
            onPageSizeChange={(s) => {
              setPageSize(s);
              setPage(1);
            }}
          />
        </>
      )}

      <CustomerDetailDialog
        party={active}
        onOpenChange={(open) => !open && setActive(null)}
      />
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium text-foreground">{value}</span>
    </div>
  );
}

function CustomerDetailDialog({
  party,
  onOpenChange,
}: {
  party: PartyRow | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={!!party} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        {party ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {party.name}
                {party.isBlacklisted ? (
                  <Badge variant="destructive" className="gap-1">
                    <Ban className="h-3 w-3" /> Blacklisted
                  </Badge>
                ) : null}
              </DialogTitle>
              <DialogDescription>
                {party.types.length
                  ? party.types.map((t) => TYPE_LABELS[t] ?? t).join(" · ")
                  : "Party"}
                {party.code ? ` · ${party.code}` : ""}
              </DialogDescription>
            </DialogHeader>

            <div className="divide-y">
              <DetailRow label="Phone" value={party.phone ?? "—"} />
              <DetailRow label="WhatsApp" value={party.whatsapp ?? "—"} />
              <DetailRow label="Email" value={party.email ?? "—"} />
              <DetailRow
                label="Address"
                value={
                  [
                    party.addressLine1,
                    party.addressLine2,
                    party.city,
                    party.state,
                    party.pincode,
                  ]
                    .filter(Boolean)
                    .join(", ") || "—"
                }
              />
              <DetailRow label="GSTIN" value={party.gstin ?? "—"} />
              <DetailRow label="Birthday" value={fmtDayMonth(party.birthday)} />
              <DetailRow
                label="Anniversary"
                value={fmtDayMonth(party.anniversary)}
              />
              <DetailRow
                label="Credit limit"
                value={
                  party.creditLimit != null
                    ? formatINR(party.creditLimit)
                    : "—"
                }
              />
              <DetailRow label="Bills on record" value={party.salesCount} />
              <DetailRow label="In system since" value={fmtDate(party.createdAt)} />
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
