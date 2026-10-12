"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, Shield, Trash2 } from "lucide-react";
import { toast } from "sonner";

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
import { api } from "@/lib/api";
import { NAV_GROUPS } from "@/lib/navigation";
import {
  useCreateCustomRole,
  useCustomRoles,
  useDeleteCustomRole,
  type StaffRole,
} from "@/lib/queries/users";
import { ROLE_LABELS } from "@/lib/types";
import { apiErrorMessage } from "@/lib/utils";

/**
 * Roles are their own thing (client, 10 Oct): a role is created HERE, from a
 * blank slate — name it, choose how far it works, switch its screens On/Off —
 * and only then is it given to people from Change role. Nothing starts from
 * any person's screens, and no person is touched by creating one.
 *
 * "Works as" is the one unavoidable anchor: the platform scopes every query by
 * rank (own records / whole branch / several branches), so a role must say
 * which of those it is. It decides reach, not screens — the screens are
 * exactly what is switched on below.
 */
const HEAD_OFFICE_ONLY = new Set([
  "settings/onboarding",
  "new-store",
  "settings/configuration",
  "settings/integrations",
  "settings/messaging-routes",
  "settings/access",
]);

const BASE_CHOICES: { value: StaffRole; label: string; reach: string }[] = [
  { value: "salesperson", label: "Own records", reach: "sees and works their own customers and entries" },
  { value: "store_manager", label: "Whole branch", reach: "works everything in their store" },
  { value: "area_manager", label: "Several branches", reach: "works every store they are assigned" },
];

const onLevelFor = (base: StaffRole) =>
  base === "salesperson" ? "own" : "store";

function useRoleDefaults(base: StaffRole) {
  return useQuery({
    queryKey: ["users", "roles", "defaults", base],
    queryFn: async () =>
      (await api.get<{ role: string; defaults: Record<string, string> }>(
        "/users/roles/defaults",
        { params: { role: base } },
      )).data.defaults,
  });
}

