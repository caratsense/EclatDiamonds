"use client";

/**
 * The per-person staff actions, shared by Team and People & Access (client,
 * 10 Oct: one staff screen — these dialogs must not live inside a page).
 * Moved verbatim from settings/team/page.tsx.
 */

import { useMemo, useState } from "react";
import { toast } from "sonner";

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
import { useResetPassword } from "@/lib/queries/auth";
import {
  useCreateStaff,
  useDeactivateStaff,
  useSetLeaveAllocation,
  useUpdateStaffDetails,
  type StaffRole,
  type StaffUser,
} from "@/lib/queries/users";
import { useSession } from "@/store/use-session";
import { ROLE_LABELS, ROLE_RANK, type Role } from "@/lib/types";
import {
  apiErrorMessage,
  isRealName,
  isValidEmail,
  normalizeIndianMobile,
  phoneInputValue,
} from "@/lib/utils";
import { addStaffInput, staffAddedNote } from "@/app/(app)/settings/team/add-staff";

const LEAVE_TYPES: { value: "casual" | "sick" | "earned" | "festival"; label: string }[] = [
  { value: "casual", label: "Casual" },
  { value: "sick", label: "Sick" },
  { value: "earned", label: "Earned" },
  { value: "festival", label: "Festival" },
];
const NO_HANDOFF = "__none__";

function assignableRoles(viewer: Role): StaffRole[] {
  const order: StaffRole[] = ["salesperson", "storeperson", "store_manager", "area_manager"];
  return order.filter((r) => ROLE_RANK[r] < ROLE_RANK[viewer]);
}

