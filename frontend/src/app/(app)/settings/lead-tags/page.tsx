"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Archive, Plus, Tags, Undo2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusPill } from "@/components/ui/status-pill";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useCreateLeadTag,
  useLeadTags,
  useRetireLeadTag,
  useUpdateLeadTag,
} from "@/lib/queries/lead-tags";
import { apiErrorMessage } from "@/lib/utils";
import { useSession } from "@/store/use-session";

/** Palette tokens, not raw hex — a tag has to stay legible when the theme flips. */
const COLOURS = [
  { value: "slate", swatch: "bg-slate-500" },
  { value: "emerald", swatch: "bg-emerald-500" },
  { value: "amber", swatch: "bg-amber-500" },
  { value: "rose", swatch: "bg-rose-500" },
  { value: "sky", swatch: "bg-sky-500" },
  { value: "violet", swatch: "bg-violet-500" },
] as const;

/**
 * The tenant's own words for what a lead is.
 *
 * Two things the screen is careful about. A tag is RETIRED, never deleted: a
 * label somebody put on a lead is part of the record of what they thought at the
 * time, and removing it rewrites that. And retiring tells you how many leads
 * still carry it, before the surprise rather than after — the number is the only
 * thing that makes "are you sure" a real question.
 *
 * Renaming is allowed and is not the same as deleting, but it does change the
 * meaning of every lead already carrying the tag, which is why only a manager
 * can do it while any salesperson may apply one.
 */
export default function LeadTagsPage() {
  const role = useSession((s) => s.role);
  const canManage = role === "store_manager" || role === "area_manager" || role === "head_office";

  const [showRetired, setShowRetired] = useState(false);
  const tags = useLeadTags(showRetired);
  const create = useCreateLeadTag();
  const update = useUpdateLeadTag();
  const retire = useRetireLeadTag();

  const [name, setName] = useState("");
  const [colour, setColour] = useState<string>("slate");
  const [editing, setEditing] = useState<Record<string, string>>({});

  const onCreate = () => {
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      toast.error("A tag needs at least two characters.");
      return;
    }
    create.mutate(
      { name: trimmed, colour },
      {
        onSuccess: () => {
          setName("");
          toast.success(`"${trimmed}" added.`);
        },
        onError: (e) => toast.error(apiErrorMessage(e, "Could not add that tag.")),
      },
    );
  };

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Link
          href="/settings"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" /> Settings
        </Link>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Tags className="size-5" /> Lead tags
        </h1>
        <p className="text-sm text-muted-foreground">
          Your own labels for a lead &mdash; anyone can apply one, only a manager can change
          what they mean.
        </p>
      </div>

      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Add a tag</CardTitle>
            <CardDescription>
              Colours are palette names rather than exact shades, so a tag stays readable in
              both light and dark.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label htmlFor="tag-name">Name</Label>
                <Input
                  id="tag-name"
                  className="w-56"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onCreate();
                  }}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="tag-colour">Colour</Label>
                <div className="flex items-center gap-1.5" id="tag-colour">
                  {COLOURS.map((c) => (
                    <button
                      key={c.value}
                      type="button"
                      aria-label={c.value}
                      aria-pressed={colour === c.value}
                      onClick={() => setColour(c.value)}
                      className={`size-7 rounded-full ${c.swatch} ${
                        colour === c.value ? "ring-2 ring-offset-2 ring-foreground/40" : ""
                      }`}
                    />
                  ))}
                </div>
              </div>
              <Button onClick={onCreate} disabled={create.isPending}>
                <Plus className="size-4" /> {create.isPending ? "Adding…" : "Add"}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <div className="flex items-center gap-2">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={showRetired}
            onChange={(e) => setShowRetired(e.target.checked)}
          />
          Show retired tags
        </label>
      </div>

      {tags.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : (tags.data ?? []).length === 0 ? (
        <EmptyState
          icon={Tags}
          title="No tags yet"
          description={
            canManage
              ? "Add the labels your team already uses out loud — “ready to buy”, “just looking”, “price sensitive”."
              : "Your manager has not set any tags up yet."
          }
        />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tag</TableHead>
                <TableHead className="text-right">Leads carrying it</TableHead>
                <TableHead>State</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(tags.data ?? []).map((t) => {
                const swatch =
                  COLOURS.find((c) => c.value === t.colour)?.swatch ?? "bg-muted-foreground";
                const draft = editing[t.id];
                return (
                  <TableRow key={t.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className={`size-3 shrink-0 rounded-full ${swatch}`} />
                        {canManage ? (
                          <Input
                            className="h-8 w-56"
                            aria-label={`Rename ${t.name}`}
                            value={draft ?? t.name}
                            onChange={(e) =>
                              setEditing((p) => ({ ...p, [t.id]: e.target.value }))
                            }
                            onBlur={() => {
                              const next = (draft ?? "").trim();
                              setEditing((p) => {
                                const rest = { ...p };
                                delete rest[t.id];
                                return rest;
                              });
                              if (!next || next === t.name) return;
                              update.mutate(
                                { id: t.id, name: next },
                                {
                                  onSuccess: () => toast.success("Renamed."),
                                  onError: (e) =>
                                    toast.error(apiErrorMessage(e, "Could not rename it.")),
                                },
                              );
                            }}
                          />
                        ) : (
                          <span className="font-medium">{t.name}</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="num text-right text-muted-foreground">
                      {t.leadCount ?? 0}
                    </TableCell>
                    <TableCell>
                      <StatusPill tone={t.isActive ? "good" : "mute"}>
                        {t.isActive ? "In use" : "Retired"}
                      </StatusPill>
                    </TableCell>
                    <TableCell className="text-right">
                      {!canManage ? null : t.isActive ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={retire.isPending}
                          onClick={() =>
                            retire.mutate(t.id, {
                              onSuccess: (res) =>
                                toast.success(`"${t.name}" retired.`, {
                                  description: res.stillOnLeads
                                    ? `${res.stillOnLeads} lead(s) still carry it — the label stays on their record.`
                                    : undefined,
                                }),
                              onError: (e) =>
                                toast.error(apiErrorMessage(e, "Could not retire it.")),
                            })
                          }
                        >
                          <Archive className="size-3.5" /> Retire
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={update.isPending}
                          onClick={() =>
                            update.mutate(
                              { id: t.id, isActive: true },
                              {
                                onSuccess: () => toast.success(`"${t.name}" is in use again.`),
                                onError: (e) =>
                                  toast.error(apiErrorMessage(e, "Could not restore it.")),
                              },
                            )
                          }
                        >
                          <Undo2 className="size-3.5" /> Put back
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Retiring takes a tag out of the picker. It does not remove it from leads that already
        carry it &mdash; what somebody thought at the time is part of the record.
      </p>
    </div>
  );
}
