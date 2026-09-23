"use client";

import { useState } from "react";
import {
  Check,
  Copy,
  Database,
  KeyRound,
  Lock,
  Mail,
  MapPin,
  Pencil,
  Power,
  UserPlus,
} from "lucide-react";
import { toast } from "sonner";
import type { AxiosError } from "axios";

import { SectionHeader } from "@/components/section/section-header";
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
import { getNavItem } from "@/lib/navigation";
import { useResetPassword } from "@/lib/queries/auth";
import {
  useActivateStore,
  useAddStoreManager,
  useCloseStore,
  useCreateRegion,
  useCreateStore,
  usePendingStores,
  useRegions,
  useStoresAdmin,
  useUpdateStore,
  type AdminStore,
  type PendingStore,
  type StoreRegion,
  type StoreManager,
  type StoreStatus,
} from "@/lib/queries/stores";
import { ROLE_RANK } from "@/lib/types";
import { useSession } from "@/store/use-session";
import {
  apiErrorMessage,
  capIndianPhone,
  isRealName,
  isValidEmail,
  normalizeIndianMobile,
} from "@/lib/utils";

const nav = getNavItem("settings/stores")!;
const NO_REGION_VALUE = "__no_region__";

/** Pull a human message out of a Nest 400/403 error payload. */
function serverMessage(err: unknown): string | undefined {
  const message = (err as AxiosError<{ message?: string | string[] }>)?.response
    ?.data?.message;
  return Array.isArray(message) ? message[0] : message ?? undefined;
}

/** Parse a coordinate field: "" → undefined, non-numeric → null (invalid). */
function parseCoord(value: string, label: string): number | undefined | null {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const num = Number(trimmed);
  if (Number.isNaN(num)) {
    toast.error(`${label} must be a number.`);
    return null;
  }
  return num;
}

function StatusBadge({ status }: { status: StoreStatus }) {
  if (status === "active") return <Badge variant="success">Active</Badge>;
  if (status === "pending") return <Badge variant="warning">Pending</Badge>;
  return <Badge variant="secondary">Closed</Badge>;
}

