"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Boxes, Plus, Save } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { HelpNote } from "@/components/ui/help-note";
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
import { StatusPill } from "@/components/ui/status-pill";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CATEGORY_LABELS, type ProductCategory } from "@/lib/mock/catalogue";
import {
  type ProductGroupCodeUsage,
  useProductGroups,
  useSaveProductGroups,
} from "@/lib/queries/product-groups";
import { apiErrorMessage } from "@/lib/utils";

/**
 * What the two letters in a design code mean.
 *
 * The connected system files a design's group inside its design number — the
 * `RG` in `10880RG`. The codes somebody worked out are built into the server;
 * the rest only exist in the supplier's own group master, so until head office
 * types them in those designs are filed under Other and fall out of every
 * filter on the catalogue.
 *
 * The screen is built around that asking. An empty form nobody can fill in from
 * memory is useless, so every code the catalogue actually carries is listed
 * with how much is behind it, biggest first: "64 designs and 144 pieces say LR"
 * is a question somebody can go and answer, and the examples beside it are real
 * design numbers off the shelf.
 *
 * Saving re-reads the designs and pieces already stored — otherwise the answer
 * would only apply to whatever the supplier happens to send next, which for a
 * design nobody edits could be never.
 */

/** Radix will not take an empty value, and "nobody has said" is a real state. */
const UNSET = "__unset";

interface Draft {
  category: string;
  label: string;
}

/** A code typed in by hand carries no counts yet; the row shape stays the same. */
type CodeRow = ProductGroupCodeUsage | { code: string; source: "unmapped" };

