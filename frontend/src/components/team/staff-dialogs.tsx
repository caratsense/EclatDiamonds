"use client";

/**
 * Changing what a person IS — their role and their store.
 *
 * These lived on Settings -> Team, as row actions beside leave and password
 * resets. The client's point was that "what someone can do" was then managed
 * from two screens: a role grants a bundle of screens from Team, while People &
 * Access grants screens one by one — two doors to the same decision, and two
 * people using different doors is how contradictory changes happen.
 *
 * So the dialogs moved here and mount on People & Access only. Team keeps the
 * directory jobs that are not duplicated anywhere: adding staff, leave quotas,
 * password resets, deactivation, and assigning a store to an account that has
 * none yet (onboarding, not reassignment).
 *
 * Practical consequence, stated rather than implied: People & Access is
 * head-office-only, so store managers can no longer change a role or move
 * somebody between stores from the UI. That is the requested behaviour - the
 * client wants access decisions held at head office.
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useUpdateStaffRole,
  useUpdateStaffStore,
  type StaffRole,
  type StaffUser,
} from "@/lib/queries/users";
import { ROLE_LABELS, ROLE_RANK, type Role } from "@/lib/types";
import { apiErrorMessage } from "@/lib/utils";
import { useSession } from "@/store/use-session";

/** The roles anyone can be given. Area manager and storeperson are retired. */
export const STAFF_ROLES: StaffRole[] = ["salesperson", "marketing", "store_manager"];

/** Only roles below the viewer's own: nobody mints an equal. */
export function assignableRoles(viewer: Role): StaffRole[] {
  return STAFF_ROLES.filter((r) => ROLE_RANK[r] < ROLE_RANK[viewer]);
}

/* ------------------------------------------------------------------ */
/* Change role                                                        */
/* ------------------------------------------------------------------ */

export function ChangeRoleDialog({
  user,
  viewerRole,
  open,
  onOpenChange,
}: {
  user: StaffUser;
  viewerRole: Role;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const updateRole = useUpdateStaffRole();
  const options = assignableRoles(viewerRole);
  const [role, setRole] = useState<StaffRole>(user.role);

  function save() {
    if (role === user.role) {
      onOpenChange(false);
      return;
    }
    updateRole.mutate(
      { id: user.id, role },
      {
        onSuccess: () => {
          toast.success(`${user.name} is now ${ROLE_LABELS[role]}`);
          onOpenChange(false);
        },
        onError: (err) =>
          toast.error(apiErrorMessage(err, "Could not update the role.")),
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) setRole(user.role);
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Change role</DialogTitle>
          <DialogDescription>
            Set the role for {user.name}. You can only grant roles below your
            own.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="change-role">Role</Label>
          <Select value={role} onValueChange={(v) => setRole(v as StaffRole)}>
            <SelectTrigger id="change-role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((r) => (
                <SelectItem key={r} value={r}>
                  {ROLE_LABELS[r]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={updateRole.isPending}>
            {updateRole.isPending ? "Saving…" : "Save role"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Reassign store                                                     */
/* ------------------------------------------------------------------ */

export function ReassignStoreDialog({
  user,
  open,
  onOpenChange,
}: {
  user: StaffUser;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const updateStore = useUpdateStaffStore();
  const stores = useSession((s) => s.stores);
  const assignable = useMemo(
    () => stores.filter((s) => !s.isAggregate),
    [stores],
  );
  const primaryStoreId = user.stores[0]?.id ?? "";
  const [storeId, setStoreId] = useState(primaryStoreId);

  function save() {
    if (!storeId) {
      toast.error("Select a store.");
      return;
    }
    if (storeId === primaryStoreId) {
      onOpenChange(false);
      return;
    }
    updateStore.mutate(
      { id: user.id, storeId },
      {
        onSuccess: () => {
          toast.success("Store reassigned");
          onOpenChange(false);
        },
        onError: (err) =>
          toast.error(apiErrorMessage(err, "Could not reassign the store.")),
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) setStoreId(primaryStoreId);
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Reassign store</DialogTitle>
          <DialogDescription>
            Move {user.name} to another store within your scope.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="reassign-store">Store</Label>
          <Select value={storeId || undefined} onValueChange={setStoreId}>
            <SelectTrigger id="reassign-store">
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
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={updateStore.isPending}>
            {updateStore.isPending ? "Saving…" : "Reassign"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