export function RoleManagerDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const roles = useCustomRoles();
  const del = useDeleteCustomRole();
  const [creating, setCreating] = useState(false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        {creating ? (
          <NewRoleForm onDone={() => setCreating(false)} />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Shield className="h-4 w-4" /> Roles
              </DialogTitle>
              <DialogDescription>
                Your own roles, beside the built-in ones. Create a role here,
                then give it to people from &ldquo;Change role&rdquo;.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              {roles.isLoading ? (
                <Skeleton className="h-20 w-full" />
              ) : (roles.data ?? []).length === 0 ? (
                <p className="rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground">
                  No roles of your own yet.
                </p>
              ) : (
                (roles.data ?? []).map((r) => (
                  <div
                    key={r.id}
                    className="flex items-center justify-between gap-3 rounded-lg border p-3"
                  >
                    <div>
                      <p className="text-sm font-medium">{r.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {ROLE_LABELS[r.baseRole]} reach ·{" "}
                        {Object.keys(r.overrides ?? {}).length} screen change
                        {Object.keys(r.overrides ?? {}).length === 1 ? "" : "s"}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground"
                      disabled={del.isPending}
                      title="Removes the role. People who already have it keep their screens."
                      onClick={() =>
                        del.mutate(r.id, {
                          onSuccess: () => toast.success(`Role "${r.name}" deleted. Nobody lost access.`),
                          onError: (e) => toast.error(apiErrorMessage(e, "Could not delete the role.")),
                        })
                      }
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" /> New role
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function NewRoleForm({ onDone }: { onDone: () => void }) {
  const create = useCreateCustomRole();
  const [name, setName] = useState("");
  const [base, setBase] = useState<StaffRole>("salesperson");
  // Which screens are ON. Seeded from the base's defaults the first time they
  // load (and re-seeded when the reach changes — a different base is a
  // different starting matrix, and unsaved flips are cheap to redo).
  const [on, setOn] = useState<Record<string, boolean> | null>(null);
  const defaults = useRoleDefaults(base);

  const defaultOn = (slug: string) => (defaults.data?.[slug] ?? "none") !== "none";
  const effective: Record<string, boolean> = {};
  if (defaults.data) {
    for (const group of NAV_GROUPS) {
      for (const item of group.items) {
        if (HEAD_OFFICE_ONLY.has(item.slug)) continue;
        effective[item.slug] = on?.[item.slug] ?? defaultOn(item.slug);
      }
    }
  }

  const submit = () => {
    if (!name.trim() || !defaults.data) return;
    // Only differences from the base become the role's overrides — the same
    // rule the server applies, so the editor and the stamp always agree.
    const overrides: Record<string, string> = {};
    for (const [slug, isOn] of Object.entries(effective)) {
      if (isOn === defaultOn(slug)) continue;
      overrides[slug] = isOn ? onLevelFor(base) : "none";
    }
    create.mutate(
      { name: name.trim(), baseRole: base, overrides },
      {
        onSuccess: (r) => {
          toast.success(`Role "${r.name}" created.`, {
            description: "Give it to people from Change role.",
          });
          onDone();
        },
        onError: (e) => toast.error(apiErrorMessage(e, "Could not create the role.")),
      },
    );
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>New role</DialogTitle>
        <DialogDescription>
          A role of its own: name it, choose its reach, switch on its screens.
          It touches nobody until you assign it.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="role-name">Role name</Label>
          <Input
            id="role-name"
            value={name}
            maxLength={60}
            placeholder="e.g. Floor Lead"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label>Reach</Label>
          <Select
            value={base}
            onValueChange={(v) => {
              setBase(v as StaffRole);
              setOn(null); // a different reach is a different starting matrix
            }}
          >
            <SelectTrigger aria-label="Reach">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BASE_CHOICES.map((c) => (
                <SelectItem key={c.value} value={c.value}>
                  {c.label} — {c.reach}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {defaults.isLoading || !defaults.data ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <div className="max-h-[42vh] space-y-4 overflow-y-auto rounded-lg border p-3">
            {NAV_GROUPS.map((group) => {
              const items = group.items.filter((i) => !HEAD_OFFICE_ONLY.has(i.slug));
              if (!items.length) return null;
              return (
                <section key={group.label} className="space-y-1">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {group.label}
                  </h3>
                  {items.map((i) => {
                    const isOn = effective[i.slug] ?? false;
                    const changed = isOn !== defaultOn(i.slug);
                    return (
                      <div
                        key={i.slug}
                        className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5"
                      >
                        <span className="flex items-center gap-2 text-sm">
                          {i.title}
                          {changed ? (
                            <Badge variant="outline" className="text-[10px] font-normal">
                              changed
                            </Badge>
                          ) : null}
                        </span>
                        <div role="radiogroup" aria-label={i.title} className="flex rounded-md border p-0.5">
                          {([
                            { v: false, label: "Off" },
                            { v: true, label: "On" },
                          ] as const).map((o) => (
                            <button
                              key={o.label}
                              type="button"
                              role="radio"
                              aria-checked={isOn === o.v}
                              onClick={() => setOn((prev) => ({ ...(prev ?? {}), [i.slug]: o.v }))}
                              className={
                                isOn === o.v
                                  ? o.v
                                    ? "rounded bg-primary px-3 py-0.5 text-xs font-medium text-primary-foreground"
                                    : "rounded bg-muted px-3 py-0.5 text-xs font-medium text-foreground"
                                  : "rounded px-3 py-0.5 text-xs font-medium text-muted-foreground hover:bg-muted/60"
                              }
                            >
                              {o.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </section>
              );
            })}
          </div>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          Back
        </Button>
        <Button onClick={submit} disabled={!name.trim() || create.isPending || !defaults.data}>
          {create.isPending ? "Creating…" : "Create role"}
        </Button>
      </DialogFooter>
    </>
  );
}
