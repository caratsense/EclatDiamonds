"use client";

import { type ReactNode, useState } from "react";
import Link from "next/link";
import { Ban, CheckSquare, Contact, Pencil, Search, Square, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { ExcelExportButton } from "@/components/common/excel-export-button";
import { SectionHeader } from "@/components/section/section-header";
import {
  StoreScopeField,
  useStoreScope,
} from "@/components/common/store-scope-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PaginationBar } from "@/components/ui/pagination-bar";
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
  useBulkDeleteParties,
  useCreateParty,
  useParties,
  useRenameParty,
  type BulkDeleteResult,
  type PartyRow,
  type PartyTypeName,
} from "@/lib/queries/parties";
import { useLeadTags } from "@/lib/queries/lead-tags";
import { PartyTagsField } from "@/components/crm/lead-tags-field";
import { useStoreKey } from "@/lib/queries/keys";
import { useDebouncedValue } from "@/lib/queries/search";
import {
  bulkDeleteTone,
  describeBulkDelete,
  describeSelection,
  skippedLines,
} from "@/lib/party-bulk-delete";
import { ROLE_RANK } from "@/lib/types";
import { useResetOn } from "@/lib/use-reset-on";
import { useSession } from "@/store/use-session";
import {
  apiErrorMessage,
  isRealName,
  isValidEmail,
  customerPhoneInputValue,
  normalizeCustomerPhone,
} from "@/lib/utils";

