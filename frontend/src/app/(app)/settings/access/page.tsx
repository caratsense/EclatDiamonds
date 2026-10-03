"use client";

import { useMemo, useState } from "react";
import { Clock, RotateCcw, Search } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { SectionHeader } from "@/components/section/section-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { NAV_GROUPS, getNavItem } from "@/lib/navigation";
import { useStaff } from "@/lib/queries/users";
import { api } from "@/lib/api";
import { useSetUserAccess, useUserAccess, type AccessOverride, type UserAccess } from "@/lib/queries/access";
import { ROLE_LABELS } from "@/lib/types";
import { apiErrorMessage, cn } from "@/lib/utils";

import { bulkAttendanceOnlyPrompt, startingPointLine } from "./wording";

/** Screens only head office can use; never given to anyone else. */
const HEAD_OFFICE_ONLY = new Set([
  "settings/onboarding",
  "new-store",
  "settings/configuration",
  "settings/integrations",
  "settings/messaging-routes",
  "settings/access",
]);

const LEVELS: { value: AccessOverride; label: string; hint: string }[] = [
  { value: "none", label: "Off", hint: "Not in their sidebar, and the server refuses it" },
  { value: "own", label: "Own", hint: "Only their own records" },
  { value: "store", label: "Store", hint: "Everything at their store, as a manager" },
];

/**
 * Head office decides, person by person, which screens someone can open and
 * how far. A change applies to that person only, on top of their role, and the
 * server enforces it — a screen switched off is refused, one switched on works.
 */
/**
 * Attendance and nothing else: every screen the role gives, switched off,
 * except HRMS — where Check in / Check out, leave and regularisation live.
 */
const attendanceOnly = (defaults: Record<string, unknown>): Record<string, AccessOverride> =>
  Object.fromEntries(Object.keys(defaults).filter((slug) => slug !== "hrms").map((slug) => [slug, "none"]));

