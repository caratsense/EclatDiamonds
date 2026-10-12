"use client";

import { useMemo, useState } from "react";
import { Pencil, Trash2,
  Building2,
  CalendarDays,
  Check,
  KeyRound,
  Lock,
  MoreHorizontal,
  Phone,
  Shield,
  UserCheck,
  UserMinus,
  UserPlus,
  UsersRound,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { SectionHeader } from "@/components/section/section-header";
import {
  AddStaffDialog,
  DeactivateDialog,
  EditDetailsDialog,
  LeaveQuotaDialog,
  ResetPasswordDialog,
} from "@/components/team/staff-action-dialogs";
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
import { Textarea } from "@/components/ui/textarea";
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
  useDeleteStaff,
  useActivateStaff,
  useApproveSignup,
  usePendingSignups,
  useRejectSignup,
  useSaveSignupPolicy,
  useSignupPolicy,
  useStaff,
  useUnassignedStaff,
  useUpdateStaffStore,
  type ApprovalEmailDelivery,
  type PendingSignup,
  type StaffRole,
  type StaffUser,
} from "@/lib/queries/users";
import { ROLE_LABELS, ROLE_RANK, type Role } from "@/lib/types";
import {
  apiErrorMessage,
  cn,
} from "@/lib/utils";
import { useSession } from "@/store/use-session";


const nav = getNavItem("settings/team")!;

/** Roles assignable from this page, in rank order (salesperson is the default). */
const STAFF_ROLES: StaffRole[] = ["salesperson", "marketing", "store_manager", "area_manager"];

/**
 * The roles a given viewer may grant — strictly below their own rank, mirroring
 * the server rule. store_manager → salesperson; head_office → everything, which
 * now includes area_manager again (revived 7 Oct on the client's ask — one
 * person over 4-5 branches). Keeps the UI from ever offering an illegal role.
 */
function assignableRoles(viewer: Role): StaffRole[] {
  const below = STAFF_ROLES.filter((r) => ROLE_RANK[r] < ROLE_RANK[viewer]);
  // Head office may mint an equal — creation only; managing an existing head
  // office account stays impossible from the UI (the server refuses it).
  return viewer === "head_office" ? [...below, "head_office"] : below;
}

function roleBadge(role: StaffRole) {
  return <Badge variant="secondary">{ROLE_LABELS[role]}</Badge>;
}

