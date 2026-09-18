"use client";

import { useState } from "react";
import { ClipboardList, ListTree, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import {
  AttendanceEditDialog,
  ReasonDialog,
  type EditableAttendance,
} from "@/components/hrms/attendance-edit-dialog";
import {
  AddPunchDialog,
  PunchLogSheet,
  type PunchTarget,
} from "@/components/hrms/punch-log-sheet";
import { PayrollLockCard } from "@/components/hrms/payroll-lock-card";
import { ProcessingCard } from "@/components/hrms/processing-card";
import { StateBadge } from "@/components/hrms/today-tab";
import { ATTENDANCE_STATUS_LABELS, type AttendanceStatus } from "@/lib/mock/hrms";
import { useStaff } from "@/lib/queries/users";
import {
  useAttendanceRegister,
  useDeleteAttendance,
  type RegisterRow,
} from "@/lib/queries/hrms-ops";
import { apiErrorMessage } from "@/lib/utils";
import { useSession } from "@/store/use-session";

const ALL = "__all";

/** Browser-local YYYY-MM-DD. */
function ymd(d: Date): string {
  return d.toLocaleDateString("en-CA");
}

function hm(mins: number | null | undefined): string {
  if (mins == null) return "—";
  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")}`;
}

/**
 * The attendance register — every written day in a range, with corrections.
 * Edits and deletes need a reason and are audited; the raw punches behind a
 * row are one click away and survive a delete.
 */
export function RegisterTab({
  canEdit,
  isHeadOffice,
}: {
  canEdit: boolean;
  isHeadOffice: boolean;
}) {
  const { currentStore, stores, user } = useSession();
  const today = new Date();
  const [from, setFrom] = useState(ymd(new Date(today.getFullYear(), today.getMonth(), 1)));
  const [to, setTo] = useState(ymd(today));
  const [storeId, setStoreId] = useState("");
  const [userId, setUserId] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const staffStore = currentStore.isAggregate ? storeId : currentStore.id;
  const { data: staff = [] } = useStaff(staffStore || undefined);
  const query = useAttendanceRegister({
    from,
    to,
    storeId: storeId || undefined,
    userId: userId || undefined,
    status: status || undefined,
    page,
    pageSize,
  });
  const del = useDeleteAttendance();

  const [editing, setEditing] = useState<EditableAttendance | null>(null);
  const [deleting, setDeleting] = useState<RegisterRow | null>(null);
  const [punchesFor, setPunchesFor] = useState<PunchTarget | null>(null);
  const [adding, setAdding] = useState(false);

  // Any filter change goes back to page 1 (set in the handler, not an effect).
  function filterSetter(set: (v: string) => void) {
    return (v: string) => {
      set(v);
      setPage(1);
    };
  }

  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  const multiStore = currentStore.isAggregate && !storeId;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              <ClipboardList className="h-4 w-4 text-muted-foreground" />
              Attendance register
            </CardTitle>
            <CardDescription>
              One row per person per day. Corrections need a reason and are audited;
              days inside a locked payroll month can&apos;t be changed.
            </CardDescription>
          </div>
          {canEdit ? (
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" />
              Add punch
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div className="grid gap-1.5">
              <Label htmlFor="rg-from">From</Label>
              <Input
                id="rg-from"
                type="date"
                value={from}
                max={to}
                onChange={(e) => filterSetter(setFrom)(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="rg-to">To</Label>
              <Input
                id="rg-to"
                type="date"
                value={to}
                min={from}
                onChange={(e) => filterSetter(setTo)(e.target.value)}
              />
            </div>
            {currentStore.isAggregate ? (
              <div className="grid gap-1.5">
                <Label htmlFor="rg-store">Store</Label>
                <Select
                  value={storeId || ALL}
                  onValueChange={(v) => {
                    setStoreId(v === ALL ? "" : v);
                    setUserId("");
                    setPage(1);
                  }}
                >
                  <SelectTrigger id="rg-store">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>All stores</SelectItem>
                    {stores
                      .filter((s) => !s.isAggregate)
                      .map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <div className="grid gap-1.5">
              <Label htmlFor="rg-staff">Employee</Label>
              <Select
                value={userId || ALL}
                onValueChange={(v) => filterSetter(setUserId)(v === ALL ? "" : v)}
              >
                <SelectTrigger id="rg-staff">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Everyone</SelectItem>
                  {staff.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="rg-status">Status</Label>
              <Select
                value={status || ALL}
                onValueChange={(v) => filterSetter(setStatus)(v === ALL ? "" : v)}
              >
                <SelectTrigger id="rg-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Any status</SelectItem>
                  {(Object.keys(ATTENDANCE_STATUS_LABELS) as AttendanceStatus[]).map((s) => (
                    <SelectItem key={s} value={s}>
                      {ATTENDANCE_STATUS_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {query.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 rounded-md" />
              ))}
            </div>
          ) : query.isError ? (
            <div className="rounded-lg border bg-muted/30 p-4 text-center">
              <p className="text-sm font-medium">Couldn&apos;t load the register.</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {apiErrorMessage(query.error, "Check your connection and try again.")}
              </p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => query.refetch()}>
                Retry
              </Button>
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={ClipboardList}
              title="No attendance in this range"
              description="Widen the dates or clear a filter. Days nobody has closed yet have no row until day-close or processing runs."
            />
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Code</TableHead>
                      <TableHead>Name</TableHead>
                      {multiStore ? <TableHead>Store</TableHead> : null}
                      <TableHead>Shift</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">In</TableHead>
                      <TableHead className="text-right">Out</TableHead>
                      <TableHead className="text-right">Worked</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead className="text-right">
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((r) => {
                      const date = r.date ?? "";
                      return (
                        <TableRow key={r.recordId}>
                          <TableCell className="num whitespace-nowrap text-xs">{date}</TableCell>
                          <TableCell className="num text-xs">{r.employeeCode ?? "—"}</TableCell>
                          <TableCell className="font-medium">{r.name}</TableCell>
                          {multiStore ? (
                            <TableCell className="text-sm">{r.storeName ?? "—"}</TableCell>
                          ) : null}
                          <TableCell className="text-sm">{r.shift}</TableCell>
                          <TableCell>
                            <StateBadge state={r.status} isLate={r.isLate} />
                          </TableCell>
                          <TableCell className="num text-right">{r.checkIn ?? "—"}</TableCell>
                          <TableCell className="num text-right">{r.checkOut ?? "—"}</TableCell>
                          <TableCell className="num text-right">{hm(r.workedMins)}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {r.source ?? "—"}
                          </TableCell>
                          <TableCell>
                            <div className="flex justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`Punches for ${r.name} on ${date}`}
                                title="Raw punches"
                                onClick={() =>
                                  setPunchesFor({
                                    userId: r.staffId,
                                    name: r.name,
                                    storeId: r.storeId,
                                    date,
                                  })
                                }
                              >
                                <ListTree className="h-4 w-4" />
                              </Button>
                              {/* Nobody corrects their own day (the API refuses it too). */}
                              {canEdit && r.staffId !== user.id ? (
                                <>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label={`Edit ${r.name} on ${date}`}
                                    title="Edit"
                                    onClick={() =>
                                      setEditing({
                                        recordId: r.recordId,
                                        name: r.name,
                                        storeId: r.storeId,
                                        date,
                                        status: r.status,
                                        checkIn: r.checkIn,
                                        checkOut: r.checkOut,
                                        shiftId: r.shiftId,
                                      })
                                    }
                                  >
                                    <Pencil className="h-4 w-4" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label={`Delete ${r.name} on ${date}`}
                                    title="Delete"
                                    className="text-destructive"
                                    onClick={() => setDeleting(r)}
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                </>
                              ) : null}
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              <PaginationBar
                page={page}
                pageSize={pageSize}
                total={total}
                onPageChange={setPage}
                onPageSizeChange={(n) => {
                  setPageSize(n);
                  setPage(1);
                }}
              />
            </>
          )}
        </CardContent>
      </Card>

      {isHeadOffice ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <ProcessingCard />
          <PayrollLockCard />
        </div>
      ) : null}

      <AttendanceEditDialog
        key={editing?.recordId ?? "none"}
        record={editing}
        onClose={() => setEditing(null)}
      />
      <PunchLogSheet
        target={punchesFor}
        onClose={() => setPunchesFor(null)}
        canEdit={canEdit && punchesFor?.userId !== user.id}
      />
      {adding ? <AddPunchDialog open onOpenChange={setAdding} /> : null}
      {deleting ? (
        <ReasonDialog
          key={deleting.recordId}
          open
          onOpenChange={(o) => (o ? null : setDeleting(null))}
          title="Delete this attendance row?"
          description={`${deleting.name} · ${deleting.date ?? ""}. The raw punches stay; processing can rebuild the day from them.`}
          confirmLabel="Delete row"
          destructive
          pending={del.isPending}
          onConfirm={(reason) =>
            del.mutate(
              { id: deleting.recordId, reason },
              {
                onSuccess: () => {
                  toast.success("Attendance row deleted");
                  setDeleting(null);
                },
                onError: (err) => toast.error(apiErrorMessage(err, "Could not delete the row.")),
              },
            )
          }
        />
      ) : null}
    </div>
  );
}
