"use client";

import { useState } from "react";
import {
  Check,
  Copy,
  Lock,
  Mail,
  Pencil,
  UserPlus,
} from "lucide-react";
import { toast } from "sonner";

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
import {
  useAddStoreManager,
  useCreateStore,
  useStoresAdmin,
  useUpdateStore,
  type AdminStore,
} from "@/lib/queries/stores";
import { useSession } from "@/store/use-session";

const nav = getNavItem("settings/stores")!;

export default function StoreSetupPage() {
  const role = useSession((s) => s.role);
  const [addOpen, setAddOpen] = useState(false);
  const [editStore, setEditStore] = useState<AdminStore | null>(null);
  const [managerStore, setManagerStore] = useState<AdminStore | null>(null);

  const { data: stores = [], isLoading, isError, refetch } = useStoresAdmin();

  // Head-office only. Nav hides this for other roles; guard the page too so a
  // direct URL / a demo role switch can't reach the provisioning controls.
  if (role !== "head_office") {
    return (
      <>
        <SectionHeader title={nav.title} purpose={nav.purpose} />
        <div className="mx-auto max-w-md rounded-xl border bg-muted/30 p-8 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-muted">
            <Lock className="h-5 w-5 text-muted-foreground" />
          </div>
          <p className="text-sm font-medium">Head Office only</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Store provisioning and manager logins are managed by Head Office.
            Switch to the Head Office view to continue.
          </p>
        </div>
      </>
    );
  }

  // The synthetic "All Stores" aggregate is a view, not a branch to manage.
  const manageable = stores.filter((s) => !s.isAggregate);
  const activeCount = manageable.filter((s) => s.isActive).length;

  return (
    <>
      <SectionHeader
        title={nav.title}
        purpose={nav.purpose}
        primaryAction={nav.primaryAction}
        onPrimaryAction={() => setAddOpen(true)}
      />

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
                    ) : store.isActive ? (
                      <Badge variant="success">Active</Badge>
                    ) : (
                      <Badge variant="secondary">Inactive</Badge>
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
                          <li key={m.id} className="leading-tight">
                            <span className="text-sm font-medium">
                              {m.name}
                            </span>
                            <span className="block text-xs text-muted-foreground">
                              {m.email}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {store.isAggregate ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <div className="flex items-center justify-end gap-2">
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
    </>
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

  function parseCoord(value: string, label: string): number | undefined | null {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const num = Number(trimmed);
    if (Number.isNaN(num)) {
      toast.error(`${label} must be a number.`);
      return null; // signals an invalid value
    }
    return num;
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
          toast.success(`${store.name} added`);
          reset();
          onOpenChange(false);
        },
        onError: () => toast.error("Could not create the store."),
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
            Provision a new branch. It becomes its own scoped system — pick it
            in the store switcher after creating a manager login.
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
/* Edit store                                                         */
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
  const [isActive, setIsActive] = useState(true);
  // Re-seed the form whenever a different store is opened.
  const [seededId, setSeededId] = useState<string | null>(null);
  if (store && store.id !== seededId) {
    setSeededId(store.id);
    setName(store.name);
    setCity(store.city);
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
    updateStore.mutate(
      {
        id: store.id,
        name: name.trim(),
        city: city.trim(),
        isActive,
      },
      {
        onSuccess: () => {
          toast.success("Store updated");
          onOpenChange(false);
        },
        onError: () => toast.error("Could not update the store."),
      },
    );
  }

  return (
    <Dialog open={!!store} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit store</DialogTitle>
          <DialogDescription>
            Update branch details. Deactivating hides a store from day-to-day
            operations without deleting its history.
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
        onError: () =>
          toast.error("Could not create the login — the email may be in use."),
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
