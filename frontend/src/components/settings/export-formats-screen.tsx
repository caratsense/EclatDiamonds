"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  FileSpreadsheet,
  Plus,
  RotateCcw,
  Save,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  type ExportColumnFormat,
  type ExportFormatKind,
  type ExportFormatState,
  useExportFormats,
  useSaveExportFormat,
} from "@/lib/queries/exports";
import { apiErrorMessage } from "@/lib/utils";

/**
 * Settings › Export formats.
 *
 * The client reconciles our Leads sheet against her own Master Leads workbook,
 * one tab per store, and her NPS sheet against her Google Form's output. Our
 * headings were ours, so every download needed re-ordering and re-titling before
 * it could sit beside hers (client, 21 Nov: each tenant should set their own
 * column format for the NPS sheet and the Leads sheet).
 *
 * Two things the screen is deliberate about.
 *
 * **Only columns the export can fill are on offer.** The list comes from the
 * server, derived from the builder itself. A chooser that offered more would
 * produce a heading with nothing underneath it, and nobody would find out until
 * the file was on somebody else's desk.
 *
 * **The heading is the tenant's to spell.** Her sheet says "Product Catergory"
 * and "Purchase Ocassion". Correcting her spelling would put the renaming work
 * straight back where it was, so the box accepts whatever she types.
 */
export function ExportFormatsScreen() {
  const formats = useExportFormats();

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
          <FileSpreadsheet className="size-5" /> Export formats
        </h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Which columns your Excel downloads carry, in which order, under whatever headings
          your own sheets use. Change nothing and you get the standard format.
        </p>
        <HelpNote more="Only columns the export can actually fill are listed. That is why the list is shorter than everything held about a lead: a heading we cannot fill would come out as an empty column, and you would not find out until somebody else opened the file.">
          A column you rename keeps its data &mdash; only the heading changes.
        </HelpNote>
      </div>

      {formats.isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : formats.data ? (
        <Tabs defaultValue="leads">
          <TabsList>
            <TabsTrigger value="leads">Leads sheet</TabsTrigger>
            <TabsTrigger value="nps">NPS sheet</TabsTrigger>
          </TabsList>
          <TabsContent value="leads" className="mt-4">
            <FormatEditor
              kind="leads"
              state={formats.data.leads}
              what="the Leads workbook, and the Leads tab of the CRM export"
            />
          </TabsContent>
          <TabsContent value="nps" className="mt-4">
            <FormatEditor
              kind="nps"
              state={formats.data.nps}
              what="the NPS Responses tab. Updates and Follow-up answers keep their standard shape"
            />
          </TabsContent>
        </Tabs>
      ) : (
        <p className="text-sm text-destructive">
          {apiErrorMessage(formats.error, "Could not read your export formats.")}
        </p>
      )}
    </div>
  );
}