export function EditDetailsDialog({
  user,
  open,
  onOpenChange,
}: {
  user: StaffUser;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const update = useUpdateStaffDetails();
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email ?? "");
  const [phone, setPhone] = useState(user.phone ?? "");

  const save = () => {
    update.mutate(
      {
        id: user.id,
        ...(name.trim() && name.trim() !== user.name ? { name: name.trim() } : {}),
        ...(email.trim() && email.trim() !== (user.email ?? "") ? { email: email.trim() } : {}),
        ...(phone.trim() !== (user.phone ?? "") ? { phone: phone.trim() } : {}),
      },
      {
        onSuccess: () => {
          toast.success(`${name.trim() || user.name} updated.`);
          onOpenChange(false);
        },
        onError: (e) => toast.error(apiErrorMessage(e, "Could not save the changes.")),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Edit {user.name}</DialogTitle>
          <DialogDescription>
            Fix a detail in place — nothing else about the person changes.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor={`edit-name-${user.id}`}>Name</Label>
            <Input id={`edit-name-${user.id}`} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`edit-email-${user.id}`}>Login ID</Label>
            <Input
              id={`edit-email-${user.id}`}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              What they sign in with. Must be unique.
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`edit-phone-${user.id}`}>Phone</Label>
            <Input
              id={`edit-phone-${user.id}`}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              maxLength={10}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={update.isPending}>
            {update.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function LeaveQuotaDialog({
  user,
  open,
  onOpenChange,
}: {
  user: StaffUser;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const setQuota = useSetLeaveAllocation();
  const year = new Date().getFullYear();
  const [type, setType] =
    useState<"casual" | "sick" | "earned" | "festival">("casual");
  const [days, setDays] = useState("12");

  function save() {
    const allocated = Number(days);
    if (!Number.isFinite(allocated) || allocated < 0) {
      toast.error("Enter a valid number of days.");
      return;
    }
    setQuota.mutate(
      { id: user.id, type, year, allocated },
      {
        onSuccess: () => {
          toast.success(`${user.name}: ${allocated} ${type} day(s) for ${year}`);
          onOpenChange(false);
        },
        onError: (err) =>
          toast.error(apiErrorMessage(err, "Could not set the leave quota.")),
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) {
          setType("casual");
          setDays("12");
        }
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Leave quota</DialogTitle>
          <DialogDescription>
            Set how many days of a leave type {user.name} may take in {year}.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="leave-type">Leave type</Label>
            <Select value={type} onValueChange={(v) => setType(v as typeof type)}>
              <SelectTrigger id="leave-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LEAVE_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="leave-days">Days allowed in {year}</Label>
            <Input
              id="leave-days"
              inputMode="numeric"
              value={days}
              onChange={(e) => setDays(e.target.value.replace(/[^\d.]/g, ""))}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={setQuota.isPending}>
            {setQuota.isPending ? "Saving…" : "Save quota"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DeactivateDialog({
  user,
  roster,
  open,
  onOpenChange,
}: {
  user: StaffUser;
  roster: StaffUser[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const deactivate = useDeactivateStaff();
  const [reassignToId, setReassignToId] = useState<string>(NO_HANDOFF);

  const leaverStoreId = user.stores[0]?.id;
  // Other active staff in the same store are eligible to inherit the workload.
  const candidates = useMemo(
    () =>
      roster.filter(
        (u) =>
          u.id !== user.id &&
          u.isActive &&
          leaverStoreId != null &&
          u.stores.some((s) => s.id === leaverStoreId),
      ),
    [roster, user.id, leaverStoreId],
  );

  function confirm() {
    deactivate.mutate(
      {
        id: user.id,
        reassignToId:
          reassignToId === NO_HANDOFF ? undefined : reassignToId,
      },
      {
        onSuccess: () => {
          toast.success(`${user.name} deactivated`);
          onOpenChange(false);
        },
        onError: (err) =>
          toast.error(apiErrorMessage(err, "Could not deactivate this member.")),
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) setReassignToId(NO_HANDOFF);
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Deactivate {user.name}?</DialogTitle>
          <DialogDescription>
            They will lose access immediately. Any open leads and walk-ins they
            own can be handed off to another team member so nothing is dropped.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="handoff">Hand off their leads &amp; walk-ins to</Label>
          <Select value={reassignToId} onValueChange={setReassignToId}>
            <SelectTrigger id="handoff">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_HANDOFF}>
                No hand-off (leave unassigned)
              </SelectItem>
              {candidates.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name} · {ROLE_LABELS[c.role]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {candidates.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No other active staff in this store to hand off to.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Their open leads and customers will move to this person.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={confirm}
            disabled={deactivate.isPending}
          >
            {deactivate.isPending ? "Deactivating…" : "Deactivate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AddStaffDialog({
  open,
  onOpenChange,
  viewerRole,
  roster,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  viewerRole: Role;
  roster: StaffUser[];
}) {
  const createStaff = useCreateStaff();
  const stores = useSession((s) => s.stores);
  const assignable = useMemo(
    () => stores.filter((s) => !s.isAggregate),
    [stores],
  );
  const roleOptions = useMemo(
    () => assignableRoles(viewerRole),
    [viewerRole],
  );

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [storeId, setStoreId] = useState("");
  const [role, setRole] = useState<StaffRole>("salesperson");
  const [password, setPassword] = useState("");
  const [touched, setTouched] = useState(false);

  function reset() {
    setName("");
    setPhone("");
    setEmail("");
    setStoreId("");
    setRole("salesperson");
    setPassword("");
    setTouched(false);
  }

  // Team add requires BOTH a valid phone and a valid email (confirmed rule).
  // Reuse the shared validators; the backend enforces the same on POST /users.
  // A name must actually be a name — reject a phone number / id typed here.
  const nameError = !name.trim() || !isRealName(name);
  const normalizedPhone = normalizeIndianMobile(phone);
  const phoneError = normalizedPhone == null;
  const emailError = !isValidEmail(email);
  const storeError = !storeId;
  // Optional, but if given it must pass the same rule as Reset password.
  const passwordError = password.length > 0 && password.length < 8;

  function save() {
    setTouched(true);
    if (!name.trim()) {
      toast.error("Name is required.");
      return;
    }
    if (!isRealName(name)) {
      toast.error("Enter a real name (letters, not just a number).");
      return;
    }
    if (!phone.trim()) {
      toast.error("Phone number is required.");
      return;
    }
    if (phoneError) {
      toast.error("Enter a valid 10-digit mobile number.");
      return;
    }
    if (!email.trim()) {
      toast.error("Email is required.");
      return;
    }
    if (emailError) {
      toast.error("Enter a valid email address.");
      return;
    }
    if (storeError) {
      toast.error("Select a store.");
      return;
    }
    if (passwordError) {
      toast.error("Password must be at least 8 characters.");
      return;
    }

    const input = addStaffInput({ name, phone, email, storeId, role, password });
    createStaff.mutate(input, {
      onSuccess: (created) => {
        toast.success(`${created.name} added`, {
          description: staffAddedNote(created, input, roster),
          duration: 10_000,
        });
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
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      {/* Taller than a phone screen once every field stacks, so it scrolls and
          Cancel and Close stay within reach. */}
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add staff</DialogTitle>
          <DialogDescription>
            New staff default to Salesperson. Give them a password and they can
            sign in straight away with their mobile number. We also generate a
            unique Login ID for them in your organisation’s Login ID format, and
            show it to you once they are added. You can promote them later.
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
            {touched && !name.trim() ? (
              <p className="text-xs text-destructive">Name is required.</p>
            ) : touched && !isRealName(name) ? (
              <p className="text-xs text-destructive">
                Enter a real name (letters, not just a number).
              </p>
            ) : null}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="staff-phone">
                Phone <span className="text-destructive">*</span>
              </Label>
              <Input
                id="staff-phone"
                inputMode="numeric"
                maxLength={10}
                placeholder="10-digit number"
                value={phone}
                onChange={(e) => setPhone(phoneInputValue(e.target.value))}
                aria-invalid={touched && phoneError}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="staff-email">
                Personal email <span className="text-destructive">*</span>
              </Label>
              <Input
                id="staff-email"
                type="email"
                autoComplete="off"
                placeholder="name@caratos.in"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-invalid={touched && emailError}
              />
            </div>
          </div>
          {touched && phoneError ? (
            <p className="text-xs text-destructive">
              Enter a valid 10-digit mobile number.
            </p>
          ) : touched && emailError ? (
            <p className="text-xs text-destructive">
              Enter a valid email address.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Phone and email are both required. The phone number is also what
              they sign in with.
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
              {roleOptions.length <= 1 ? (
                <div className="flex h-9 items-center rounded-md border bg-muted/40 px-3 text-sm text-muted-foreground">
                  {ROLE_LABELS[roleOptions[0] ?? "salesperson"]}
                </div>
              ) : (
                <Select
                  value={role}
                  onValueChange={(v) => setRole(v as StaffRole)}
                >
                  <SelectTrigger id="staff-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {roleOptions.map((r) => (
                      <SelectItem key={r} value={r}>
                        {ROLE_LABELS[r]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="staff-password">Password</Label>
            <Input
              id="staff-password"
              type="password"
              autoComplete="new-password"
              placeholder="At least 8 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={touched && passwordError}
            />
            {touched && passwordError ? (
              <p className="text-xs text-destructive">
                Password must be at least 8 characters.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Share it with them privately; they can change it later in
                Settings. Leave it blank to set one later with Reset password.
              </p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              // Cancel keeps the rest of the form as before, but never a typed
              // password: it must not wait in a closed dialog and end up as
              // the next person's.
              setPassword("");
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button onClick={save} disabled={createStaff.isPending}>
            {createStaff.isPending ? "Adding…" : "Add staff"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ResetPasswordDialog({
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
