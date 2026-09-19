"use client";

import { useState } from "react";
import { AlertTriangle, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";

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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConfirmDialog } from "@/components/hrms/confirm-dialog";
import {
  useDeleteMaster,
  useDepartments,
  useDesignations,
  useSaveMaster,
  type Department,
  type Designation,
} from "@/lib/queries/hrms-employees";
import { apiErrorMessage } from "@/lib/utils";
import { useSession } from "@/store/use-session";

const NONE = "__none";
type Kind = "departments" | "designations";
type Item = (Department | Designation) & { storeId?: string | null };

/** Head-office CRUD for departments (with their store) and designations. */
export function MastersDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const departments = useDepartments();
  const designations = useDesignations();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Departments &amp; designations</DialogTitle>
          <DialogDescription>
            A department can stand for a store (EzAttendance used departments for branches).
            Deleting one that is in use asks where its people should move.
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="departments">
          <TabsList>
            <TabsTrigger value="departments">Departments</TabsTrigger>
            <TabsTrigger value="designations">Designations</TabsTrigger>
          </TabsList>
          <TabsContent value="departments">
            <MasterList kind="departments" query={departments} />
          </TabsContent>
          <TabsContent value="designations">
            <MasterList kind="designations" query={designations} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function MasterList({
  kind,
  query,
}: {
  kind: Kind;
  query: { data?: Item[]; isLoading: boolean; isError: boolean; error: unknown; refetch: () => unknown };
}) {
  const items = [...(query.data ?? [])].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
  );
  return (
    <div className="space-y-3 pt-2">
      <AddRow kind={kind} />
      {query.isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 rounded-lg" />
          ))}
        </div>
      ) : query.isError ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed p-4 text-sm">
          <span className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            {apiErrorMessage(query.error, `Could not load ${kind}.`)}
          </span>
          <Button size="sm" variant="outline" onClick={() => query.refetch()}>
            Retry
          </Button>
        </div>
      ) : items.length === 0 ? (
        <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
          No {kind} yet. Add one above, or run the EzAttendance import.
        </p>
      ) : (
        items.map((it) => (
          // Keyed on the saved values so a refetch re-seeds the row's draft.
          <MasterRow
            key={`${it.id}|${it.name}|${it.storeId ?? ""}|${it.sortOrder}|${it.isActive}`}
            kind={kind}
            item={it}
            others={items.filter((o) => o.id !== it.id)}
          />
        ))
      )}
    </div>
  );
}

function StoreSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const stores = useSession((s) => s.stores).filter((s) => !s.isAggregate);
  return (
    <Select value={value || NONE} onValueChange={(v) => onChange(v === NONE ? "" : v)}>
      <SelectTrigger aria-label="Store" className="sm:w-48">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>Head office / none</SelectItem>
        {stores.map((s) => (
          <SelectItem key={s.id} value={s.id}>
            {s.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function AddRow({ kind }: { kind: Kind }) {
  const [name, setName] = useState("");
  const [storeId, setStoreId] = useState("");
  const save = useSaveMaster(kind);
  const label = kind === "departments" ? "department" : "designation";
  function add() {
    if (!name.trim()) return;
    save.mutate(
      { name: name.trim(), ...(kind === "departments" ? { storeId: storeId || null } : {}) },
      {
        onSuccess: () => {
          toast.success(`Added ${name.trim()}`);
          setName("");
          setStoreId("");
        },
        onError: (e) => toast.error(apiErrorMessage(e, `Could not add the ${label}.`)),
      },
    );
  }
  return (
    <form
      className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3 sm:flex-row sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        add();
      }}
    >
      <div className="grid flex-1 gap-1.5">
        <Label htmlFor={`new-${kind}`}>New {label}</Label>
        <Input id={`new-${kind}`} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      {kind === "departments" ? <StoreSelect value={storeId} onChange={setStoreId} /> : null}
      <Button type="submit" disabled={!name.trim() || save.isPending}>
        {save.isPending ? <Loader2 className="animate-spin" /> : <Plus />}
        Add
      </Button>
    </form>
  );
}

function MasterRow({ kind, item, others }: { kind: Kind; item: Item; others: Item[] }) {
  const [name, setName] = useState(item.name);
  const [storeId, setStoreId] = useState(item.storeId ?? "");
  const [sortOrder, setSortOrder] = useState(String(item.sortOrder));
  const [isActive, setIsActive] = useState(item.isActive);
  const [deleting, setDeleting] = useState(false);
  const [reassignTo, setReassignTo] = useState("");
  const save = useSaveMaster(kind);
  const del = useDeleteMaster(kind);

  const count = item.employeeCount ?? 0;
  const dirty =
    name.trim() !== item.name ||
    (kind === "departments" && storeId !== (item.storeId ?? "")) ||
    Number(sortOrder) !== item.sortOrder ||
    isActive !== item.isActive;

  function onSave() {
    if (!name.trim() || !Number.isInteger(Number(sortOrder))) {
      toast.error("Name is required and order must be a whole number.");
      return;
    }
    save.mutate(
      {
        id: item.id,
        name: name.trim(),
        sortOrder: Number(sortOrder),
        isActive,
        ...(kind === "departments" ? { storeId: storeId || null } : {}),
      },
      {
        onSuccess: () => toast.success(`Saved ${name.trim()}`),
        onError: (e) => toast.error(apiErrorMessage(e, "Could not save.")),
      },
    );
  }

  function onDelete() {
    del.mutate(
      { id: item.id, reassignTo: reassignTo || undefined },
      {
        onSuccess: () => {
          toast.success(`Deleted ${item.name}`);
          setDeleting(false);
        },
        onError: (e) => toast.error(apiErrorMessage(e, "Could not delete.")),
      },
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center">
      <Input
        aria-label="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="flex-1"
      />
      {kind === "departments" ? <StoreSelect value={storeId} onChange={setStoreId} /> : null}
      <div className="flex items-center gap-2">
        <Input
          aria-label="Sort order"
          inputMode="numeric"
          value={sortOrder}
          onChange={(e) => setSortOrder(e.target.value)}
          className="num w-16"
        />
        <label className="flex min-h-10 items-center gap-1.5 text-xs">
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
          Active
        </label>
        <span className="num w-10 text-right text-xs text-muted-foreground" title="Employees">
          {item.employeeCount ?? ""}
        </span>
        <Button
          size="icon"
          variant="ghost"
          aria-label={`Save ${item.name}`}
          disabled={!dirty || save.isPending}
          onClick={onSave}
        >
          {save.isPending ? <Loader2 className="animate-spin" /> : <Save />}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label={`Delete ${item.name}`}
          onClick={() => {
            setReassignTo("");
            setDeleting(true);
          }}
        >
          <Trash2 className="text-destructive" />
        </Button>
      </div>

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${item.name}?`}
        description={
          count > 0
            ? `${count} employee${count === 1 ? "" : "s"} use it. Pick where they move before deleting.`
            : "This cannot be undone."
        }
        confirmLabel="Delete"
        pending={del.isPending}
        disabled={count > 0 && !reassignTo}
        onConfirm={onDelete}
      >
        {others.length > 0 ? (
          <div className="grid gap-1.5">
            <Label>Move its employees to{count > 0 ? " *" : ""}</Label>
            <Select value={reassignTo || NONE} onValueChange={(v) => setReassignTo(v === NONE ? "" : v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>— Don&apos;t reassign</SelectItem>
                {others.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