function FormatEditor({
  kind,
  state,
  what,
}: {
  kind: ExportFormatKind;
  state: ExportFormatState;
  what: string;
}) {
  const save = useSaveExportFormat();
  /** null until somebody edits, so "saved" and "not yet touched" stay distinct. */
  const [draft, setDraft] = useState<ExportColumnFormat[] | null>(null);
  const [adding, setAdding] = useState("");

  const columns = draft ?? state.columns;
  const used = useMemo(() => new Set(columns.map((c) => c.field)), [columns]);
  const spare = state.fields.filter((f) => !used.has(f.field));
  const labelFor = (field: string) =>
    state.fields.find((f) => f.field === field)?.label ?? field;
  const noteFor = (field: string) => state.fields.find((f) => f.field === field)?.note ?? "";

  const dirty =
    draft != null &&
    (draft.length !== state.columns.length ||
      draft.some((c, i) => c.field !== state.columns[i].field || c.header !== state.columns[i].header));

  const move = (index: number, by: number) => {
    const next = [...columns];
    const target = index + by;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setDraft(next);
  };

  const onSave = () => {
    if (!draft) return;
    save.mutate(
      { kind, columns: draft },
      {
        onSuccess: (res) => {
          setDraft(null);
          toast.success("Saved.", {
            description: `The next download has ${res.columns.length} column(s), in this order.`,
          });
        },
        onError: (e) => toast.error(apiErrorMessage(e, "Could not save that format.")),
      },
    );
  };

  const onReset = () => {
    save.mutate(
      { kind, columns: null },
      {
        onSuccess: () => {
          setDraft(null);
          toast.success("Back to the standard format.");
        },
        onError: (e) => toast.error(apiErrorMessage(e, "Could not reset that format.")),
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-base">
              {kind === "leads" ? "Leads" : "NPS"} columns
              <StatusPill tone={state.isDefault && !dirty ? "mute" : "good"}>
                {state.isDefault && !dirty ? "Standard format" : "Yours"}
              </StatusPill>
            </CardTitle>
            <CardDescription>Applies to {what}.</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {draft ? (
              <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
                Undo changes
              </Button>
            ) : null}
            {/* Offered even on the standard format, because a tenant cannot
                otherwise tell a reset that did nothing from a reset that
                failed — the pill beside the title is what says which. */}
            <Button
              variant="outline"
              size="sm"
              onClick={onReset}
              disabled={save.isPending || (state.isDefault && !dirty)}
            >
              <RotateCcw className="size-3.5" /> Standard format
            </Button>
            <Button size="sm" onClick={onSave} disabled={!dirty || save.isPending}>
              <Save className="size-3.5" /> {save.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <ol className="space-y-2">
          {columns.map((column, index) => (
            <li
              key={column.field}
              className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2"
            >
              <span className="num w-7 shrink-0 text-xs text-muted-foreground">{index + 1}</span>
              <div className="min-w-[10rem] flex-1">
                <p className="text-sm font-medium">{labelFor(column.field)}</p>
                <p className="text-xs text-muted-foreground">{noteFor(column.field)}</p>
              </div>
              <div className="w-full sm:w-72">
                <Label className="sr-only" htmlFor={`header-${kind}-${column.field}`}>
                  Heading for {labelFor(column.field)}
                </Label>
                <Input
                  id={`header-${kind}-${column.field}`}
                  className="h-9"
                  value={column.header}
                  maxLength={120}
                  onChange={(e) => {
                    const next = [...columns];
                    next[index] = { ...column, header: e.target.value };
                    setDraft(next);
                  }}
                />
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Move ${labelFor(column.field)} up`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Move ${labelFor(column.field)} down`}
                  disabled={index === columns.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${labelFor(column.field)}`}
                  disabled={columns.length === 1}
                  onClick={() => setDraft(columns.filter((c) => c.field !== column.field))}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </li>
          ))}
        </ol>

        {spare.length ? (
          <div className="flex flex-wrap items-end gap-2 border-t pt-4">
            <div className="space-y-1">
              <Label htmlFor={`add-${kind}`}>Add a column</Label>
              <Select value={adding} onValueChange={setAdding}>
                <SelectTrigger id={`add-${kind}`} className="h-9 w-72">
                  <SelectValue placeholder="Choose a column" />
                </SelectTrigger>
                <SelectContent>
                  {spare.map((field) => (
                    <SelectItem key={field.field} value={field.field}>
                      {field.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              variant="outline"
              disabled={!adding}
              onClick={() => {
                const spec = state.fields.find((f) => f.field === adding);
                if (!spec) return;
                // Our own name as the starting heading, not a blank box: a blank
                // would save as a column with no title, and the name is usually
                // close enough to leave alone.
                setDraft([...columns, { field: spec.field, header: spec.label }]);
                setAdding("");
              }}
            >
              <Plus className="size-4" /> Add
            </Button>
            {adding ? (
              <p className="max-w-md pb-2 text-xs text-muted-foreground">
                {state.fields.find((f) => f.field === adding)?.note}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="border-t pt-4 text-xs text-muted-foreground">
            Every column this export can fill is already in the sheet.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
