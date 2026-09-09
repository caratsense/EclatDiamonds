"use client";

import { useState } from "react";
import { GitBranch, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  useDeactivateStage,
  useEnsureDefaultPipeline,
  usePipelines,
  useUpsertStage,
  type Pipeline,
} from "@/lib/queries/crm";
import { apiErrorMessage } from "@/lib/utils";

/**
 * Pipeline / stage configuration (Phase A3, surfaced in A11).
 *
 * The honest constraint this screen has to communicate, because getting it
 * wrong produces a column no lead can ever reach: `Lead.stage` is a fixed
 * three-value database enum. A configured stage can hold leads only if it
 * declares which of those values it means. A stage without that mapping is
 * perfectly legal — it is a label you are preparing — but it stays out of the
 * board, and this screen says so in those words rather than letting someone
 * discover it by dragging a card that snaps back.
 */

/** The enum values a stage can be tied to. Fixed by the database, not by a tenant. */
const SYSTEM_VALUES = [
  { value: "inquiry", label: "New enquiry" },
  { value: "quotation", label: "Quoted" },
  { value: "order_placed", label: "Order placed" },
] as const;

const NONE = "__none__";

export function PipelineConfig() {
  const { data, isLoading } = usePipelines();
  const ensureDefault = useEnsureDefaultPipeline();

  if (isLoading) return <Skeleton className="h-64 w-full" />;

  if (!data?.length) {
    return (
      <EmptyState
        icon={GitBranch}
        title="No pipeline configured"
        description="Start from the standard three-stage funnel, then rename or add stages to match how your business actually sells."
        actionLabel={ensureDefault.isPending ? "Creating…" : "Create the starting pipeline"}
        onAction={() =>
          ensureDefault
            .mutateAsync()
            .then(() => toast.success("Pipeline created."))
            .catch((e) => toast.error(apiErrorMessage(e, "Could not create the pipeline.")))
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      {data.map((p) => (
        <PipelineCard key={p.id} pipeline={p} />
      ))}
    </div>
  );
}

function PipelineCard({ pipeline }: { pipeline: Pipeline }) {
  const upsert = useUpsertStage(pipeline.id);
  const deactivate = useDeactivateStage();
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [systemValue, setSystemValue] = useState<string>(NONE);
  const [outcome, setOutcome] = useState("open");

  const stages = [...pipeline.stages].sort((a, b) => a.sortOrder - b.sortOrder);

  async function add() {
    const trimmed = label.trim();
    if (!trimmed) return;
    try {
      await upsert.mutateAsync({
        // Derived from the label so a user never has to think about codes; the
        // server rejects anything that is not a slug, so it is normalised here.
        code: trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""),
        label: trimmed,
        sortOrder: (stages.at(-1)?.sortOrder ?? 0) + 1,
        outcome,
        systemValue: systemValue === NONE ? undefined : systemValue,
      });
      setLabel("");
      setSystemValue(NONE);
      setOutcome("open");
      setAdding(false);
      toast.success(`Added “${trimmed}”.`);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Could not add that stage."));
    }
  }

  async function rename(code: string, next: string, current: string) {
    const trimmed = next.trim();
    if (!trimmed || trimmed === current) return;
    try {
      await upsert.mutateAsync({ code, label: trimmed });
    } catch (e) {
      toast.error(apiErrorMessage(e, "Could not rename that stage."));
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-4 space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <GitBranch className="h-4 w-4 text-muted-foreground" />
          {pipeline.name}
          {pipeline.isDefault && <Badge variant="secondary">Default</Badge>}
        </CardTitle>
        <Button size="sm" variant="outline" onClick={() => setAdding((v) => !v)}>
          <Plus className="h-4 w-4" />
          Add stage
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {stages.map((s) => (
          <div
            key={s.id}
            className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2"
          >
            <Input
              defaultValue={s.label}
              className="h-8 w-44"
              aria-label={`Name for ${s.label}`}
              onBlur={(e) => void rename(s.code, e.target.value, s.label)}
            />
            {s.systemValue ? (
              <Badge variant="outline">
                {SYSTEM_VALUES.find((v) => v.value === s.systemValue)?.label ?? s.systemValue}
              </Badge>
            ) : (
              <Badge variant="outline" className="border-amber-500/50 text-amber-600">
                Not on the board
              </Badge>
            )}
            <Badge variant={s.outcome === "won" ? "secondary" : "outline"}>{s.outcome}</Badge>
            {s.probability != null && (
              <span className="num text-xs text-muted-foreground">{s.probability}%</span>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto text-muted-foreground"
              title="Remove this stage from the board"
              onClick={() =>
                deactivate
                  .mutateAsync(s.id)
                  .then(() => toast.success(`Removed “${s.label}”.`))
                  .catch((e) =>
                    toast.error(apiErrorMessage(e, "Could not remove that stage.")),
                  )
              }
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}

        {adding && (
          <div className="space-y-3 rounded-lg border border-dashed p-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="stage-label">Stage name</Label>
                <Input
                  id="stage-label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="e.g. Awaiting approval"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Counts as</Label>
                <Select value={outcome} onValueChange={setOutcome}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="open">Still in progress</SelectItem>
                    <SelectItem value="won">Won</SelectItem>
                    <SelectItem value="lost">Lost</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Shows on the board as</Label>
                <Select value={systemValue} onValueChange={setSystemValue}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Not on the board yet</SelectItem>
                    {SYSTEM_VALUES.map((v) => (
                      <SelectItem key={v.value} value={v.value}>
                        {v.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              A stage only appears on the lead board once it is tied to one of the three
              statuses a lead record can hold. Two stages may share a status — they will
              share a column.
            </p>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void add()} disabled={upsert.isPending}>
                {upsert.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                Add
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