export default function ProductGroupsPage() {
  const groups = useProductGroups();
  const save = useSaveProductGroups();

  const [edits, setEdits] = useState<Record<string, Draft>>({});
  const [newCode, setNewCode] = useState("");

  const stored = useMemo(() => {
    const map: Record<string, Draft> = {};
    for (const c of groups.data?.codes ?? []) {
      map[c.code] = { category: c.category, label: c.label ?? "" };
    }
    return map;
  }, [groups.data]);

  const draftFor = (code: string): Draft =>
    edits[code] ?? stored[code] ?? { category: UNSET, label: "" };
  const setDraft = (code: string, next: Partial<Draft>) =>
    setEdits((prev) => ({ ...prev, [code]: { ...draftFor(code), ...next } }));

  const usage = groups.data?.usage ?? [];
  /* A code head office typed in before the catalogue carries any of it still
     belongs on screen — otherwise adding one makes it vanish. */
  const added: CodeRow[] = Object.keys(edits)
    .filter((code) => !usage.some((r) => r.code === code))
    .map((code) => ({ code, source: "unmapped" as const }));
  const unanswered: CodeRow[] = [...usage.filter((r) => r.source === "unmapped"), ...added];
  const answered = usage.filter((r) => r.source !== "unmapped");

  const dirty = Object.entries(edits).filter(([code, draft]) => {
    const was = stored[code];
    return draft.category !== (was?.category ?? UNSET) || draft.label !== (was?.label ?? "");
  });

  const unclassified = usage.reduce(
    (acc, r) => ({
      products: acc.products + r.productsUnclassified,
      pieces: acc.pieces + r.piecesUnclassified,
    }),
    { products: 0, pieces: 0 },
  );

  const onSave = () => {
    const merged: Record<string, Draft> = { ...stored, ...edits };
    const codes = Object.entries(merged)
      // A code put back to "nobody has said" is a withdrawal, not an entry: it
      // is left out, and the built-in reading takes over again.
      .filter(([, draft]) => draft.category !== UNSET)
      .map(([code, draft]) => ({
        code,
        category: draft.category as ProductCategory,
        label: draft.label.trim() || null,
      }));

    save.mutate(codes, {
      onSuccess: (res) => {
        setEdits({});
        toast.success("Saved.", {
          description: res.reclassifying.length
            ? `Re-reading every design and piece that says ${res.reclassifying.join(", ")}. The catalogue catches up as that runs.`
            : "Nothing needed re-reading — no code changed meaning.",
        });
      },
      onError: (e) => toast.error(apiErrorMessage(e, "Could not save those codes.")),
    });
  };

  const onAdd = () => {
    const code = newCode.replace(/[^A-Za-z]/g, "").toUpperCase();
    if (code.length !== 2) {
      toast.error("A product-group code is two letters.");
      return;
    }
    setEdits((prev) => ({ ...prev, [code]: draftFor(code) }));
    setNewCode("");
  };

  const tableHeader = (
    <TableHeader>
      <TableRow>
        <TableHead>Code</TableHead>
        <TableHead className="text-right">Designs</TableHead>
        <TableHead className="text-right">Pieces</TableHead>
        <TableHead>Seen on</TableHead>
        <TableHead>Set by</TableHead>
        <TableHead>What it is</TableHead>
        <TableHead>Supplier&rsquo;s name for it</TableHead>
      </TableRow>
    </TableHeader>
  );

  const codeRow = (row: CodeRow) => {
    const counted = "products" in row ? row : null;
    const draft = draftFor(row.code);
    const builtIn = counted && counted.source === "built_in" ? CATEGORY_LABELS[counted.category] : null;
    return (
      <TableRow key={row.code}>
        <TableCell className="font-mono font-semibold">{row.code}</TableCell>
        <TableCell className="num text-right text-muted-foreground">
          {counted?.products ?? 0}
        </TableCell>
        <TableCell className="num text-right text-muted-foreground">
          {counted?.pieces ?? 0}
        </TableCell>
        <TableCell className="max-w-[16rem] truncate font-mono text-xs text-muted-foreground">
          {counted?.examples.join(", ") || "—"}
        </TableCell>
        <TableCell>
          <StatusPill tone={row.source === "tenant" ? "good" : row.source === "built_in" ? "mute" : "wait"}>
            {row.source === "tenant" ? "You" : row.source === "built_in" ? "Built in" : "Nobody"}
          </StatusPill>
        </TableCell>
        <TableCell>
          <Select value={draft.category} onValueChange={(v) => setDraft(row.code, { category: v })}>
            <SelectTrigger className="h-9 w-44" aria-label={`What ${row.code} means`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNSET}>
                {builtIn ? `${builtIn} (built in)` : "Nobody has said"}
              </SelectItem>
              {(groups.data?.categories ?? []).map((c) => (
                <SelectItem key={c} value={c}>
                  {CATEGORY_LABELS[c] ?? c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </TableCell>
        <TableCell>
          <Input
            className="h-9 w-48"
            placeholder="Their word for it"
            aria-label={`What the supplier calls ${row.code}`}
            value={draft.label}
            onChange={(e) => setDraft(row.code, { label: e.target.value })}
          />
        </TableCell>
      </TableRow>
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
          <Boxes className="size-5" /> Product groups
        </h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Your supplier puts the product group inside the design number &mdash; the{" "}
          <b>RG</b> in <b>10880RG</b>. Tell us what the rest of those letters mean and every
          design carrying them files itself correctly.
        </p>
        <HelpNote more="Saving re-reads the designs and pieces already in the catalogue, not only the ones that arrive next — a design nobody edits is never sent again, so waiting for the next sync would mean waiting forever. That re-read runs in the background and the catalogue keeps working while it catches up.">
          A code you leave alone keeps the reading it already had.
        </HelpNote>
      </div>

      {unclassified.products + unclassified.pieces > 0 ? (
        <Card>
          <CardContent className="py-4 text-sm">
            <b className="num">{unclassified.products}</b> design(s) and{" "}
            <b className="num">{unclassified.pieces}</b> piece(s) are filed under <b>Other</b>{" "}
            today. They stay out of the catalogue&rsquo;s own filters until their code has a
            meaning.
          </CardContent>
        </Card>
      ) : null}

      {groups.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Codes nobody has explained</CardTitle>
              <CardDescription>
                Biggest first &mdash; the ones with the most behind them are the ones worth
                asking about first.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {unanswered.length === 0 ? (
                <EmptyState
                  icon={Boxes}
                  title="Every code has a meaning"
                  description="Nothing in the catalogue carries a code we cannot read."
                />
              ) : (
                <div className="overflow-x-auto rounded-lg border">
                  <Table>
                    {tableHeader}
                    <TableBody>{unanswered.map(codeRow)}</TableBody>
                  </Table>
                </div>
              )}

              <div className="flex flex-wrap items-end gap-2">
                <div className="space-y-1">
                  <Label htmlFor="new-code">Add a code</Label>
                  <Input
                    id="new-code"
                    className="w-32 font-mono uppercase"
                    placeholder="CR"
                    maxLength={2}
                    value={newCode}
                    onChange={(e) => setNewCode(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") onAdd();
                    }}
                  />
                </div>
                <Button variant="outline" onClick={onAdd}>
                  <Plus className="size-4" /> Add
                </Button>
                <p className="pb-2 text-xs text-muted-foreground">
                  For a group the catalogue has none of yet.
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Codes with a meaning</CardTitle>
              <CardDescription>
                A built-in reading can be overruled &mdash; yours always wins.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {answered.length === 0 ? (
                <EmptyState
                  icon={Boxes}
                  title="Nothing here yet"
                  description="A code moves down here once it has a meaning."
                />
              ) : (
                <div className="overflow-x-auto rounded-lg border">
                  <Table>
                    {tableHeader}
                    <TableBody>{answered.map(codeRow)}</TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          <div className="flex items-center justify-end gap-3">
            {dirty.length ? (
              <p className="text-sm text-muted-foreground">
                {dirty.length} code(s) changed, not yet saved.
              </p>
            ) : null}
            <Button onClick={onSave} disabled={!dirty.length || save.isPending}>
              <Save className="size-4" /> {save.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