export default function AccessPage() {
  const item = getNavItem("settings/access");
  const staff = useStaff();
  const qc = useQueryClient();
  const [query, setQuery] = useState("");
  const [userId, setUserId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const salesStaff = (staff.data ?? []).filter((u) => u.isActive && u.role === "salesperson");
  // Where sales staff start is the same for all of them, so one person's answer words the question below.
  const oneOfThem = useUserAccess(salesStaff[0]?.id ?? null);
  /** The same audited save as one person, once for each of the sales staff. */
  async function allSalesStaffAttendanceOnly() {
    if (!window.confirm(bulkAttendanceOnlyPrompt(salesStaff.length, !!oneOfThem.data?.startsAttendanceOnly))) return;
    setBulkBusy(true);
    let done = 0;
    try {
      for (const u of salesStaff) {
        const { data } = await api.get<UserAccess>(`/users/${u.id}/access`);
        await api.put(`/users/${u.id}/access`, { overrides: attendanceOnly(data.defaults) });
        done++;
      }
      toast.success(`${done} sales staff now see attendance only`);
    } catch (e) {
      toast.error(apiErrorMessage(e, `Stopped after ${done} of ${salesStaff.length}. Try again.`));
    } finally {
      setBulkBusy(false);
      void qc.invalidateQueries({ queryKey: ["user-access"] });
    }
  }

  const people = useMemo(
    () =>
      (staff.data ?? [])
        .filter((u) => u.isActive)
        .filter((u) => `${u.name} ${u.stores.map((s) => s.name).join(" ")}`.toLowerCase().includes(query.toLowerCase()))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [staff.data, query],
  );

  return (
    <>
      <SectionHeader title={item?.title ?? "People & Access"} purpose={item?.purpose ?? ""} />
      <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
        <Card className="h-fit">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">People</CardTitle>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                className="pl-8"
                placeholder="Name or store"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              disabled={bulkBusy || salesStaff.length === 0 || oneOfThem.isLoading}
              onClick={allSalesStaffAttendanceOnly}
            >
              <Clock className="h-3.5 w-3.5" />
              {bulkBusy ? "Saving…" : "All sales staff: attendance only"}
            </Button>
          </CardHeader>
          <CardContent className="max-h-[32rem] space-y-1 overflow-y-auto p-2">
            {staff.isLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : people.length === 0 ? (
              <p className="p-2 text-sm text-muted-foreground">No one matches.</p>
            ) : (
              people.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => setUserId(u.id)}
                  className={cn(
                    "w-full rounded-md px-2.5 py-2 text-left text-sm hover:bg-muted",
                    u.id === userId && "bg-muted",
                  )}
                >
                  <div className="font-medium">{u.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {ROLE_LABELS[u.role]}
                    {u.stores.length ? ` · ${u.stores.map((s) => s.name).join(", ")}` : ""}
                  </div>
                </button>
              ))
            )}
          </CardContent>
        </Card>

        {userId ? (
          <PersonAccess key={userId} userId={userId} />
        ) : (
          <Card>
            <CardContent className="py-16 text-center text-sm text-muted-foreground">
              Pick a person to see and change what they can open.
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}

function PersonAccess({ userId }: { userId: string }) {
  const access = useUserAccess(userId);
  const save = useSetUserAccess();
  // Only what head office has touched in this session; the rest reads through.
  const [draft, setDraft] = useState<Record<string, AccessOverride>>({});

  const data = access.data;
  if (access.isLoading || !data) return <Skeleton className="h-96 w-full" />;
  if (data.role === "head_office") {
    return (
      <Card>
        <CardContent className="py-16 text-center text-sm text-muted-foreground">
          {data.name} is head office and always has every screen.
        </CardContent>
      </Card>
    );
  }

  const current = (slug: string): AccessOverride => draft[slug] ?? data.effective[slug] ?? "none";
  const byDefault = (slug: string): AccessOverride => data.defaults[slug] ?? "none";
  const dirty = Object.keys(draft).length > 0;

  function submit(overrides: Record<string, AccessOverride>) {
    save.mutate(
      { userId, overrides },
      {
        onSuccess: () => {
          setDraft({});
          toast.success(`Saved what ${data!.name} can open`, {
            description: "It applies the next time they open a screen.",
          });
        },
        onError: (e) => toast.error(apiErrorMessage(e, "Could not save.")),
      },
    );
  }

  // Everything that differs from the role, after this session's edits.
  const merged = (): Record<string, AccessOverride> => {
    const out: Record<string, AccessOverride> = { ...data.overrides, ...draft };
    return Object.fromEntries(Object.entries(out).filter(([slug, v]) => v !== byDefault(slug)));
  };
  const changedCount = Object.keys(merged()).length;

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-base">
            {data.name} · {ROLE_LABELS[data.role]}
          </CardTitle>
          <CardDescription>
            {startingPointLine(data)}
            {changedCount ? ` ${changedCount} screen${changedCount === 1 ? " differs" : "s differ"} from the role.` : ""}
          </CardDescription>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={save.isPending}
            title="Only Check in / Check out, leave and regularisation"
            onClick={() => submit(attendanceOnly(data.defaults))}
          >
            <Clock className="h-3.5 w-3.5" /> Attendance only
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={save.isPending || (!changedCount && !dirty)}
            onClick={() => submit({})}
          >
            <RotateCcw className="h-3.5 w-3.5" /> Role defaults
          </Button>
          <Button size="sm" disabled={!dirty || save.isPending} onClick={() => submit(merged())}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {NAV_GROUPS.map((group) => {
          const items = group.items.filter((i) => !HEAD_OFFICE_ONLY.has(i.slug));
          if (!items.length) return null;
          return (
            <section key={group.label} className="space-y-1.5">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {group.label}
              </h3>
              {items.map((i) => {
                const value = current(i.slug);
                const changed = value !== byDefault(i.slug);
                return (
                  <div
                    key={i.slug}
                    className="flex flex-col gap-2 rounded-md border px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-medium">{i.title}</span>
                      {changed ? (
                        <Badge variant="outline" className="text-[10px] font-normal">
                          changed · role: {LEVELS.find((l) => l.value === byDefault(i.slug))?.label}
                        </Badge>
                      ) : null}
                    </div>
                    <div role="radiogroup" aria-label={i.title} className="flex rounded-md border p-0.5">
                      {LEVELS.map((l) => (
                        <button
                          key={l.value}
                          type="button"
                          role="radio"
                          aria-checked={value === l.value}
                          title={l.hint}
                          onClick={() => setDraft((d) => ({ ...d, [i.slug]: l.value }))}
                          className={cn(
                            "rounded px-3 py-1 text-xs font-medium",
                            value === l.value
                              ? l.value === "none"
                                ? "bg-muted text-foreground"
                                : "bg-primary text-primary-foreground"
                              : "text-muted-foreground hover:bg-muted/60",
                          )}
                        >
                          {l.label}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </section>
          );
        })}
      </CardContent>
    </Card>
  );
}