const nav = getNavItem("customers")!;

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
  const [rawQ, setRawQ] = useState("");
  const q = useDebouncedValue(rawQ, 300);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [active, setActive] = useState<PartyRow | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const [tagId, setTagId] = useState<string>("");
  const allTags = useLeadTags();

  const { data, isLoading, isError, refetch } = useParties({
    page,
    pageSize,
    q: q.trim() || undefined,
    type: "customer",
    tagId: tagId || undefined,
  });

  const rows = data?.items ?? [];
  const total = data?.total ?? 0;

  /*
   * Bulk delete is head office's, exactly as the single delete is. Ticking rows
   * is hidden from everyone else rather than shown and then refused by the
   * server — deleting a customer is the only bulk action on this screen, so a
   * checkbox a manager cannot act on is just a dead control.
   */
  const baseRole = useSession((s) => s.baseRole);
  const canBulkDelete = ROLE_RANK[baseRole] >= ROLE_RANK.head_office;
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);

  /*
   * A tick belongs to the rows that were on screen when it was made. Changing
   * the store, the search, the tag or the page replaces those rows, so the
   * selection goes with them — carrying it across would let somebody confirm a
   * delete against a list they can no longer see.
   */
  const storeKey = useStoreKey();
  useResetOn(`${storeKey}|${q}|${tagId}|${page}|${pageSize}`, () => {
    setSelectedIds(new Set());
  });

  const selectedOnPage = rows.filter((p) => selectedIds.has(p.id));
  const allOnPageSelected = rows.length > 0 && selectedOnPage.length === rows.length;

  const toggleOne = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** Ticks this page and only this page — never the other matches. */
  const toggleAllOnPage = () =>
    setSelectedIds(allOnPageSelected ? new Set() : new Set(rows.map((p) => p.id)));

  return (
    <div>
      <SectionHeader
        title={nav.title}
        purpose={nav.purpose}
        primaryAction="Add customer"
        onPrimaryAction={() => setAddOpen(true)}
      />

      <div className="mb-4 flex items-start gap-2">
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
        {(allTags.data ?? []).length ? (
          <select
            aria-label="Filter by tag"
            className="h-9 rounded-md border bg-background px-2 text-sm"
            value={tagId}
            onChange={(e) => {
              setTagId(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All tags</option>
            {(allTags.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        ) : null}
        <ExcelExportButton path="/parties/export.xlsx" fallbackName="customers.xlsx" />
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
                  {canBulkDelete ? (
                    <TableHead className="w-10">
                      <button
                        type="button"
                        onClick={toggleAllOnPage}
                        className="flex items-center justify-center text-muted-foreground hover:text-foreground"
                        title={
                          allOnPageSelected
                            ? "Deselect this page"
                            : "Select everyone on this page"
                        }
                      >
                        {allOnPageSelected ? (
                          <CheckSquare className="h-4 w-4 text-primary" />
                        ) : (
                          <Square className="h-4 w-4" />
                        )}
                      </button>
                    </TableHead>
                  ) : null}
                  <TableHead>Name</TableHead>
                  <TableHead>Phone</TableHead>
                  {/* Tags were on the leads board but nowhere in the customer
                      list (client, 19 Nov), so they get a column of their own
                      rather than a line squeezed under the name. */}
                  <TableHead className="hidden lg:table-cell">Tags</TableHead>
                  <TableHead className="hidden md:table-cell">City</TableHead>
                  <TableHead className="text-right">Bills</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((p) => (
                  <TableRow
                    key={p.id}
                    className={`cursor-pointer ${selectedIds.has(p.id) ? "bg-primary/5" : ""}`}
                    onClick={() => setActive(p)}
                  >
                    {canBulkDelete ? (
                      <TableCell
                        className="w-10"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleOne(p.id);
                        }}
                      >
                        <button
                          type="button"
                          aria-label={`Select ${p.name}`}
                          aria-pressed={selectedIds.has(p.id)}
                          className="flex items-center justify-center text-muted-foreground hover:text-foreground"
                        >
                          {selectedIds.has(p.id) ? (
                            <CheckSquare className="h-4 w-4 text-primary" />
                          ) : (
                            <Square className="h-4 w-4" />
                          )}
                        </button>
                      </TableCell>
                    ) : null}
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {/* The name opens Customer 360; the rest of the row keeps
                            its existing quick-edit dialog, so nothing an existing
                            user relies on changes. */}
                        <Link
                          href={`/customers/${p.id}`}
                          onClick={(e) => e.stopPropagation()}
                          className="font-medium text-foreground hover:underline"
                        >
                          {p.name}
                        </Link>
                        {p.isBlacklisted ? (
                          <Badge variant="destructive" className="gap-1">
                            <Ban className="h-3 w-3" /> Blacklisted
                          </Badge>
                        ) : null}
                      </div>
                      {/* Consistent subtitle on every row: the customer code,
                          or "—" when unknown (e.g. manually-added, not synced). */}
                      <span className="num text-xs text-muted-foreground">
                        {p.code ?? "—"}
                      </span>
                      {/* The tags have their own column from the lg breakpoint
                          up; below it there is no column to put them in, so
                          they stay under the name rather than disappearing. */}
                      {p.tags.length ? (
                        <span className="mt-0.5 flex flex-wrap gap-1 lg:hidden">
                          <TagChips tags={p.tags} />
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="num">{p.phone ?? "—"}</TableCell>
                    <TableCell className="hidden lg:table-cell">
                      {p.tags.length ? (
                        <span className="flex flex-wrap gap-1">
                          <TagChips tags={p.tags} />
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
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

      {selectedOnPage.length > 0 ? (
        <div className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full border border-border/80 bg-background/95 px-5 py-2.5 shadow-2xl backdrop-blur-md">
          {/* Says what is actually ticked. "Select all" on a filtered list that
              matches 248 customers ticks the 50 this page loaded, and the bar
              is the only place that can admit it. */}
          <span className="text-xs font-semibold text-foreground">
            {describeSelection({
              selected: selectedOnPage.length,
              onPage: rows.length,
              total,
            })}
          </span>
          <div className="h-4 w-px bg-border" />
          <Button
            size="sm"
            variant="destructive"
            className="h-7 gap-1.5 rounded-full text-xs"
            onClick={() => setBulkOpen(true)}
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 rounded-full px-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setSelectedIds(new Set())}
          >
            Clear
          </Button>
        </div>
      ) : null}

      <BulkDeleteDialog
        open={bulkOpen}
        parties={selectedOnPage}
        onOpenChange={(open) => setBulkOpen(open)}
        onDone={(result) => {
          // Keep whoever was kept ticked, so the next action (archive them) is
          // still a selection rather than a hunt back through the list.
          setSelectedIds(new Set(result.skipped.map((s) => s.id)));
        }}
      />

      <CustomerDetailDialog
        party={active}
        onOpenChange={(open) => !open && setActive(null)}
        onPartyChange={setActive}
      />

      <AddCustomerDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}

/** The tag chips, drawn the same wherever the row has room for them. */
function TagChips({
  tags,
}: {
  tags: { id: string; name: string; colour: string | null }[];
}) {
  return (
    <>
      {tags.map((t) => (
        <span
          key={t.id}
          className="inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[10px] font-medium"
        >
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: t.colour ?? "var(--muted-foreground)" }}
          />
          {t.name}
        </span>
      ))}
    </>
  );
}

/**
 * Confirm, then report — deleting the ticked customers (client, 19 Nov).
 *
 * The confirmation is honest about the scope: these customers, on this page,
 * and no others. The report afterwards is the part that matters on real data,
 * because the server applies the existing rules one customer at a time: anyone
 * synced from Gati or holding a sale, quote or visit is kept, and this dialog
 * names them with the reason rather than collapsing it into "9 failed".
 */
function BulkDeleteDialog({
  open,
  parties,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  parties: PartyRow[];
  onOpenChange: (open: boolean) => void;
  onDone: (result: BulkDeleteResult) => void;
}) {
  const remove = useBulkDeleteParties();
  const [result, setResult] = useState<BulkDeleteResult | null>(null);

  useResetOn(open, () => setResult(null));

  const run = () => {
    remove.mutate(
      parties.map((p) => p.id),
      {
        onSuccess: (data) => {
          setResult(data);
          onDone(data);
          const message = describeBulkDelete(data);
          if (bulkDeleteTone(data) === "all") toast.success(message);
          else toast.warning(message);
        },
        onError: (err) =>
          toast.error(apiErrorMessage(err, "Could not delete these customers.")),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {result ? "What happened" : `Delete ${parties.length} customer${parties.length === 1 ? "" : "s"}?`}
          </DialogTitle>
          <DialogDescription>
            {result
              ? describeBulkDelete(result)
              : "Only the ticked customers on this page are affected. A customer synced from Gati, or one with any sales, quotes, payments or visits, is kept — archive them instead."}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-3 text-sm">
            {result.deleted.length ? (
              <div>
                <p className="mb-1 text-xs font-semibold text-muted-foreground">Deleted</p>
                <ul className="space-y-0.5">
                  {result.deleted.map((d) => (
                    <li key={d.id}>{d.name}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {result.skipped.length ? (
              <div>
                <p className="mb-1 text-xs font-semibold text-muted-foreground">
                  Kept — still selected, so you can archive them
                </p>
                <ul className="space-y-0.5 text-muted-foreground">
                  {skippedLines(result).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : (
          <ul className="max-h-60 space-y-0.5 overflow-y-auto text-sm">
            {parties.map((p) => (
              <li key={p.id}>
                {p.name}
                <span className="num text-xs text-muted-foreground"> {p.phone ?? "—"}</span>
              </li>
            ))}
          </ul>
        )}

        <DialogFooter>
          {result ? (
            <Button onClick={() => onOpenChange(false)}>Close</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={run} disabled={remove.isPending}>
                {remove.isPending ? "Deleting…" : "Delete these customers"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddCustomerDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { targetStoreId, storeLabel, pickedStoreId, setPickedStoreId } =
    useStoreScope();
  const create = useCreateParty();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [city, setCity] = useState("");
  // Inline validation errors, keyed by field. Cleared per-field on change.
  const [errors, setErrors] = useState<Record<string, string>>({});

  function clearError(field: string) {
    setErrors((prev) => (prev[field] ? { ...prev, [field]: "" } : prev));
  }

  function save() {
    if (!targetStoreId) {
      toast.error("Select a store to add this customer to.");
      return;
    }
    // Validate every field up front so each offending one shows its own inline
    // message; the toast is just a summary. Backend DTOs remain authoritative.
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = "Customer name is required.";
    else if (!isRealName(name))
      next.name = "Enter a real name — letters, not just a number.";
    // Phone is required. Customers may be foreign (client, 13 Oct): an Indian
    // 10-digit mobile or a +country number (backend @IsCustomerPhone).
    const normalizedPhone = normalizeCustomerPhone(phone);
    if (!phone.trim()) next.phone = "Phone number is required.";
    else if (!normalizedPhone)
      next.phone = "Enter a 10-digit mobile, or an international number starting with +.";
    if (email.trim() && !isValidEmail(email))
      next.email = "Enter a valid email address.";
    if (Object.keys(next).length > 0) {
      setErrors(next);
      toast.error("Please fix the highlighted fields.");
      return;
    }
    create.mutate(
      {
        storeId: targetStoreId,
        name: name.trim(),
        phone: normalizedPhone as string,
        email: email.trim() || undefined,
        city: city.trim() || undefined,
      },
      {
        onSuccess: () => {
          toast.success("Customer added");
          setName("");
          setPhone("");
          setEmail("");
          setCity("");
          setErrors({});
          onOpenChange(false);
        },
        onError: (err) =>
          toast.error(apiErrorMessage(err, "Could not add the customer.")),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add customer</DialogTitle>
          <DialogDescription>
            New customers are added to {storeLabel}.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <StoreScopeField value={pickedStoreId} onChange={setPickedStoreId} />

          <div className="grid gap-1.5">
            <Label htmlFor="cust-name">
              Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="cust-name"
              placeholder="e.g. Rajesh Agarwal"
              value={name}
              aria-invalid={!!errors.name}
              onChange={(e) => {
                setName(e.target.value);
                clearError("name");
              }}
            />
            {errors.name ? (
              <p className="mt-1 text-xs text-destructive">{errors.name}</p>
            ) : null}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="cust-phone">
              Phone <span className="text-destructive">*</span>
            </Label>
            <Input
              id="cust-phone"
              placeholder="10-digit mobile or +country number"
              inputMode="tel"
              maxLength={16}
              value={phone}
              aria-invalid={!!errors.phone}
              onChange={(e) => {
                setPhone(customerPhoneInputValue(e.target.value));
                clearError("phone");
              }}
            />
            {errors.phone ? (
              <p className="mt-1 text-xs text-destructive">{errors.phone}</p>
            ) : null}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="cust-email">Email (optional)</Label>
            <Input
              id="cust-email"
              type="email"
              placeholder="name@example.com"
              value={email}
              aria-invalid={!!errors.email}
              onChange={(e) => {
                setEmail(e.target.value);
                clearError("email");
              }}
            />
            {errors.email ? (
              <p className="mt-1 text-xs text-destructive">{errors.email}</p>
            ) : null}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="cust-city">City (optional)</Label>
            <Input
              id="cust-city"
              placeholder="e.g. Surat"
              value={city}
              onChange={(e) => setCity(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={create.isPending}>
            {create.isPending ? "Saving…" : "Add customer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  onPartyChange,
}: {
  party: PartyRow | null;
  onOpenChange: (open: boolean) => void;
  /** The renamed row, so the open dialog stops showing the old name. */
  onPartyChange: (party: PartyRow) => void;
}) {
  const baseRole = useSession((s) => s.baseRole);
  // The name is what every colleague's list, export and campaign shows, so
  // changing it is a manager's call — the same level as archiving.
  const canRename = ROLE_RANK[baseRole] >= ROLE_RANK.store_manager;
  const rename = useRenameParty();
  const [draft, setDraft] = useState<string | null>(null);

  useResetOn(party?.id ?? null, () => setDraft(null));

  const saveName = () => {
    if (!party || draft == null) return;
    const name = draft.trim();
    if (!name) {
      toast.error("Give the customer a name.");
      return;
    }
    if (!isRealName(name)) {
      toast.error("Enter a real name — letters, not just a number.");
      return;
    }
    if (name === party.name) {
      setDraft(null);
      return;
    }
    rename.mutate(
      { id: party.id, name },
      {
        onSuccess: (row) => {
          onPartyChange(row);
          setDraft(null);
          toast.success(`Now shown as ${row.name}`);
        },
        onError: (err) =>
          toast.error(apiErrorMessage(err, "Could not rename this customer.")),
      },
    );
  };

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
                {canRename && !party.isSynced && draft == null ? (
                  /* The client, 19 Nov: the names Meta gave are hearts and
                     symbols, and nobody can tell who they are talking to. */
                  <button
                    type="button"
                    aria-label="Rename this customer"
                    onClick={() => setDraft(party.name)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </DialogTitle>
              <DialogDescription>
                {party.types.length
                  ? party.types.map((t) => TYPE_LABELS[t] ?? t).join(" · ")
                  : "Party"}
                {party.code ? ` · ${party.code}` : ""}
              </DialogDescription>
            </DialogHeader>

            {draft != null ? (
              <div className="flex items-center gap-2">
                <Input
                  aria-label="Customer name"
                  autoFocus
                  value={draft}
                  maxLength={120}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveName();
                    if (e.key === "Escape") setDraft(null);
                  }}
                />
                <Button size="sm" onClick={saveName} disabled={rename.isPending}>
                  {rename.isPending ? "Saving…" : "Save"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
                  Cancel
                </Button>
              </div>
            ) : null}

            {party.originalName ? (
              /* The WhatsApp profile name is kept, not replaced: it is still
                 what this person is called on the channel we message them on,
                 and the next colleague searching for it has to find them. */
              <p className="text-xs text-muted-foreground">
                Arrived as “{party.originalName}”
              </p>
            ) : null}

            {party.isSynced && canRename ? (
              <p className="text-xs text-muted-foreground">
                Synced from Gati — the name has to be changed there, or the next
                sync puts this one back.
              </p>
            ) : null}

            {/* Tag the customer right here — "imp", "bought" — without leaving
                the directory (client, 10 Oct). Typing a new name creates it. */}
            <PartyTagsField partyId={party.id} />

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
