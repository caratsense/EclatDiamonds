"use client";

import { useState } from "react";
import {
  Check,
  Copy,
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
  useCreateStore,
  usePendingStores,
  useStoresAdmin,
  useUpdateStore,
  type AdminStore,
  type PendingStore,
  type StoreManager,
  type StoreStatus,
} from "@/lib/queries/stores";
import { ROLE_RANK } from "@/lib/types";
import { useSession } from "@/store/use-session";
import { apiErrorMessage } from "@/lib/utils";

const nav = getNavItem("settings/stores")!;

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
  const role = useSession((s) => s.role);
  const isHeadOffice = role === "head_office";
  const [addOpen, setAddOpen] = useState(false);
  const [editStore, setEditStore] = useState<AdminStore | null>(null);
  const [managerStore, setManagerStore] = useState<AdminStore | null>(null);
  const [closeStore, setCloseStore] = useState<AdminStore | null>(null);
  const [resetUser, setResetUser] = useState<StoreManager | null>(null);

  const { data: stores = [], isLoading, isError, refetch } = useStoresAdmin();
  const { data: pending = [] } = usePendingStores();

  // Store lifecycle is managed by area managers and Head Office. Nav hides
  // this for lower roles; guard the page too so a direct URL / a demo role
  // switch can't reach the provisioning controls.
  if (ROLE_RANK[role] < ROLE_RANK.head_office) {
    return (
      <>
        <SectionHeader title={nav.title} purpose={nav.purpose} />
        <div className="mx-auto max-w-md rounded-xl border bg-muted/30 p-8 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-muted">
            <Lock className="h-5 w-5 text-muted-foreground" />
          </div>
          <p className="text-sm font-medium">Area Manager access required</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Store provisioning and lifecycle are managed by Area Managers and
            Head Office. Switch to a higher role to continue.
          </p>
        </div>
      </>
    );
  }

  // The synthetic "All Stores" aggregate is a view, not a branch to manage.
  const manageable = stores.filter((s) => !s.isAggregate);
  const activeCount = manageable.filter((s) => s.status === "active").length;

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
        primaryAction={nav.primaryAction}
        onPrimaryAction={() => setAddOpen(true)}
      />

      {pending.length > 0 ? (
        <PendingReviewSection
          pending={pending}
          isHeadOffice={isHeadOffice}
          onFixDetails={openEditById}
        />
      ) : null}

      <p className="mb-4 text-sm text-muted-foreground">
        {isLoading
          ? "Loading stores…"
          : `${manageable.length} ${
              manageable.length === 1 ? "store" : "stores"
            } provisioned · ${activeCount} active`}
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
              {stores.map((store) => (
                <TableRow key={store.id}>
                  <TableCell className="font-medium">{store.name}</TableCell>
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
                    {store.isAggregate || !isHeadOffice ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <div className="flex items-center justify-end gap-2">
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
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setManagerStore(store)}
                        >
                          <UserPlus className="h-4 w-4" /> Add manager
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditStore(store)}
                        >
                          <Pencil className="h-4 w-4" /> Edit
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {stores.length === 0 ? (
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

      <AddStoreDialog open={addOpen} onOpenChange={setAddOpen} />
      <EditStoreDialog
        store={editStore}
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
/* Add store                                                          */
/* ------------------------------------------------------------------ */

function AddStoreDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createStore = useCreateStore();
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [code, setCode] = useState("");
  const [regionId, setRegionId] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");

  function reset() {
    setName("");
    setCity("");
    setCode("");
    setRegionId("");
    setLatitude("");
    setLongitude("");
  }

  function save() {
    if (!name.trim()) {
      toast.error("Store name is required.");
      return;
    }
    if (!city.trim()) {
      toast.error("City is required.");
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
              onChange={(e) => setName(e.target.value)}
            />
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
                onChange={(e) => setCity(e.target.value)}
              />
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
            <Input
              id="store-region"
              placeholder="e.g. west-gujarat"
              value={regionId}
              onChange={(e) => setRegionId(e.target.value)}
            />
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
}: {
  store: AdminStore | null;
  onOpenChange: (open: boolean) => void;
}) {
  const updateStore = useUpdateStore();
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [regionId, setRegionId] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [isActive, setIsActive] = useState(true);
  // Re-seed the form whenever a different store is opened.
  const [seededId, setSeededId] = useState<string | null>(null);
  if (store && store.id !== seededId) {
    setSeededId(store.id);
    setName(store.name);
    setCity(store.city);
    setRegionId(store.regionId ?? "");
    setLatitude(store.latitude != null ? String(store.latitude) : "");
    setLongitude(store.longitude != null ? String(store.longitude) : "");
    setIsActive(store.isActive);
  }

  function save() {
    if (!store) return;
    if (!name.trim()) {
      toast.error("Store name is required.");
      return;
    }
    if (!city.trim()) {
      toast.error("City is required.");
      return;
    }
    const lat = parseCoord(latitude, "Latitude");
    if (lat === null) return;
    const lng = parseCoord(longitude, "Longitude");
    if (lng === null) return;

    updateStore.mutate(
      {
        id: store.id,
        name: name.trim(),
        city: city.trim(),
        regionId: regionId.trim() || undefined,
        latitude: lat,
        longitude: lng,
        isActive,
      },
      {
        onSuccess: () => {
          toast.success("Store updated");
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
          <DialogTitle>Edit store</DialogTitle>
          <DialogDescription>
            {isPending
              ? "Set the geofence and region to clear this branch for activation."
              : "Update branch details, geofence and region."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="edit-name">Store name</Label>
            <Input
              id="edit-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="edit-city">City</Label>
            <Input
              id="edit-city"
              value={city}
              onChange={(e) => setCity(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="edit-region">Region</Label>
            <Input
              id="edit-region"
              placeholder="e.g. west-gujarat"
              value={regionId}
              onChange={(e) => setRegionId(e.target.value)}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="edit-lat">Latitude</Label>
              <Input
                id="edit-lat"
                inputMode="decimal"
                placeholder="e.g. 21.1702"
                value={latitude}
                onChange={(e) => setLatitude(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="edit-lng">Longitude</Label>
              <Input
                id="edit-lng"
                inputMode="decimal"
                placeholder="e.g. 72.8311"
                value={longitude}
                onChange={(e) => setLongitude(e.target.value)}
              />
            </div>
          </div>
          <div className="flex items-center justify-between gap-4 rounded-lg border bg-muted/30 px-4 py-3">
            <div>
              <p className="text-sm font-medium">Active</p>
              <p className="text-xs text-muted-foreground">
                {isActive
                  ? "Store is live and available in the switcher."
                  : "Store is hidden from day-to-day operations."}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={isActive}
              aria-label="Toggle store active"
              onClick={() => setIsActive((v) => !v)}
              className={
                "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring " +
                (isActive ? "bg-primary" : "bg-input")
              }
            >
              <span
                className={
                  "inline-block h-5 w-5 transform rounded-full bg-background shadow-sm transition-transform " +
                  (isActive ? "translate-x-5" : "translate-x-0.5")
                }
              />
            </button>
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

  // Reset form state when a different store's dialog opens.
  if (store && store.id !== seededId) {
    setSeededId(store.id);
    setName("");
    setEmail("");
    setPhone("");
    setPassword("");
    setCreatedEmail(null);
    setCopied(false);
  }

  function save() {
    if (!store) return;
    if (!name.trim()) {
      toast.error("Manager name is required.");
      return;
    }
    if (!email.trim()) {
      toast.error("Email is required.");
      return;
    }
    if (password.length < 8) {
      toast.error("Password must be at least 8 characters.");
      return;
    }
    addManager.mutate(
      {
        storeId: store.id,
        name: name.trim(),
        email: email.trim(),
        phone: phone.trim() || undefined,
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
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="mgr-email">
                  Email <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="mgr-email"
                  type="email"
                  autoComplete="off"
                  placeholder="manager@caratsense.in"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="mgr-phone">Phone</Label>
                <Input
                  id="mgr-phone"
                  placeholder="+91 ..."
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
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
                  onChange={(e) => setPassword(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Share this with the manager; they can change it in Settings.
                </p>
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
