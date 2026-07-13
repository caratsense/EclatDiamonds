"use client";

import { useState } from "react";
import { KeyRound, Lock, Mail, Phone, UsersRound } from "lucide-react";
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
import { getNavItem } from "@/lib/navigation";
import { useResetPassword } from "@/lib/queries/auth";
import { useStoresAdmin } from "@/lib/queries/stores";
import {
  useCreateUser,
  useUpdateUserRole,
  useUpdateUserStore,
  useUsers,
  type StaffRole,
  type StaffUser,
} from "@/lib/queries/users";
import { apiErrorMessage } from "@/lib/utils";
import { useSession } from "@/store/use-session";

const nav = getNavItem("settings/team")!;

/** Roles HO can assign here, in rank order (salesperson is the default). */
const ROLE_OPTIONS: { value: StaffRole; label: string }[] = [
  { value: "salesperson", label: "Salesperson" },
  { value: "store_manager", label: "Store Manager" },
  { value: "area_manager", label: "Area Manager" },
];

export default function TeamPage() {
  const role = useSession((s) => s.role);
  const [addOpen, setAddOpen] = useState(false);
  const [resetUser, setResetUser] = useState<StaffUser | null>(null);

  const { data: users = [], isLoading, isError, refetch } = useUsers();

  // Head-office only. Nav hides this for other roles; guard the page too so a
  // direct URL / a demo role switch can't reach the staff controls.
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
            Staff and role assignment are managed by Head Office. Switch to the
            Head Office view to continue.
          </p>
        </div>
      </>
    );
  }

  const activeCount = users.filter((u) => u.isActive).length;

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
          ? "Loading team…"
          : `${users.length} ${
              users.length === 1 ? "person" : "people"
            } · ${activeCount} active`}
      </p>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-16 rounded-xl" />
          ))}
        </div>
      ) : isError ? (
        <div className="mx-auto max-w-md rounded-lg border bg-muted/30 p-4 text-center">
          <p className="text-sm font-medium">Couldn&apos;t load the team.</p>
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
      ) : users.length === 0 ? (
        <EmptyState
          icon={UsersRound}
          title="No staff yet"
          description="Add your first staff member. They can sign in with a WhatsApp OTP using their phone, and you can promote them to a manager here."
          actionLabel={nav.primaryAction}
          onAction={() => setAddOpen(true)}
        />
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead className="w-[190px]">Role</TableHead>
                <TableHead className="w-[220px]">Primary store</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((user) => (
                <UserRow
                  key={user.id}
                  user={user}
                  onReset={() => setResetUser(user)}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <AddStaffDialog open={addOpen} onOpenChange={setAddOpen} />
      <ResetPasswordDialog
        user={resetUser}
        onOpenChange={(open) => !open && setResetUser(null)}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Row — role + store selects live here so each is self-contained     */
/* ------------------------------------------------------------------ */

function UserRow({
  user,
  onReset,
}: {
  user: StaffUser;
  onReset: () => void;
}) {
  const updateRole = useUpdateUserRole();
  const updateStore = useUpdateUserStore();
  const { data: stores = [] } = useStoresAdmin();

  // The synthetic "All Stores" aggregate is a view, not an assignable branch.
  const assignable = stores.filter((s) => !s.isAggregate);
  const primaryStoreId = user.stores[0]?.id ?? "";

  const rolePending =
    updateRole.isPending && updateRole.variables?.id === user.id;
  const storePending =
    updateStore.isPending && updateStore.variables?.id === user.id;

  function changeRole(role: StaffRole) {
    if (role === user.role) return;
    updateRole.mutate(
      { id: user.id, role },
      {
        onSuccess: () => toast.success("Role updated"),
        onError: (err) =>
          toast.error(apiErrorMessage(err, "Could not update the role.")),
      },
    );
  }

  function changeStore(storeId: string) {
    if (storeId === primaryStoreId) return;
    updateStore.mutate(
      { id: user.id, storeId },
      {
        onSuccess: () => toast.success("Primary store updated"),
        onError: (err) =>
          toast.error(apiErrorMessage(err, "Could not reassign the store.")),
      },
    );
  }

  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-2">
          <span className="font-medium">{user.name}</span>
          {!user.isActive ? (
            <Badge variant="secondary">Inactive</Badge>
          ) : null}
        </div>
      </TableCell>
      <TableCell>
        <div className="space-y-0.5 leading-tight">
          {user.phone ? (
            <span className="flex items-center gap-1.5 text-sm">
              <Phone className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="num">{user.phone}</span>
            </span>
          ) : null}
          {user.email ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Mail className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{user.email}</span>
            </span>
          ) : null}
          {!user.phone && !user.email ? (
            <span className="text-muted-foreground">—</span>
          ) : null}
        </div>
      </TableCell>
      <TableCell>
        <Select
          value={user.role}
          onValueChange={(v) => changeRole(v as StaffRole)}
          disabled={rolePending}
        >
          <SelectTrigger aria-label={`Role for ${user.name}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ROLE_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell>
        {assignable.length === 0 ? (
          <span className="text-xs text-muted-foreground">
            {user.stores[0]?.name ?? "—"}
          </span>
        ) : (
          <Select
            value={primaryStoreId || undefined}
            onValueChange={changeStore}
            disabled={storePending}
          >
            <SelectTrigger aria-label={`Primary store for ${user.name}`}>
              <SelectValue placeholder="Assign store" />
            </SelectTrigger>
            <SelectContent>
              {assignable.map((store) => (
                <SelectItem key={store.id} value={store.id}>
                  {store.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </TableCell>
      <TableCell className="text-right">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 px-2 text-xs"
          onClick={onReset}
        >
          <KeyRound className="h-3.5 w-3.5" /> Reset password
        </Button>
      </TableCell>
    </TableRow>
  );
}

/* ------------------------------------------------------------------ */
/* Add staff                                                          */
/* ------------------------------------------------------------------ */

const PHONE_RE = /^\d{10}$/;

function AddStaffDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createUser = useCreateUser();
  const { data: stores = [] } = useStoresAdmin();
  const assignable = stores.filter((s) => !s.isAggregate);

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [storeId, setStoreId] = useState("");
  const [role, setRole] = useState<StaffRole>("salesperson");
  const [touched, setTouched] = useState(false);

  function reset() {
    setName("");
    setPhone("");
    setEmail("");
    setStoreId("");
    setRole("salesperson");
    setTouched(false);
  }

  const nameError = !name.trim();
  const phoneError = phone.trim() !== "" && !PHONE_RE.test(phone.trim());
  const contactError = !phone.trim() && !email.trim();
  const storeError = !storeId;

  function save() {
    setTouched(true);
    if (nameError) {
      toast.error("Name is required.");
      return;
    }
    if (contactError) {
      toast.error("Enter a phone number or an email.");
      return;
    }
    if (phoneError) {
      toast.error("Phone must be a 10-digit number.");
      return;
    }
    if (storeError) {
      toast.error("Select a store.");
      return;
    }

    createUser.mutate(
      {
        name: name.trim(),
        storeId,
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
        role,
      },
      {
        onSuccess: () => {
          toast.success(
            "Staff added — they can sign in with WhatsApp OTP using their phone.",
          );
          reset();
          onOpenChange(false);
        },
        onError: (err) =>
          toast.error(
            apiErrorMessage(
              err,
              "Could not add the staff member — the phone or email may be in use.",
            ),
          ),
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
          <DialogTitle>Add staff</DialogTitle>
          <DialogDescription>
            New staff default to Salesperson. Provide a phone number so they can
            sign in with a WhatsApp OTP, and you can promote them later.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="staff-name">
              Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="staff-name"
              placeholder="e.g. Aarav Shah"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={touched && nameError}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="staff-phone">Phone</Label>
              <Input
                id="staff-phone"
                inputMode="numeric"
                placeholder="10-digit number"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                aria-invalid={touched && (phoneError || contactError)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="staff-email">Email</Label>
              <Input
                id="staff-email"
                type="email"
                autoComplete="off"
                placeholder="name@caratsense.in"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-invalid={touched && contactError}
              />
            </div>
          </div>
          {touched && contactError ? (
            <p className="text-xs text-destructive">
              Enter a phone number or an email so they can sign in.
            </p>
          ) : touched && phoneError ? (
            <p className="text-xs text-destructive">
              Phone must be a 10-digit number.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              A phone number enables WhatsApp OTP sign-in.
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="staff-store">
                Store <span className="text-destructive">*</span>
              </Label>
              <Select value={storeId || undefined} onValueChange={setStoreId}>
                <SelectTrigger
                  id="staff-store"
                  aria-invalid={touched && storeError}
                >
                  <SelectValue placeholder="Select a store" />
                </SelectTrigger>
                <SelectContent>
                  {assignable.map((store) => (
                    <SelectItem key={store.id} value={store.id}>
                      {store.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="staff-role">Role</Label>
              <Select
                value={role}
                onValueChange={(v) => setRole(v as StaffRole)}
              >
                <SelectTrigger id="staff-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={createUser.isPending}>
            {createUser.isPending ? "Adding…" : "Add staff"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Reset password (reuses useResetPassword)                           */
/* ------------------------------------------------------------------ */

function ResetPasswordDialog({
  user,
  onOpenChange,
}: {
  user: StaffUser | null;
  onOpenChange: (open: boolean) => void;
}) {
  const resetPassword = useResetPassword();
  const [newPassword, setNewPassword] = useState("");
  const [touched, setTouched] = useState(false);
  // Re-seed whenever the dialog opens (or re-opens for the same person).
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
        onError: (err) =>
          toast.error(apiErrorMessage(err, "Could not update the password.")),
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
