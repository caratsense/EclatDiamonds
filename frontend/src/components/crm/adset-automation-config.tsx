"use client";

import { useState } from "react";
import { Bot, Plus, Trash2, UserRound } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type AdSetAutomationRule,
  useAdSetRules,
  useSaveAdSetRules,
} from "@/lib/queries/crm-ai";
import { useStoresAdmin } from "@/lib/queries/stores";
import { apiErrorMessage } from "@/lib/utils";

export function AdSetAutomationConfig() {
  const { data, isLoading } = useAdSetRules();
  if (isLoading) return <Skeleton className="h-48 w-full" />;
  return <AdSetRulesEditor initialRules={data ?? []} />;
}

function AdSetRulesEditor({ initialRules }: { initialRules: AdSetAutomationRule[] }) {
  const { data: stores } = useStoresAdmin();
  const saveRules = useSaveAdSetRules();
  const [rules, setRules] = useState<AdSetAutomationRule[]>(initialRules);

  const add = () => setRules((current) => [
    ...current,
    {
      id: `rule_${Date.now()}`,
      name: "New routing rule",
      enabled: true,
      priority: 100,
      matchField: "ad_id",
      matchValue: "",
      storeId: null,
      assignedUserId: null,
      handling: "ai",
    },
  ]);

  const update = (id: string, patch: Partial<AdSetAutomationRule>) =>
    setRules((current) => current.map((rule) => rule.id === id ? { ...rule, ...patch } : rule));

  const save = async () => {
    if (rules.some((rule) => !rule.name.trim() || !rule.matchValue.trim())) {
      toast.error("Every rule needs a name and a match value.");
      return;
    }
    try {
      await saveRules.mutateAsync(rules);
      toast.success("Ad-set automation rules saved");
    } catch (error) {
      toast.error(apiErrorMessage(error, "Could not save the routing rules."));
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">How routing works</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          <p>
            The highest-priority matching rule wins. It can send an ad response to a regional
            store queue and decide whether AI or a person handles it. If no rule matches, the
            conversation remains unassigned; CaratOS never guesses a location.
          </p>
          <p className="mt-3">
            <strong className="text-foreground">Which match fields work today.</strong>{" "}
            A Click-to-WhatsApp click tells us the <strong className="text-foreground">ad ID</strong>{" "}
            and nothing more — Meta does not send the ad set or campaign with it. Copy an ad ID
            from Ads Manager and <em>Exact ad ID</em> rules route correctly right now, with no
            extra Meta permissions. The ad-set fields stay here for when a Meta Marketing API
            connection is approved; until then they will never match, and traffic they were
            meant to catch stays unassigned rather than being routed on a guess.
          </p>
        </CardContent>
      </Card>

      {rules.map((rule) => (
        <Card key={rule.id}>
          <CardContent className="space-y-4 pt-6">
            <div className="flex flex-wrap items-center gap-3">
              <Input
                className="min-w-56 flex-1"
                aria-label="Rule name"
                value={rule.name}
                onChange={(event) => update(rule.id, { name: event.target.value })}
              />
              <Badge variant={rule.handling === "ai" ? "default" : "secondary"}>
                {rule.handling === "ai" ? <Bot className="mr-1 h-3 w-3" /> : <UserRound className="mr-1 h-3 w-3" />}
                {rule.handling === "ai" ? "AI first" : "Human only"}
              </Badge>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  onChange={(event) => update(rule.id, { enabled: event.target.checked })}
                />
                Active
              </label>
              <Button variant="ghost" size="sm" onClick={() => setRules((all) => all.filter((item) => item.id !== rule.id))}>
                <Trash2 className="h-4 w-4" />
                <span className="sr-only">Delete {rule.name}</span>
              </Button>
            </div>

            <div className="grid gap-3 md:grid-cols-4">
              <Field label="Match using">
                <select className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={rule.matchField} onChange={(event) => update(rule.id, { matchField: event.target.value as AdSetAutomationRule["matchField"] })}>
                  <option value="ad_id">Exact ad ID (works with Click-to-WhatsApp today)</option>
                  <option value="ad_set_name">Ad-set name contains (needs Meta Marketing API)</option>
                  <option value="ad_set_id">Exact ad-set ID (needs Meta Marketing API)</option>
                  <option value="tag">Customer/ad tag</option>
                </select>
              </Field>
              <Field label="Match value">
                <Input value={rule.matchValue} placeholder="e.g. Hyderabad" onChange={(event) => update(rule.id, { matchValue: event.target.value })} />
              </Field>
              <Field label="Destination queue">
                <select className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={rule.storeId ?? ""} onChange={(event) => update(rule.id, { storeId: event.target.value || null })}>
                  <option value="">Organisation queue</option>
                  {stores?.filter((store) => !store.isAggregate && store.isActive).map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
                </select>
              </Field>
              <Field label="First handler">
                <select className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={rule.handling} onChange={(event) => update(rule.id, { handling: event.target.value as "ai" | "human" })}>
                  <option value="ai">AI first</option>
                  <option value="human">Human only</option>
                </select>
              </Field>
            </div>
          </CardContent>
        </Card>
      ))}

      <div className="flex justify-between gap-3">
        <Button variant="outline" onClick={add}><Plus className="mr-1 h-4 w-4" />Add rule</Button>
        <Button onClick={save} disabled={saveRules.isPending}>{saveRules.isPending ? "Saving…" : "Save rules"}</Button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1"><Label>{label}</Label>{children}</div>;
}
