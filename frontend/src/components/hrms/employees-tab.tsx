"use client";

import { useDeferredValue, useMemo, useState } from "react";
import {
  AlertTriangle,
  Building2,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
  UserCheck,
  UserMinus,
  Users,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
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
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/hrms/confirm-dialog";
import { EmployeeDetailSheet, EmployeeStatusBadge } from "@/components/hrms/employee-detail-sheet";
import { EmployeeFormDialog } from "@/components/hrms/employee-form-dialog";
import { MastersDialog } from "@/components/hrms/masters-dialog";
import {
  EMPLOYMENT_STATUS_LABELS,
  formatYmd,
  useBulkEmployees,
  useDepartments,
  useDesignations,
  useEmployees,
  useSeparateEmployee,
  type BulkAction,
  type EmployeeRow,
  type EmploymentStatus,
} from "@/lib/queries/hrms-employees";
import { apiErrorMessage } from "@/lib/utils";
import { useSession } from "@/store/use-session";

const ALL = "__all";

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const BULK_COPY: Record<BulkAction, { label: string; verb: string; body: string }> = {
  separate: {
    label: "Separate",
    verb: "Separate",
    body: "They are marked as left from today and their logins are switched off. History is kept.",
  },
  deactivate: {
    label: "Deactivate",
    verb: "Deactivate",
    body: "Their logins stop working and they drop out of attendance counts until reactivated.",
  },
  activate: {
    label: "Reactivate",
    verb: "Reactivate",
    body: "They count in attendance again from today.",
  },
};

/**
 * Employees — the employee master (Module 6). Managers see their stores,
 * head office everything; CaratOS logins without a master row show as
 * "No profile" so the reconciliation is visible.
 */
export function EmployeesTab({
  canManage,
  isHeadOffice,
}: {
  canManage: boolean;
  isHeadOffice: boolean;
}) {
  const stores = useSession((s) => s.stores).filter((s) => !s.isAggregate);
  const [q, setQ] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [designationId, setDesignationId] = useState("");
  const [status, setStatus] = useState<EmploymentStatus | "">("");
  const [storeId, setStoreId] = useState("");
  const deferredQ = useDeferredValue(q.trim());

  const list = useEmployees({
    q: deferredQ || undefined,
    departmentId: departmentId || undefined,
    designationId: designationId || undefined,
    status: status || undefined,
    storeId: storeId || undefined,
  });
  const departments = useDepartments();
  const designations = useDesignations();
  const rows = useMemo(() => list.data ?? [], [list.data]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detailId, setDetailId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<EmployeeRow | null>(null);
  const [mastersOpen, setMastersOpen] = useState(false);
  const [separating, setSeparating] = useState<EmployeeRow | null>(null);
  const [purging, setPurging] = useState<EmployeeRow | null>(null);
  const [bulkAction, setBulkAction] = useState<{ action: BulkAction; ids: string[] } | null>(null);

  const bulk = useBulkEmployees();
  const separate = useSeparateEmployee();

  // Only rows with a profile can be bulk-actioned; keep the selection to visible rows.
  const selectable = rows.filter((r) => r.hasProfile);
  const visibleSelected = selectable.filter((r) => selected.has(r.userId)).map((r) => r.userId);
  const allSelected = selectable.length > 0 && visibleSelected.length === selectable.length;
  const noProfile = rows.filter((r) => !r.hasProfile).length;
  const filtered = !!(deferredQ || departmentId || designationId || status || storeId);

  function openForm(row: EmployeeRow | null) {
    setEditing(row);
    setFormOpen(true);
  }

  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  function runBulk() {
    if (!bulkAction) return;
    const { action, ids } = bulkAction;
    bulk.mutate(
      { userIds: ids, action },
      {
        onSuccess: () => {
          toast.success(`${BULK_COPY[action].verb}d ${ids.length}`);
          setSelected(new Set());
          setBulkAction(null);
        },
        onError: (e) => toast.error(apiErrorMessage(e, "Could not update those employees.")),
      },
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Employees</h2>
          <p className="text-sm text-muted-foreground">
            {list.isSuccess ? (
              <>
                <span className="num">{rows.length}</span> {filtered ? "matching" : "people"}
                {noProfile ? (
                  <>
                    {" · "}
                    <span className="num">{noProfile}</span> without a profile
                  </>
                ) : null}
              </>
            ) : (
              "The employee master for your stores."
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {isHeadOffice ? (
            <Button variant="outline" onClick={() => setMastersOpen(true)}>
              <Building2 /> Departments &amp; designations
            </Button>
          ) : null}
          {canManage ? (
            <Button onClick={() => openForm(null)}>
              <Plus /> Add employee
            </Button>
          ) : null}
        </div>
      </div>

      <Card>
        <CardContent className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5">
          <div className="relative sm:col-span-2 lg:col-span-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Search employees"
              placeholder="Name, code or phone"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="pl-9"
            />
          </div>
          <FilterSelect
            label="Department"
            value={departmentId}
            onChange={setDepartmentId}
            options={(departments.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
          />
          <FilterSelect
            label="Designation"
            value={designationId}
            onChange={setDesignationId}
            options={(designations.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
          />
          <FilterSelect
            label="Status"
            value={status}
            onChange={(v) => setStatus(v as EmploymentStatus | "")}
            options={Object.entries(EMPLOYMENT_STATUS_LABELS).map(([value, label]) => ({ value, label }))}
          />
          {stores.length > 1 ? (
            <FilterSelect
              label="Store"
              value={storeId}
              onChange={setStoreId}
              options={stores.map((s) => ({ value: s.id, label: s.name }))}
            />
          ) : null}
        </CardContent>
      </Card>

      {canManage && visibleSelected.length > 0 ? (
        <div className="sticky top-2 z-10 flex flex-wrap items-center gap-2 rounded-lg border bg-card p-2 shadow-md">
          <span className="px-2 text-sm">
            <span className="num">{visibleSelected.length}</span> selected
          </span>
          {(["separate", "deactivate", "activate"] as const).map((a) => (
            <Button
              key={a}
              size="sm"
              variant={a === "activate" ? "outline" : "destructive"}
              onClick={() => setBulkAction({ action: a, ids: visibleSelected })}
            >
              {BULK_COPY[a].label}
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      ) : null}

      {list.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-12 rounded-lg" />
          ))}
        </div>
      ) : list.isError ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-8 text-center text-sm">
          <AlertTriangle className="h-5 w-5 text-destructive" />
          <p>{apiErrorMessage(list.error, "Could not load employees.")}</p>
          <Button size="sm" variant="outline" onClick={() => list.refetch()}>
            Try again
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Users}
          title={filtered ? "No one matches these filters" : "No employees yet"}
          description={
            filtered
              ? "Clear a filter or try another name."
              : isHeadOffice
                ? "Add people one by one, or import the EzAttendance employee master."
                : "Add the people who work in your store."
          }
          actionLabel={!filtered && canManage ? "Add employee" : undefined}
          onAction={() => openForm(null)}
        />
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                {canManage ? (
                  <TableHead className="w-10">
                    <input
                      type="checkbox"
                      aria-label="Select all"
                      checked={allSelected}
                      onChange={() =>
                        setSelected(allSelected ? new Set() : new Set(selectable.map((r) => r.userId)))
                      }
                    />
                  </TableHead>
                ) : null}
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Designation</TableHead>
                <TableHead>Department</TableHead>
                <TableHead>Store</TableHead>
                <TableHead>Shift</TableHead>
                <TableHead>Joined</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Source</TableHead>
                <TableHead className="w-10">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow
                  key={r.userId}
                  className="cursor-pointer"
                  onClick={() => setDetailId(r.userId)}
                  data-state={selected.has(r.userId) ? "selected" : undefined}
                >
                  {canManage ? (
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      {r.hasProfile ? (
                        <input
                          type="checkbox"
                          aria-label={`Select ${r.name}`}
                          checked={selected.has(r.userId)}
                          onChange={() => toggle(r.userId)}
                        />
                      ) : null}
                    </TableCell>
                  ) : null}
                  <TableCell className="num whitespace-nowrap">{r.employeeCode ?? "—"}</TableCell>
                  <TableCell className="min-w-40 font-medium">
                    <button
                      type="button"
                      className="text-left hover:underline"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDetailId(r.userId);
                      }}
                    >
                      {r.name}
                    </button>
                    {r.phone ? <p className="num text-xs font-normal text-muted-foreground">{r.phone}</p> : null}
                  </TableCell>
                  <TableCell>{r.designation?.name ?? "—"}</TableCell>
                  <TableCell>{r.department?.name ?? "—"}</TableCell>
                  <TableCell className="min-w-32">{(r.storeNames ?? []).join(", ") || "—"}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {r.currentShift ? (
                      <span title={`${r.currentShift.startTime}–${r.currentShift.endTime}`}>
                        {r.currentShift.name}
                      </span>
                    ) : (
                      (r.shiftCode ?? "—")
                    )}
                  </TableCell>
                  <TableCell className="num whitespace-nowrap">{formatYmd(r.dateOfJoining)}</TableCell>
                  <TableCell>
                    <EmployeeStatusBadge row={r} />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {r.source === "ezattendance" ? "EzAttendance" : r.hasProfile ? "Manual" : "CaratOS"}
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    {canManage ? (
                      <RowActions
                        row={r}
                        isHeadOffice={isHeadOffice}
                        onEdit={() => openForm(r)}
                        onSeparate={() => setSeparating(r)}
                        onReactivate={() => setBulkAction({ action: "activate", ids: [r.userId] })}
                        onPurge={() => setPurging(r)}
                      />
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <EmployeeDetailSheet
        userId={detailId}
        onOpenChange={(o) => !o && setDetailId(null)}
        canManage={canManage}
        onEdit={(row) => {
          setDetailId(null);
          openForm(row);
        }}
      />
      <EmployeeFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        employee={editing}
        people={rows}
        isHeadOffice={isHeadOffice}
      />
      {isHeadOffice ? <MastersDialog open={mastersOpen} onOpenChange={setMastersOpen} /> : null}

      <SeparateDialog
        row={separating}
        onClose={() => setSeparating(null)}
        pending={separate.isPending}
        onConfirm={(exitDate, exitReason) =>
          separating &&
          separate.mutate(
            { userId: separating.userId, exitDate, exitReason: exitReason || undefined },
            {
              onSuccess: () => {
                toast.success(`${separating.name} separated`);
                setSeparating(null);
              },
              onError: (e) => toast.error(apiErrorMessage(e, "Could not separate.")),
            },
          )
        }
      />

      <ConfirmDialog
        open={!!purging}
        onOpenChange={(o) => !o && setPurging(null)}
        title={`Delete ${purging?.name ?? ""}'s profile?`}
        description="Only possible when they have no attendance, leave or payslip history. The profile row is removed for good; the login stays switched off."
        confirmLabel="Delete profile"
        pending={separate.isPending}
        onConfirm={() =>
          purging &&
          separate.mutate(
            { userId: purging.userId, purge: true },
            {
              onSuccess: () => {
                toast.success(`${purging.name}'s profile deleted`);
                setPurging(null);
              },
              onError: (e) => toast.error(apiErrorMessage(e, "Could not delete the profile.")),
            },
          )
        }
      />

      <ConfirmDialog
        open={!!bulkAction}
        onOpenChange={(o) => !o && setBulkAction(null)}
        title={
          bulkAction
            ? `${BULK_COPY[bulkAction.action].verb} ${bulkAction.ids.length} ${bulkAction.ids.length === 1 ? "person" : "people"}?`
            : ""
        }
        description={bulkAction ? BULK_COPY[bulkAction.action].body : ""}
        confirmLabel={bulkAction ? BULK_COPY[bulkAction.action].verb : ""}
        destructive={bulkAction?.action !== "activate"}
        pending={bulk.isPending}
        onConfirm={runBulk}
      />
    </div>
  );
}

function RowActions({
  row,
  isHeadOffice,
  onEdit,
  onSeparate,
  onReactivate,
  onPurge,
}: {
  row: EmployeeRow;
  isHeadOffice: boolean;
  onEdit: () => void;
  onSeparate: () => void;
  onReactivate: () => void;
  onPurge: () => void;
}) {
  const off = row.status === "separated" || row.status === "inactive" || !row.isActive;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost" aria-label={`Actions for ${row.name}`}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onEdit}>
          <Pencil /> {row.hasProfile ? "Edit" : "Create profile"}
        </DropdownMenuItem>
        {row.hasProfile && row.status !== "separated" ? (
          <DropdownMenuItem onSelect={onSeparate}>
            <UserMinus /> Separate…
          </DropdownMenuItem>
        ) : null}
        {row.hasProfile && off ? (
          <DropdownMenuItem onSelect={onReactivate}>
            <UserCheck /> Reactivate
          </DropdownMenuItem>
        ) : null}
        {isHeadOffice && row.hasProfile ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onPurge} className="text-destructive">
              <Trash2 /> Delete profile…
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SeparateDialog({
  row,
  onClose,
  onConfirm,
  pending,
}: {
  row: EmployeeRow | null;
  onClose: () => void;
  onConfirm: (exitDate: string, reason: string) => void;
  pending: boolean;
}) {
  const [exitDate, setExitDate] = useState(todayLocal);
  const [reason, setReason] = useState("");
  // Fresh defaults for each person (render-time reset, not an effect).
  const [forId, setForId] = useState<string | null>(null);
  if ((row?.userId ?? null) !== forId) {
    setForId(row?.userId ?? null);
    setExitDate(todayLocal());
    setReason("");
  }
  return (
    <ConfirmDialog
      open={!!row}
      onOpenChange={(o) => !o && onClose()}
      title={`Separate ${row?.name ?? ""}?`}
      description="Marks them as left from the exit date and switches off their login. Attendance and payroll history is kept."
      confirmLabel="Separate"
      pending={pending}
      disabled={!exitDate}
      onConfirm={() => onConfirm(exitDate, reason.trim())}
    >
      <div className="grid gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="exit-date">Exit date *</Label>
          <Input id="exit-date" type="date" value={exitDate} onChange={(e) => setExitDate(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="exit-reason">Reason</Label>
          <Textarea
            id="exit-reason"
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Resigned, absconded, contract ended…"
          />
        </div>
      </div>
    </ConfirmDialog>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <Select value={value || ALL} onValueChange={(v) => onChange(v === ALL ? "" : v)}>
      <SelectTrigger aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All {label.toLowerCase()}s</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