export default function TeamPage() {
  const viewerRole = useSession((s) => s.role);
  const [addOpen, setAddOpen] = useState(false);

  const {
    data: staff = [],
    isLoading,
    isError,
    refetch,
  } = useStaff();

  // store_manager and above. Nav hides this for salespeople; guard the page too
  // so a direct URL / a demo role switch can't reach the staff controls.
  if (ROLE_RANK[viewerRole] < ROLE_RANK.store_manager) {
    return (
      <>
        <SectionHeader title={nav.title} purpose={nav.purpose} />
        <div className="mx-auto max-w-md rounded-xl border bg-muted/30 p-8 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-muted">
            <Lock className="h-5 w-5 text-muted-foreground" />
          </div>
          <p className="text-sm font-medium">Managers only</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Staff and role assignment are managed by store managers and above.
          </p>
        </div>
      </>
    );
  }

  const activeCount = staff.filter((u) => u.isActive).length;

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
          : `${staff.length} ${
              staff.length === 1 ? "person" : "people"
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
      ) : staff.length === 0 ? (
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
                <TableHead className="w-[150px]">Role</TableHead>
                <TableHead className="w-[220px]">Stores</TableHead>
                <TableHead className="w-[110px]">Status</TableHead>
                <TableHead className="w-[64px] text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {staff.map((user) => (
                <UserRow
                  key={user.id}
                  user={user}
                  viewerRole={viewerRole}
                  roster={staff}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <PendingSignups viewerRole={viewerRole} />

      {viewerRole === "head_office" ? <SignupPolicyCard /> : null}

      <PendingAssignment viewerRole={viewerRole} />

      <AddStaffDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        viewerRole={viewerRole}
        roster={staff}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Roster row + its action dialogs                                    */
/* ------------------------------------------------------------------ */

function UserRow({
  user,
  viewerRole,
  roster,
}: {
  user: StaffUser;
  viewerRole: Role;
  roster: StaffUser[];
}) {
  const [dialog, setDialog] = useState<
    "deactivate" | "reset" | "leave" | "edit" | null>(null);

  const activate = useActivateStaff();

  // Never act on a peer or a superior — hide every action in that case.
  const canManage = ROLE_RANK[user.role] < ROLE_RANK[viewerRole];
  const canRoleOrStore = ROLE_RANK[viewerRole] >= ROLE_RANK.store_manager;
  const canDeactivate = ROLE_RANK[viewerRole] >= ROLE_RANK.store_manager;
  const deleteStaff = useDeleteStaff();
  // Deleting is deliberate: first tap arms, second deletes. The server refuses
  // anyone with history and names what they hold.
  const [armDelete, setArmDelete] = useState(false);
  const onDelete = (e: Event) => {
    if (!armDelete) {
      e.preventDefault(); // keep the menu open for the second tap
      setArmDelete(true);
      return;
    }
    deleteStaff.mutate(user.id, {
      onSuccess: () => toast.success(`${user.name} deleted.`),
      onError: (err) => toast.error(apiErrorMessage(err, "Could not delete.")),
      onSettled: () => setArmDelete(false),
    });
  };

  function reactivate() {
    activate.mutate(
      { id: user.id },
      {
        onSuccess: () => toast.success(`${user.name} reactivated`),
        onError: (err) =>
          toast.error(apiErrorMessage(err, "Could not reactivate this member.")),
      },
    );
  }

  const hasAnyAction =
    canManage &&
    (canRoleOrStore || canDeactivate);

  return (
    <TableRow className={cn(!user.isActive && "opacity-70")}>
      <TableCell>
        <span className="font-medium">{user.name}</span>
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
            <span
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
              title="Login ID — a sign-in identifier, not an inbox"
            >
              <KeyRound className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{user.email}</span>
            </span>
          ) : null}
          {!user.phone && !user.email ? (
            <span className="text-muted-foreground">—</span>
          ) : null}
        </div>
      </TableCell>
      <TableCell>{roleBadge(user.role)}</TableCell>
      <TableCell>
        {user.stores.length ? (
          <div className="flex flex-wrap gap-1">
            {user.stores.map((s) => (
              <Badge key={s.id} variant="outline" className="font-normal">
                {s.name}
              </Badge>
            ))}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">Unassigned</span>
        )}
      </TableCell>
      <TableCell>
        {user.isActive ? (
          <Badge variant="outline" className="border-emerald-600/30 text-emerald-700">
            Active
          </Badge>
        ) : (
          <Badge variant="secondary">Inactive</Badge>
        )}
      </TableCell>
      <TableCell className="text-right">
        {!hasAnyAction ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                aria-label={`Actions for ${user.name}`}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {canRoleOrStore ? (
                <>
                </>
              ) : null}
              <DropdownMenuItem onSelect={() => setDialog("edit")}>
                <Pencil className="h-4 w-4" /> Edit details
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setDialog("leave")}>
                <CalendarDays className="h-4 w-4" /> Set leave quota
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setDialog("reset")}>
                <KeyRound className="h-4 w-4" /> Reset password
              </DropdownMenuItem>
              {canDeactivate ? (
                <>
                  <DropdownMenuSeparator />
                  {user.isActive ? (
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onSelect={() => setDialog("deactivate")}
                    >
                      <UserMinus className="h-4 w-4" /> Deactivate
                    </DropdownMenuItem>
                  ) : null}
                  {viewerRole === "head_office" ? (
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onSelect={onDelete}
                      disabled={deleteStaff.isPending}
                      title="Only an account with no history can be deleted"
                    >
                      <Trash2 className="h-4 w-4" />
                      {armDelete ? "Tap again to delete" : "Delete"}
                    </DropdownMenuItem>
                  ) : null}
                  {!user.isActive ? (
                    <DropdownMenuItem
                      onSelect={reactivate}
                      disabled={activate.isPending}
                    >
                      <UserCheck className="h-4 w-4" /> Reactivate
                    </DropdownMenuItem>
                  ) : null}
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </TableCell>

<DeactivateDialog
        user={user}
        roster={roster}
        open={dialog === "deactivate"}
        onOpenChange={(o) => setDialog(o ? "deactivate" : null)}
      />
      <ResetPasswordDialog
        user={dialog === "reset" ? user : null}
        onOpenChange={(o) => setDialog(o ? "reset" : null)}
      />
      <LeaveQuotaDialog
        user={user}
        open={dialog === "leave"}
        onOpenChange={(o) => setDialog(o ? "leave" : null)}
      />
      <EditDetailsDialog
        user={user}
        open={dialog === "edit"}
        onOpenChange={(o) => setDialog(o ? "edit" : null)}
      />
    </TableRow>
  );
}

/* ------------------------------------------------------------------ */
/* Edit details (client, 9 Oct): fix a person without recreating them */
/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ */
/* Leave quota (yearly entitlement per leave type)                    */
/* ------------------------------------------------------------------ */



/* ------------------------------------------------------------------ */
/* Deactivate (with lead / walk-in hand-off)                          */
/* ------------------------------------------------------------------ */



/* ------------------------------------------------------------------ */
/* Pending assignment — users with no store link yet                  */
/* ------------------------------------------------------------------ */

function PendingAssignment({ viewerRole }: { viewerRole: Role }) {
  const { data: pending = [], isLoading } = useUnassignedStaff();

  if (isLoading || pending.length === 0) return null;

  return (
    <div className="mt-8">
      <div className="mb-3 flex items-center gap-2">
        <Building2 className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Pending assignment</h2>
        <Badge variant="secondary">{pending.length}</Badge>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        These accounts are set up but not yet linked to a store. Assign each to a
        store so they can start working.
      </p>
      <div className="rounded-xl border divide-y">
        {pending.map((user) => (
          <PendingRow key={user.id} user={user} viewerRole={viewerRole} />
        ))}
      </div>
    </div>
  );
}

function PendingRow({
  user,
  viewerRole,
}: {
  user: StaffUser;
  viewerRole: Role;
}) {
  const updateStore = useUpdateStaffStore();
  const stores = useSession((s) => s.stores);
  const assignable = useMemo(
    () => stores.filter((s) => !s.isAggregate),
    [stores],
  );
  const [storeId, setStoreId] = useState("");

  function assign(next: string) {
    setStoreId(next);
    updateStore.mutate(
      { id: user.id, storeId: next },
      {
        onSuccess: () => toast.success(`${user.name} assigned`),
        onError: (err) => {
          setStoreId("");
          toast.error(apiErrorMessage(err, "Could not assign the store."));
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium">{user.name}</span>
          {roleBadge(user.role)}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {user.phone ? <span className="num">{user.phone}</span> : null}
          {user.phone && user.email ? " · " : null}
          {user.email ? <span>{user.email}</span> : null}
          {!user.phone && !user.email ? "No contact on file" : null}
        </div>
      </div>
      <div className="w-full sm:w-64">
        <Select
          value={storeId || undefined}
          onValueChange={assign}
          disabled={updateStore.isPending}
        >
          <SelectTrigger aria-label={`Assign ${user.name} to a store`}>
            <SelectValue placeholder="Assign to store" />
          </SelectTrigger>
          <SelectContent>
            {assignable.map((store) => (
              <SelectItem key={store.id} value={store.id}>
                {store.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {ROLE_RANK[viewerRole] < ROLE_RANK.area_manager ? (
          <p className="mt-1 text-[11px] text-muted-foreground">
            Store assignment may require an area manager.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Self-signup approval queue                                         */
/* ------------------------------------------------------------------ */

/** Roles an approver may grant on a request: below their own rank; managers by head office only. */
function approvableRoles(viewer: Role): StaffRole[] {
  return assignableRoles(viewer).filter(
    (r) => ROLE_RANK[r] < ROLE_RANK.store_manager || viewer === "head_office",
  );
}

const DELIVERY_NOTE: Record<ApprovalEmailDelivery, string> = {
  sent: "We emailed them their Login ID.",
  dry_run: "Email is not set up, so nothing was sent — share the Login ID with them.",
  failed: "The approval email could not be sent — share the Login ID with them.",
  no_contact_email: "They gave no contact email — share the Login ID with them.",
};

function PendingSignups({ viewerRole }: { viewerRole: Role }) {
  const { data: pending = [], isLoading } = usePendingSignups();

  if (isLoading || pending.length === 0) return null;

  return (
    <div className="mt-8">
      <div className="mb-3 flex items-center gap-2">
        <UserPlus className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Account requests</h2>
        <Badge variant="secondary">{pending.length}</Badge>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        People who signed up and are waiting for approval. You see the requests
        you are allowed to decide. Approving grants the role and links them to
        the store; they can then sign in with their Login ID.
      </p>
      <div className="rounded-xl border divide-y">
        {pending.map((p) => (
          <SignupRequestRow key={p.id} req={p} viewerRole={viewerRole} />
        ))}
      </div>
    </div>
  );
}

function SignupRequestRow({ req, viewerRole }: { req: PendingSignup; viewerRole: Role }) {
  const [dialog, setDialog] = useState<"approve" | "reject" | null>(null);

  return (
    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{req.name}</span>
          {roleBadge(req.requestedRole)}
          {req.requestedStore ? (
            <Badge variant="outline" className="font-normal">
              {req.requestedStore.name}
            </Badge>
          ) : null}
          {req.requestedStore && !req.requestedStore.isOpen ? (
            <Badge variant="destructive">Store not open</Badge>
          ) : null}
        </div>
        <div className="mt-0.5 space-y-0.5 text-xs text-muted-foreground">
          <p>
            Login ID <span className="font-mono">{req.loginId}</span>
          </p>
          {req.phone || req.contactEmail ? (
            <p>
              {req.phone ? <span className="num">{req.phone}</span> : null}
              {req.phone && req.contactEmail ? " · " : null}
              {req.contactEmail ?? null}
            </p>
          ) : null}
          {req.priorRejection ? (
            <p className="text-amber-700 dark:text-amber-400">
              Declined before
              {req.priorRejection.reason ? `: “${req.priorRejection.reason}”` : ""}
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => setDialog("reject")}
          className="text-destructive hover:text-destructive"
        >
          <X className="h-4 w-4" /> Decline
        </Button>
        <Button size="sm" onClick={() => setDialog("approve")}>
          <Check className="h-4 w-4" /> Approve
        </Button>
      </div>

      <ApproveSignupDialog
        req={req}
        viewerRole={viewerRole}
        open={dialog === "approve"}
        onOpenChange={(o) => setDialog(o ? "approve" : null)}
      />
      <RejectSignupDialog
        req={req}
        open={dialog === "reject"}
        onOpenChange={(o) => setDialog(o ? "reject" : null)}
      />
    </div>
  );
}

function ApproveSignupDialog({
  req,
  viewerRole,
  open,
  onOpenChange,
}: {
  req: PendingSignup;
  viewerRole: Role;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const approve = useApproveSignup();
  const stores = useSession((s) => s.stores);
  const assignable = useMemo(() => stores.filter((s) => !s.isAggregate), [stores]);
  const roles = approvableRoles(viewerRole);
  const [role, setRole] = useState<StaffRole>(req.requestedRole);
  const [storeId, setStoreId] = useState(req.requestedStore?.id ?? "");

  function confirm() {
    if (!storeId) {
      toast.error("Select a store.");
      return;
    }
    approve.mutate(
      {
        id: req.id,
        // Send only what the approver changed; the request's own values are the default.
        role: role !== req.requestedRole ? role : undefined,
        storeId: storeId !== req.requestedStore?.id ? storeId : undefined,
      },
      {
        onSuccess: (res) => {
          toast.success(`${req.name} approved — Login ID ${res.loginId}`, {
            description: DELIVERY_NOTE[res.contactEmailDelivery],
            duration: 10_000,
          });
          onOpenChange(false);
        },
        onError: (err) =>
          toast.error(apiErrorMessage(err, "Could not approve this request.")),
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) {
          setRole(req.requestedRole);
          setStoreId(req.requestedStore?.id ?? "");
        }
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Approve {req.name}</DialogTitle>
          <DialogDescription>
            They asked to join {req.requestedStore?.name ?? "a store"} as{" "}
            {ROLE_LABELS[req.requestedRole]}. You can change either, within your
            own authority.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="approve-role">Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as StaffRole)}>
              <SelectTrigger id="approve-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roles.map((r) => (
                  <SelectItem key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="approve-store">Store</Label>
            <Select value={storeId || undefined} onValueChange={setStoreId}>
              <SelectTrigger id="approve-store">
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
            {storeId && storeId !== req.requestedStore?.id ? (
              <p className="text-xs text-muted-foreground">
                A different store can change their Login ID; you will see the
                final one after approving.
              </p>
            ) : null}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={confirm} disabled={approve.isPending}>
            {approve.isPending ? "Approving…" : "Approve"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RejectSignupDialog({
  req,
  open,
  onOpenChange,
}: {
  req: PendingSignup;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const reject = useRejectSignup();
  const [reason, setReason] = useState("");

  function confirm() {
    if (reason.trim().length < 3) {
      toast.error("Give a short reason.");
      return;
    }
    reject.mutate(
      { id: req.id, reason: reason.trim() },
      {
        onSuccess: () => {
          toast.success(`${req.name}'s request declined`);
          onOpenChange(false);
        },
        onError: (err) =>
          toast.error(apiErrorMessage(err, "Could not decline this request.")),
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) setReason("");
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Decline {req.name}?</DialogTitle>
          <DialogDescription>
            This request is closed for good. They can send a fresh request
            later, and whoever reviews it will see this reason.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="reject-reason">
            Reason <span className="text-destructive">*</span>
          </Label>
          <Textarea
            id="reject-reason"
            maxLength={500}
            placeholder="e.g. Not on this store's roster"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={reject.isPending}>
            {reject.isPending ? "Declining…" : "Decline"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Signup policy (head office)                                        */
/* ------------------------------------------------------------------ */

function SignupPolicyCard() {
  const { data: policy } = useSignupPolicy(true);
  const save = useSaveSignupPolicy();
  const [template, setTemplate] = useState<string | null>(null);

  if (!policy) return null;
  const draft = template ?? policy.loginIdTemplate ?? "";

  function saveTemplate(next: string | null) {
    save.mutate(
      { loginIdTemplate: next },
      {
        onSuccess: (res) => {
          setTemplate(null);
          toast.success(`New Login IDs will look like ${res.example}`);
        },
        onError: (err) =>
          toast.error(apiErrorMessage(err, "Could not save the Login ID format.")),
      },
    );
  }

  function toggleManagers(allow: boolean) {
    save.mutate(
      { allowManagerSelfRequest: allow },
      {
        onError: (err) =>
          toast.error(apiErrorMessage(err, "Could not update the signup policy.")),
      },
    );
  }

  return (
    <div className="mt-8">
      <div className="mb-3 flex items-center gap-2">
        <Shield className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Signup and Login IDs</h2>
      </div>
      <div className="grid gap-4 rounded-xl border p-4">
        <div className="grid gap-1.5">
          <Label htmlFor="login-id-template">Login ID format for new staff</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="login-id-template"
              className="font-mono"
              placeholder={`Default — e.g. ${policy.defaultExample}`}
              value={draft}
              onChange={(e) => setTemplate(e.target.value)}
            />
            <Button
              variant="outline"
              onClick={() => saveTemplate(draft.trim() || null)}
              disabled={save.isPending || draft === (policy.loginIdTemplate ?? "")}
            >
              Save format
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            A Login ID is a sign-in identifier, not an email inbox. Tokens:{" "}
            <span className="font-mono">{policy.tokens.join(" ")}</span>. The part
            after &quot;@&quot; must include your organisation code (
            <span className="font-mono">{policy.organisationCode}</span>) or{" "}
            <span className="font-mono">{"{orgslug}"}</span>. A number is added when
            an ID is taken. Existing Login IDs never change. Currently:{" "}
            <span className="font-mono">{policy.example}</span>
          </p>
        </div>
        <label className="flex items-start gap-2.5 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4"
            checked={policy.allowManagerSelfRequest}
            disabled={save.isPending}
            onChange={(e) => toggleManagers(e.target.checked)}
          />
          <span>
            Let applicants request the Store Manager role
            <span className="block text-xs text-muted-foreground">
              Off by default. Staff can always request Salesperson or
              Storeperson; a Store Manager request is approved by head office
              only.
            </span>
          </span>
        </label>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Add staff                                                          */
/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ */
/* Reset password (reuses useResetPassword)                           */
/* ------------------------------------------------------------------ */