export default function StoreSetupPage() {
  const { role, stores: sessionStores } = useSession();
  const isHeadOffice = role === "head_office";
  const [addOpen, setAddOpen] = useState(false);
  const reopen = useActivateStore();
  const [regionOpen, setRegionOpen] = useState(false);
  const [editStore, setEditStore] = useState<AdminStore | null>(null);
  const [managerStore, setManagerStore] = useState<AdminStore | null>(null);
  const [closeStore, setCloseStore] = useState<AdminStore | null>(null);
  const [resetUser, setResetUser] = useState<StoreManager | null>(null);

  const { data: stores = [], isLoading, isError, refetch } = useStoresAdmin();
  const { data: pending = [] } = usePendingStores();
  const { data: regions = [] } = useRegions();

  // Store settings are managed by store managers, area managers, and Head Office.
  if (ROLE_RANK[role] < ROLE_RANK.store_manager) {
    return (
      <>
        <SectionHeader title={nav.title} purpose={nav.purpose} />
        <div className="mx-auto max-w-md rounded-xl border bg-muted/30 p-8 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-muted">
            <Lock className="h-5 w-5 text-muted-foreground" />
          </div>
          <p className="text-sm font-medium">Store Manager access required</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Store geofencing and branch settings are managed by Store Managers and
            Head Office.
          </p>
        </div>
      </>
    );
  }

  // Aggregates are views and holding rows are import quarantine buckets. Neither
  // is a physical location that Head Office should configure as a branch.
  const manageable = stores.filter(
    (s) =>
      !s.isAggregate &&
      (isHeadOffice || role === "area_manager" || sessionStores.some((ss) => ss.id === s.id)),
  );
  const holdingStores = manageable.filter((s) => s.isHolding);
  const physicalStores = manageable.filter((s) => !s.isHolding);
  const pendingBranches = pending.filter((s) => !s.isHolding);
  const activeCount = physicalStores.filter((s) => s.status === "active").length;
  const attendanceLocationCount = physicalStores.filter((s) => s.attendanceOnly).length;

  /** Open the edit dialog for a pending branch so HO can set geo + region. */
  function openEditById(id: string) {
    const match = stores.find((s) => s.id === id);
    if (match) setEditStore(match);
  }

  return (
    <>
      <SectionHeader
        title={nav.title}
        purpose={nav.purpose}
        primaryAction={isHeadOffice ? nav.primaryAction : undefined}
        onPrimaryAction={isHeadOffice ? () => setAddOpen(true) : undefined}
      />

      {isHeadOffice ? (
        <div className="mb-4 flex justify-end">
          <Button variant="outline" size="sm" onClick={() => setRegionOpen(true)}>
            <MapPin className="h-4 w-4" /> Add region
          </Button>
        </div>
      ) : null}

      {pendingBranches.length > 0 ? (
        <PendingReviewSection
          pending={pendingBranches}
          isHeadOffice={isHeadOffice}
          onFixDetails={openEditById}
        />
      ) : null}

      {holdingStores.length > 0 ? <HoldingStoreNotice stores={holdingStores} /> : null}

      <p className="mb-4 text-sm text-muted-foreground">
        {isLoading
          ? "Loading stores…"
          : `${physicalStores.length} physical ${
              physicalStores.length === 1 ? "location" : "locations"
            } provisioned · ${activeCount} active${
              attendanceLocationCount > 0
                ? ` · ${attendanceLocationCount} attendance-only`
                : ""
            }`}
      </p>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16 rounded-xl" />
          ))}
        </div>
      ) : isError ? (
        <div className="mx-auto max-w-md rounded-lg border bg-muted/30 p-4 text-center">
          <p className="text-sm font-medium">Couldn&apos;t load stores.</p>
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
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Store</TableHead>
                <TableHead>City</TableHead>
                <TableHead>Code</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Store manager(s)</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {physicalStores.map((store) => (
                <TableRow key={store.id}>
                  <TableCell className="font-medium">
                    <div className="flex flex-wrap items-center gap-2">
                      <span>{store.name}</span>
                      {store.attendanceOnly ? (
                        <Badge variant="outline">Attendance only</Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>{store.city}</TableCell>
                  <TableCell>
                    {store.code ? (
                      <span className="num text-sm">{store.code}</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {store.isAggregate ? (
                      <Badge variant="outline">All-stores view</Badge>
                    ) : (
                      <StatusBadge status={store.status} />
                    )}
                  </TableCell>
                  <TableCell>
                    {store.isAggregate ? (
                      <span className="text-muted-foreground">—</span>
                    ) : store.managers.length === 0 ? (
                      <span className="text-xs text-muted-foreground">
                        No manager assigned
                      </span>
                    ) : (
                      <ul className="space-y-1">
                        {store.managers.map((m) => (
                          <li
                            key={m.id}
                            className="flex items-center justify-between gap-3 leading-tight"
                          >
                            <div className="min-w-0">
                              <span className="block truncate text-sm font-medium">
                                {m.name}
                              </span>
                              <span className="block truncate text-xs text-muted-foreground">
                                {m.email}
                              </span>
                            </div>
                            {isHeadOffice ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 shrink-0 px-2 text-xs"
                                onClick={() => setResetUser(m)}
                              >
                                <KeyRound className="h-3.5 w-3.5" /> Reset
                                password
                              </Button>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      {isHeadOffice ? (
                        <>
                          {store.status === "active" ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-destructive hover:text-destructive"
                              onClick={() => setCloseStore(store)}
                            >
                              <Power className="h-4 w-4" /> Close
                            </Button>
                          ) : null}
                          {/* Closing is a soft close, so a branch shut for a
                              refit or a season comes back the same way it went
                              live: readiness is re-checked on the server. */}
                          {store.status === "closed" ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={reopen.isPending}
                              onClick={() =>
                                reopen.mutate(store.id, {
                                  onSuccess: () => toast.success(`${store.name} is open again`),
                                  onError: (err) =>
                                    toast.error(
                                      serverMessage(err) ||
                                        "Could not reopen this branch — check its geofence and region.",
                                    ),
                                })
                              }
                            >
                              <Power className="h-4 w-4" /> Reopen
                            </Button>
                          ) : null}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setManagerStore(store)}
                          >
                            <UserPlus className="h-4 w-4" /> Add manager
                          </Button>
                        </>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditStore(store)}
                      >
                        <Pencil className="h-4 w-4" /> Edit
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {physicalStores.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="py-10 text-center text-muted-foreground"
                  >
                    No stores yet. Add a branch to begin.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      )}

      <AddStoreDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        regions={regions}
      />
      <CreateRegionDialog open={regionOpen} onOpenChange={setRegionOpen} />
      <EditStoreDialog
        store={editStore}
        regions={regions}
        canChangeRegion={isHeadOffice}
        onOpenChange={(open) => !open && setEditStore(null)}
      />
      <AddManagerDialog
        store={managerStore}
        onOpenChange={(open) => !open && setManagerStore(null)}
      />
      <CloseStoreDialog
        store={closeStore}
        onOpenChange={(open) => !open && setCloseStore(null)}
      />
      <ResetPasswordDialog
        user={resetUser}
        onOpenChange={(open) => !open && setResetUser(null)}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Import holding area                                                 */
/* ------------------------------------------------------------------ */

function HoldingStoreNotice({ stores }: { stores: AdminStore[] }) {
  return (
    <section className="mb-6 rounded-xl border border-dashed bg-muted/20 p-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
          <Database className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">Import holding area</h2>
            <Badge variant="secondary" className="num">
              {stores.length}
            </Badge>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            These are system buckets for imported records whose branch could not
            be identified. They are not physical stores, so they do not need a
            geofence, region, manager, or activation. Reconcile the imported rows
            with their correct branch instead.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {stores.map((store) => (
              <Badge key={store.id} variant="outline">
                {store.name}
              </Badge>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Branches to review (pending)                                       */
/* ------------------------------------------------------------------ */

function PendingReviewSection({
  pending,
  isHeadOffice,
  onFixDetails,
}: {
  pending: PendingStore[];
  isHeadOffice: boolean;
  onFixDetails: (storeId: string) => void;
}) {
  const activate = useActivateStore();

  function handleActivate(store: PendingStore) {
    activate.mutate(store.id, {
      onSuccess: () => toast.success(`${store.name} is now active`),
      onError: (err) => {
        const msg =
          serverMessage(err) ||
          "Could not activate this branch — it may still be missing details.";
        toast.error(msg);
        if (isHeadOffice && (store.needsGeo || store.needsRegion)) {
          onFixDetails(store.id);
        }
      },
    });
  }

  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-sm font-semibold">Branches to review</h2>
        <Badge variant="warning" className="num">
          {pending.length}
        </Badge>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        New branches stay pending until they have a geofence and a region. Fill
        those in, then activate to take the branch live.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {pending.map((store) => {
          const blocked = store.needsGeo || store.needsRegion;
          return (
            <div
              key={store.id}
              className="rounded-xl border bg-card p-4 shadow-sm"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{store.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {store.city}
                    {store.code ? (
                      <span className="num"> · {store.code}</span>
                    ) : null}
                  </p>
                </div>
                <StatusBadge status="pending" />
              </div>

              <div className="mt-3 flex flex-wrap gap-1.5">
                {store.needsGeo ? (
                  <Badge variant="warning">Geofence missing</Badge>
                ) : null}
                {store.needsRegion ? (
                  <Badge variant="warning">Region missing</Badge>
                ) : null}
                {store.needsManager ? (
                  <Badge variant="secondary">No manager</Badge>
                ) : null}
                {!blocked && !store.needsManager ? (
                  <Badge variant="success">Ready to activate</Badge>
                ) : null}
              </div>

              {blocked ? (
                isHeadOffice ? (
                  <p className="mt-3 text-xs text-muted-foreground">
                    Set the {store.needsGeo ? "geofence" : ""}
                    {store.needsGeo && store.needsRegion ? " and " : ""}
                    {store.needsRegion ? "region" : ""} before this branch can
                    go live.
                  </p>
                ) : (
                  <p className="mt-3 text-xs text-muted-foreground">
                    Ask Head Office to set the geofence and region before this
                    branch can go live.
                  </p>
                )
              ) : null}

              <div className="mt-3 flex items-center gap-2">
                {isHeadOffice && blocked ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onFixDetails(store.id)}
                  >
                    <MapPin className="h-4 w-4" /> Set geo &amp; region
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  onClick={() => handleActivate(store)}
                  disabled={
                    activate.isPending && activate.variables === store.id
                  }
                >
                  {activate.isPending && activate.variables === store.id
                    ? "Activating…"
                    : "Activate"}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Region master (head office)                                        */
/* ------------------------------------------------------------------ */

function CreateRegionDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createRegion = useCreateRegion();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");

  function reset() {
    setName("");
    setCode("");
    setError("");
  }

  function save() {
    if (!name.trim() || !isRealName(name)) {
      setError("Enter a region name using letters, for example West India.");
      return;
    }
    createRegion.mutate(
      {
        name: name.trim(),
        code: code.trim().toUpperCase() || undefined,
      },
      {
        onSuccess: (region) => {
          toast.success(`${region.name} region added`);
          reset();
          onOpenChange(false);
        },
        onError: (err) =>
          toast.error(serverMessage(err) || "Could not create the region."),
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add region</DialogTitle>
          <DialogDescription>
            Regions group branches for setup, reporting, and manager scope.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="region-name">
              Region name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="region-name"
              value={name}
              placeholder="e.g. West India"
              aria-invalid={!!error}
              onChange={(event) => {
                setName(event.target.value);
                if (error) setError("");
              }}
            />
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="region-code">Code</Label>
            <Input
              id="region-code"
              value={code}
              placeholder="e.g. WEST"
              onChange={(event) => setCode(event.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={createRegion.isPending}>
            {createRegion.isPending ? "Adding…" : "Add region"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Add store                                                          */
/* ------------------------------------------------------------------ */

function AddStoreDialog({
  open,
  onOpenChange,
  regions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  regions: StoreRegion[];
}) {
  const createStore = useCreateStore();
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [code, setCode] = useState("");
  const [regionId, setRegionId] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  // Inline validation errors, keyed by field. Cleared per-field on change.
  const [errors, setErrors] = useState<Record<string, string>>({});

  function clearError(field: string) {
    setErrors((prev) => (prev[field] ? { ...prev, [field]: "" } : prev));
  }

  function reset() {
    setName("");
    setCity("");
    setCode("");
    setRegionId("");
    setLatitude("");
    setLongitude("");
    setErrors({});
  }

  function save() {
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = "Store name is required.";
    else if (!isRealName(name))
      next.name = "Enter a real store name (letters, not just a number).";
    if (!city.trim()) next.city = "City is required.";
    if (Object.keys(next).length > 0) {
      setErrors(next);
      toast.error("Please fill in the required fields.");
      return;
    }
    const lat = parseCoord(latitude, "Latitude");
    if (lat === null) return;
    const lng = parseCoord(longitude, "Longitude");
    if (lng === null) return;

    createStore.mutate(
      {
        name: name.trim(),
        city: city.trim(),
        code: code.trim() || undefined,
        regionId: regionId.trim() || undefined,
        latitude: lat,
        longitude: lng,
      },
      {
        onSuccess: (store) => {
          toast.success(
            store.status === "active"
              ? `${store.name} added and activated`
              : `${store.name} added — pending review (set geofence & region to activate)`,
          );
          reset();
          onOpenChange(false);
        },
        onError: (err) =>
          toast.error(serverMessage(err) || "Could not create the store."),
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add store</DialogTitle>
          <DialogDescription>
            Provision a new branch. With a geofence and region it goes live
            immediately; otherwise it stays pending until those are set.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="store-name">
              Store name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="store-name"
              placeholder="e.g. Surat — Main"
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
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="store-city">
                City <span className="text-destructive">*</span>
              </Label>
              <Input
                id="store-city"
                placeholder="e.g. Surat"
                value={city}
                aria-invalid={!!errors.city}
                onChange={(e) => {
                  setCity(e.target.value);
                  clearError("city");
                }}
              />
              {errors.city ? (
                <p className="mt-1 text-xs text-destructive">{errors.city}</p>
              ) : null}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="store-code">Code</Label>
              <Input
                id="store-code"
                placeholder="e.g. SRT-01"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="store-region">Region</Label>
            <Select
              value={regionId || NO_REGION_VALUE}
              onValueChange={(value) =>
                setRegionId(value === NO_REGION_VALUE ? "" : value)
              }
            >
              <SelectTrigger id="store-region" className="w-full">
                <SelectValue placeholder="Select a region" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_REGION_VALUE}>No region yet</SelectItem>
                {regions.map((region) => (
                  <SelectItem key={region.id} value={region.id}>
                    {region.name}
                    {region.code ? ` (${region.code})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="store-lat">Latitude</Label>
              <Input
                id="store-lat"
                inputMode="decimal"
                placeholder="e.g. 21.1702"
                value={latitude}
                onChange={(e) => setLatitude(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="store-lng">Longitude</Label>
              <Input
                id="store-lng"
                inputMode="decimal"
                placeholder="e.g. 72.8311"
                value={longitude}
                onChange={(e) => setLongitude(e.target.value)}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Latitude / longitude anchor geo-tagged attendance for this branch.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={createStore.isPending}>
            {createStore.isPending ? "Adding…" : "Add store"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Edit store (head office)                                           */
/* ------------------------------------------------------------------ */

function EditStoreDialog({
  store,
  onOpenChange,
  regions,
  canChangeRegion,
}: {
  store: AdminStore | null;
  onOpenChange: (open: boolean) => void;
  regions: StoreRegion[];
  canChangeRegion: boolean;
}) {
  const updateStore = useUpdateStore();
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [regionId, setRegionId] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [geofenceRadiusM, setGeofenceRadiusM] = useState("150");
  const [locating, setLocating] = useState(false);
  // Inline validation errors, keyed by field. Cleared per-field on change.
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Re-seed the form whenever a different store is opened.
  const [seededId, setSeededId] = useState<string | null>(null);
  if (store && store.id !== seededId) {
    setSeededId(store.id);
    setName(store.name);
    setCity(store.city);
    setRegionId(store.regionId ?? "");
    setLatitude(store.latitude != null ? String(store.latitude) : "");
    setLongitude(store.longitude != null ? String(store.longitude) : "");
    setGeofenceRadiusM(store.geofenceRadiusM != null ? String(store.geofenceRadiusM) : "150");
    setErrors({});
  }

  function clearError(field: string) {
    setErrors((prev) => (prev[field] ? { ...prev, [field]: "" } : prev));
  }

  function captureCurrentLocation() {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      toast.error("Geolocation is not supported on this browser.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLatitude(pos.coords.latitude.toFixed(6));
        setLongitude(pos.coords.longitude.toFixed(6));
        setLocating(false);
        toast.success("Current GPS coordinates captured!", {
          description: `Lat: ${pos.coords.latitude.toFixed(6)}, Lng: ${pos.coords.longitude.toFixed(6)}`,
        });
      },
      () => {
        setLocating(false);
        toast.error("Could not capture GPS location. Check location permissions.");
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  function save() {
    if (!store) return;
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = "Store name is required.";
    else if (!isRealName(name))
      next.name = "Enter a real store name (letters, not just a number).";
    if (!city.trim()) next.city = "City is required.";
    if (Object.keys(next).length > 0) {
      setErrors(next);
      toast.error("Please fill in the required fields.");
      return;
    }
    const lat = parseCoord(latitude, "Latitude");
    if (lat === null) return;
    const lng = parseCoord(longitude, "Longitude");
    if (lng === null) return;
    const radius = Number(geofenceRadiusM);
    if (!Number.isInteger(radius) || radius < 25 || radius > 2000) {
      toast.error("Geofence radius must be a whole number from 25 to 2,000 metres.");
      return;
    }

    updateStore.mutate(
      {
        id: store.id,
        name: name.trim(),
        city: city.trim(),
        // An empty value is a removal, not "unchanged" — the server reads it
        // that way, and it is the only way to take a branch out of a region.
        ...(canChangeRegion ? { regionId: regionId.trim() } : {}),
        latitude: lat,
        longitude: lng,
        geofenceRadiusM: radius,
      },
      {
        onSuccess: () => {
          toast.success("Store updated successfully");
          onOpenChange(false);
        },
        onError: (err) =>
          toast.error(serverMessage(err) || "Could not update the store."),
      },
    );
  }

  const isPending = store?.status === "pending";

  return (
    <Dialog open={!!store} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit store &amp; geofence</DialogTitle>
          <DialogDescription>
            {isPending
              ? "Set the geofence and region to clear this branch for activation."
              : "Update branch details, GPS coordinates, and geofence radius."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="edit-name">
              Store name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="edit-name"
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
            <Label htmlFor="edit-city">
              City <span className="text-destructive">*</span>
            </Label>
            <Input
              id="edit-city"
              value={city}
              aria-invalid={!!errors.city}
              onChange={(e) => {
                setCity(e.target.value);
                clearError("city");
              }}
            />
            {errors.city ? (
              <p className="mt-1 text-xs text-destructive">{errors.city}</p>
            ) : null}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="edit-region">Region</Label>
            <Select
              value={regionId || NO_REGION_VALUE}
              onValueChange={(value) => setRegionId(value === NO_REGION_VALUE ? "" : value)}
              disabled={!canChangeRegion}
            >
              <SelectTrigger id="edit-region" className="w-full">
                <SelectValue placeholder="Select a region" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_REGION_VALUE}>No region yet</SelectItem>
                {regions.map((region) => (
                  <SelectItem key={region.id} value={region.id}>
                    {region.name}
                    {region.code ? ` (${region.code})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!canChangeRegion ? (
              <p className="text-xs text-muted-foreground">
                Head Office controls region assignments because they determine area-manager access.
              </p>
            ) : null}
          </div>

          {/* Geofence GPS Coordinates */}
          <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Geofence Center &amp; Radius
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={captureCurrentLocation}
                disabled={locating}
                className="h-7 text-xs gap-1.5"
              >
                <MapPin className="h-3 w-3 text-indigo-500" />
                {locating ? "Capturing…" : "Use My Current GPS"}
              </Button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="edit-lat">Latitude</Label>
                <Input
                  id="edit-lat"
                  inputMode="decimal"
                  placeholder="e.g. 19.0606"
                  value={latitude}
                  onChange={(e) => setLatitude(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="edit-lng">Longitude</Label>
                <Input
                  id="edit-lng"
                  inputMode="decimal"
                  placeholder="e.g. 72.8362"
                  value={longitude}
                  onChange={(e) => setLongitude(e.target.value)}
                />
              </div>
            </div>

            <div className="grid gap-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="edit-radius">Geofence Radius (metres)</Label>
                <span className="text-xs font-mono text-muted-foreground">{geofenceRadiusM} m</span>
              </div>
              <Input
                id="edit-radius"
                type="number"
                min={25}
                max={2000}
                value={geofenceRadiusM}
                onChange={(e) => setGeofenceRadiusM(e.target.value)}
                placeholder="150"
              />
              <div className="flex flex-wrap gap-1.5 mt-1">
                {[
                  { label: "60m (Bandra)", val: "60" },
                  { label: "75m (Surat)", val: "75" },
                  { label: "100m", val: "100" },
                  { label: "150m (Standard)", val: "150" },
                ].map((p) => (
                  <Button
                    key={p.val}
                    type="button"
                    variant={geofenceRadiusM === p.val ? "default" : "outline"}
                    size="sm"
                    className="h-6 text-[10px] px-2"
                    onClick={() => setGeofenceRadiusM(p.val)}
                  >
                    {p.label}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={updateStore.isPending}>
            {updateStore.isPending ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Close store (head office)                                          */
/* ------------------------------------------------------------------ */

function CloseStoreDialog({
  store,
  onOpenChange,
}: {
  store: AdminStore | null;
  onOpenChange: (open: boolean) => void;
}) {
  const closeStore = useCloseStore();

  function confirm() {
    if (!store) return;
    closeStore.mutate(store.id, {
      onSuccess: () => {
        toast.success(`${store.name} closed`);
        onOpenChange(false);
      },
      onError: (err) =>
        toast.error(serverMessage(err) || "Could not close the store."),
    });
  }

  return (
    <Dialog open={!!store} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Close store</DialogTitle>
          <DialogDescription>
            {store
              ? `This soft-closes ${store.name}; its history is preserved and it can be reviewed later. The branch will no longer be part of day-to-day operations.`
              : null}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={confirm}
            disabled={closeStore.isPending}
          >
            {closeStore.isPending ? "Closing…" : "Close store"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Add manager                                                        */
/* ------------------------------------------------------------------ */

function AddManagerDialog({
  store,
  onOpenChange,
}: {
  store: AdminStore | null;
  onOpenChange: (open: boolean) => void;
}) {
  const addManager = useAddStoreManager();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  // Once created, keep the login email visible so HO can share it.
  const [createdEmail, setCreatedEmail] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [seededId, setSeededId] = useState<string | null>(null);
  // Inline validation errors, keyed by field. Cleared per-field on change.
  const [errors, setErrors] = useState<Record<string, string>>({});

  function clearError(field: string) {
    setErrors((prev) => (prev[field] ? { ...prev, [field]: "" } : prev));
  }

  // Reset form state when a different store's dialog opens.
  if (store && store.id !== seededId) {
    setSeededId(store.id);
    setName("");
    setEmail("");
    setPhone("");
    setPassword("");
    setCreatedEmail(null);
    setCopied(false);
    setErrors({});
  }

  function save() {
    if (!store) return;
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = "Manager name is required.";
    else if (!isRealName(name))
      next.name = "Enter a real name (letters, not just a number).";
    if (!email.trim()) next.email = "Email is required.";
    else if (!isValidEmail(email)) next.email = "Enter a valid email address.";
    // Phone is optional; only validate/normalise when one is entered.
    const normalizedPhone = phone.trim() ? normalizeIndianMobile(phone) : null;
    if (phone.trim() && !normalizedPhone)
      next.phone = "Enter a valid 10-digit mobile number.";
    if (password.length < 8)
      next.password = "Password must be at least 8 characters.";
    if (Object.keys(next).length > 0) {
      setErrors(next);
      toast.error("Please fill in the required fields.");
      return;
    }
    addManager.mutate(
      {
        storeId: store.id,
        name: name.trim(),
        email: email.trim(),
        phone: normalizedPhone ?? undefined,
        password,
      },
      {
        onSuccess: (created) => {
          toast.success("Manager login created");
          setCreatedEmail(created.email);
        },
        onError: (err) => toast.error(apiErrorMessage(err, "Could not create the login — the email may be in use.")),
      },
    );
  }

  async function copyEmail() {
    if (!createdEmail) return;
    try {
      await navigator.clipboard.writeText(createdEmail);
      setCopied(true);
      toast.success("Email copied");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy — copy it manually.");
    }
  }

  return (
    <Dialog open={!!store} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add store manager</DialogTitle>
          <DialogDescription>
            {store
              ? `Create a login for ${store.name}. They'll sign in and see only this store's scoped system.`
              : null}
          </DialogDescription>
        </DialogHeader>

        {createdEmail ? (
          <div className="grid gap-4">
            <div className="flex flex-col items-center gap-2 rounded-lg border border-[color-mix(in_srgb,var(--gold)_40%,transparent)] bg-[color-mix(in_srgb,var(--gold)_8%,transparent)] p-5 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--gold)]/20">
                <Check className="h-5 w-5 text-gold-strong" />
              </div>
              <p className="text-sm font-medium">Login created</p>
              <p className="text-xs text-muted-foreground">
                Share this email with the manager so they can sign in.
              </p>
            </div>
            <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2">
              <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {createdEmail}
              </span>
              <Button variant="outline" size="sm" onClick={copyEmail}>
                {copied ? (
                  <>
                    <Check className="h-4 w-4" /> Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-4 w-4" /> Copy
                  </>
                )}
              </Button>
            </div>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <>
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="mgr-name">
                  Name <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="mgr-name"
                  placeholder="e.g. Rhea Kapoor"
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
                <Label htmlFor="mgr-email">
                  Email <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="mgr-email"
                  type="email"
                  autoComplete="off"
                  placeholder="manager@caratos.in"
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
                <Label htmlFor="mgr-phone">Phone</Label>
                <Input
                  id="mgr-phone"
                  placeholder="+91 ..."
                  inputMode="tel"
                  value={phone}
                  aria-invalid={!!errors.phone}
                  onChange={(e) => {
                    setPhone(capIndianPhone(e.target.value));
                    clearError("phone");
                  }}
                />
                {errors.phone ? (
                  <p className="mt-1 text-xs text-destructive">{errors.phone}</p>
                ) : null}
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="mgr-password">
                  Temporary password{" "}
                  <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="mgr-password"
                  type="password"
                  autoComplete="new-password"
                  placeholder="At least 8 characters"
                  value={password}
                  aria-invalid={!!errors.password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    clearError("password");
                  }}
                />
                {errors.password ? (
                  <p className="mt-1 text-xs text-destructive">
                    {errors.password}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Share this with the manager; they can change it in Settings.
                  </p>
                )}
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={save} disabled={addManager.isPending}>
                {addManager.isPending ? "Creating…" : "Create login"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Reset password                                                     */
/* ------------------------------------------------------------------ */

function ResetPasswordDialog({
  user,
  onOpenChange,
}: {
  user: StoreManager | null;
  onOpenChange: (open: boolean) => void;
}) {
  const resetPassword = useResetPassword();
  const [newPassword, setNewPassword] = useState("");
  const [touched, setTouched] = useState(false);
  // Re-seed the form whenever the dialog opens (also when it re-opens for
  // the same person after closing).
  const [seededId, setSeededId] = useState<string | null>(null);
  if (user && user.id !== seededId) {
    setSeededId(user.id);
    setNewPassword("");
    setTouched(false);
  }
  if (!user && seededId !== null) {
    setSeededId(null);
    setNewPassword("");
    setTouched(false);
  }

  const tooShort = newPassword.length < 8;
  const showError = touched && tooShort;

  function save() {
    if (!user) return;
    if (tooShort) {
      setTouched(true);
      return;
    }
    resetPassword.mutate(
      { userId: user.id, newPassword },
      {
        onSuccess: () => {
          toast.success("Password updated.");
          onOpenChange(false);
        },
        onError: (err) => {
          const message = serverMessage(err);
          toast.error(message || "Could not update the password.");
        },
      },
    );
  }

  return (
    <Dialog open={!!user} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Reset password</DialogTitle>
          <DialogDescription>
            {user
              ? `Set a new password for ${user.name}. Share it with them privately; they can change it later in Settings.`
              : null}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="reset-password">
            New password <span className="text-destructive">*</span>
          </Label>
          <Input
            id="reset-password"
            type="password"
            autoComplete="new-password"
            placeholder="At least 8 characters"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            onBlur={() => setTouched(true)}
            aria-invalid={showError}
          />
          {showError ? (
            <p className="text-xs text-destructive">
              Password must be at least 8 characters.
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={resetPassword.isPending}>
            {resetPassword.isPending ? "Updating…" : "Update password"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
