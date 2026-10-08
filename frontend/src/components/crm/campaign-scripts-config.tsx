"use client";

import { useState } from "react";
import { Link2, Megaphone, MessageCircleMore, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { Textarea } from "@/components/ui/textarea";
import {
  adIdFromLink,
  useAdSetRules,
  useSaveAdSetRules,
  type AdSetAutomationRule,
} from "@/lib/queries/crm-ai";
import { apiErrorMessage } from "@/lib/utils";
import { useSession } from "@/store/use-session";

const MATCH_LABELS: Record<AdSetAutomationRule["matchField"], string> = {
  ad_id: "this exact ad",
  ad_set_id: "this exact ad set",
  ad_set_name: "ad sets named like",
  campaign_name: "campaigns named like",
  tag: "the tag",
};

const EMPTY: Omit<AdSetAutomationRule, "id"> = {
  name: "",
  enabled: true,
  priority: 100,
  matchField: "campaign_name",
  matchValue: "",
  storeId: null,
  assignedUserId: null,
  handling: "ai",
  aiContext: "",
  aiGuardrails: "",
  adLink: "",
  firstReply: "",
  questions: [],
};

/**
 * Campaign conversations (client, 8 Oct): for each advertisement, what the bot
 * says when a customer arrives from it — the exact first reply, the questions
 * to work toward, and the brief (products, prices, links) it may answer from.
 *
 * Campaigns here ARE the ad-routing rules (Settings → Business Configuration →
 * Ad routing edits the same list) — one object, two views, so the campaign that
 * routes an enquiry is always the campaign whose script answers it. Customers
 * type freely; the assistant answers from the brief. No menus, ever.
 */
export function CampaignScriptsConfig() {
  const { data, isLoading } = useAdSetRules();
  const save = useSaveAdSetRules();
  const role = useSession((s) => s.role);
  const stores = useSession((s) => s.stores).filter((s) => !s.isAggregate);
  const canEdit = role === "head_office";

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Omit<AdSetAutomationRule, "id">>(EMPTY);

  const rules = data ?? [];
  const linkAdId = adIdFromLink(draft.adLink ?? "");

  function openNew() {
    setEditingId(null);
    setDraft({ ...EMPTY, storeId: stores[0]?.id ?? null });
    setOpen(true);
  }

  function openEdit(rule: AdSetAutomationRule) {
    setEditingId(rule.id);
    setDraft({ ...rule });
    setOpen(true);
  }

  function persist(next: AdSetAutomationRule[], done: string) {
    save.mutate(next, {
      onSuccess: () => {
        toast.success(done);
        setOpen(false);
      },
      onError: (e) => toast.error(apiErrorMessage(e, "Could not save the campaign.")),
    });
  }

  function onSave() {
    if (!draft.name.trim()) {
      toast.error("Give the campaign a name.");
      return;
    }
    if (!draft.matchValue.trim() && !linkAdId) {
      toast.error("Paste the ad link, or say what the campaign is matched by.");
      return;
    }
    const entry: AdSetAutomationRule = {
      ...draft,
      id: editingId ?? `camp-${Date.now().toString(36)}`,
      handling: "ai",
      name: draft.name.trim(),
    };
    const next = editingId
      ? rules.map((r) => (r.id === editingId ? entry : r))
      : [...rules, entry];
    persist(next, editingId ? "Campaign updated." : "Campaign added.");
  }

  function onDelete(id: string) {
    persist(
      rules.filter((r) => r.id !== id),
      "Campaign removed.",
    );
  }

  function setQuestion(index: number, value: string) {
    setDraft((d) => {
      const questions = [...(d.questions ?? [])];
      questions[index] = value;
      return { ...d, questions };
    });
  }

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Campaign conversations</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Megaphone className="h-4 w-4" /> Campaign conversations
            </CardTitle>
            <CardDescription>
              For each advertisement: what the bot replies when a customer
              arrives from it, what it asks, and what it may quote. Customers
              type freely — no menus.
            </CardDescription>
          </div>
          <Button size="sm" onClick={openNew} disabled={!canEdit} title={canEdit ? undefined : "Head office configures campaigns"}>
            <Plus className="h-4 w-4" />
            Add campaign
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {rules.length === 0 ? (
          <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
            No campaigns yet. Add one and paste its ad link — enquiries from
            that ad will get its configured conversation.
          </p>
        ) : (
          rules.map((rule) => (
            <div
              key={rule.id}
              className="flex flex-wrap items-start justify-between gap-3 rounded-lg border p-3"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{rule.name}</span>
                  {!rule.enabled ? <Badge variant="secondary">Off</Badge> : null}
                  {rule.handling === "human" ? (
                    <Badge variant="outline">Straight to a person</Badge>
                  ) : rule.firstReply || rule.aiContext ? (
                    <Badge variant="outline" className="text-[var(--success)]">
                      <MessageCircleMore className="mr-1 h-3 w-3" />
                      Scripted
                    </Badge>
                  ) : (
                    <Badge variant="secondary">Routing only — no script</Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Matches {MATCH_LABELS[rule.matchField]}{" "}
                  <span className="font-mono">{rule.matchValue}</span>
                  {rule.storeId
                    ? ` · ${stores.find((s) => s.id === rule.storeId)?.name ?? rule.storeId}`
                    : ""}
                </p>
                {rule.firstReply ? (
                  <p className="line-clamp-2 max-w-xl text-xs text-muted-foreground">
                    “{rule.firstReply}”
                  </p>
                ) : null}
              </div>
              <div className="flex items-center gap-1.5">
                <Button variant="outline" size="sm" onClick={() => openEdit(rule)} disabled={!canEdit}>
                  <Pencil className="h-3.5 w-3.5" />
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  onClick={() => onDelete(rule.id)}
                  disabled={!canEdit || save.isPending}
                  title="Remove this campaign"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit campaign" : "Add campaign"}</DialogTitle>
            <DialogDescription>
              A customer who taps this campaign&rsquo;s ad gets this conversation.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="camp-name">Campaign name</Label>
              <Input
                id="camp-name"
                value={draft.name}
                placeholder="e.g. Solitaire ring — Know the price"
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="camp-link">Ad link</Label>
              <Input
                id="camp-link"
                value={draft.adLink ?? ""}
                placeholder="Paste the ad's link from Meta"
                onChange={(e) => setDraft((d) => ({ ...d, adLink: e.target.value }))}
              />
              {linkAdId ? (
                <p className="flex items-center gap-1 text-xs text-[var(--success)]">
                  <Link2 className="h-3 w-3" /> Connected: enquiries from ad{" "}
                  <span className="font-mono">{linkAdId}</span> get this conversation.
                </p>
              ) : (draft.adLink ?? "").trim() ? (
                <p className="text-xs text-warning">
                  No ad id found in this link — use the match below instead.
                </p>
              ) : null}
            </div>

            <div className="grid gap-1.5">
              <Label>Or match by</Label>
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] gap-2">
                <Select
                  value={draft.matchField}
                  onValueChange={(v) =>
                    setDraft((d) => ({ ...d, matchField: v as AdSetAutomationRule["matchField"] }))
                  }
                >
                  <SelectTrigger aria-label="Match field">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="campaign_name">Campaign name</SelectItem>
                    <SelectItem value="ad_set_name">Ad set name</SelectItem>
                    <SelectItem value="ad_id">Ad id</SelectItem>
                    <SelectItem value="ad_set_id">Ad set id</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  aria-label="Match value"
                  value={draft.matchValue}
                  placeholder={linkAdId ? "Not needed — the link covers it" : "e.g. Diwali Solitaire"}
                  onChange={(e) => setDraft((d) => ({ ...d, matchValue: e.target.value }))}
                />
              </div>
            </div>

            <div className="grid gap-1.5">
              <Label>Store</Label>
              <Select
                value={draft.storeId ?? "__none__"}
                onValueChange={(v) =>
                  setDraft((d) => ({ ...d, storeId: v === "__none__" ? null : v }))
                }
              >
                <SelectTrigger aria-label="Store">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Decide later (head-office queue)</SelectItem>
                  {stores.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="camp-first">First reply — sent exactly as written</Label>
              <Textarea
                id="camp-first"
                rows={3}
                maxLength={1200}
                value={draft.firstReply ?? ""}
                placeholder="e.g. Hi! The solitaire ring from our ad starts at ₹85,000 for 0.5 carat (IGI certified)."
                onChange={(e) => setDraft((d) => ({ ...d, firstReply: e.target.value }))}
              />
            </div>

            <div className="grid gap-1.5">
              <Label>Questions to work toward (optional)</Label>
              {[0, 1, 2].map((i) => (
                <Input
                  key={i}
                  aria-label={`Question ${i + 1}`}
                  maxLength={300}
                  value={draft.questions?.[i] ?? ""}
                  placeholder={
                    i === 0 ? "e.g. Which carat size are you considering?" : "Another question (optional)"
                  }
                  onChange={(e) => setQuestion(i, e.target.value)}
                />
              ))}
              <p className="text-xs text-muted-foreground">
                Asked one at a time, at natural moments — never as a menu, and
                never re-asked once the customer has answered.
              </p>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="camp-brief">
                What the assistant knows — products, prices, links
              </Label>
              <Textarea
                id="camp-brief"
                rows={5}
                maxLength={5000}
                value={draft.aiContext ?? ""}
                placeholder={
                  "e.g. Pricing: 0.5ct ₹85,000; 0.7ct ₹1,30,000; 1ct ₹2,40,000. IGI certified, 14-day exchange. Catalogue: https://…"
                }
                onChange={(e) => setDraft((d) => ({ ...d, aiContext: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">
                The assistant answers follow-ups only from this. Anything not
                covered here goes to a person instead of being guessed.
              </p>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="camp-rails">House rules (optional)</Label>
              <Textarea
                id="camp-rails"
                rows={2}
                maxLength={2000}
                value={draft.aiGuardrails ?? ""}
                placeholder="e.g. No discounts beyond the listed prices."
                onChange={(e) => setDraft((d) => ({ ...d, aiGuardrails: e.target.value }))}
              />
            </div>

            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <p className="text-sm font-medium">Campaign is live</p>
                <p className="text-xs text-muted-foreground">
                  Off, and its enquiries fall back to the normal flow.
                </p>
              </div>
              <div role="radiogroup" aria-label="Campaign live" className="flex rounded-md border p-0.5">
                {([
                  { on: false, label: "Off" },
                  { on: true, label: "On" },
                ] as const).map((o) => (
                  <button
                    key={o.label}
                    type="button"
                    role="radio"
                    aria-checked={draft.enabled === o.on}
                    onClick={() => setDraft((d) => ({ ...d, enabled: o.on }))}
                    className={
                      draft.enabled === o.on
                        ? o.on
                          ? "rounded bg-primary px-4 py-1 text-xs font-medium text-primary-foreground"
                          : "rounded bg-muted px-4 py-1 text-xs font-medium text-foreground"
                        : "rounded px-4 py-1 text-xs font-medium text-muted-foreground hover:bg-muted/60"
                    }
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={onSave} disabled={save.isPending || !canEdit}>
              {save.isPending ? "Saving…" : editingId ? "Save campaign" : "Add campaign"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
