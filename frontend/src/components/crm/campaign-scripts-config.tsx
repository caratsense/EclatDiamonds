"use client";

import { useState } from "react";
import {
  Link2,
  Megaphone,
  MessageCircleMore,
  MessageSquareText,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
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
  useBotDefault,
  useSaveAdSetRules,
  useSaveBotDefault,
  type AdSetAutomationRule,
  type CampaignQuestion,
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

/**
 * A question as edited: choices stay the comma string the user typed, because
 * parsing into an array on every keystroke would eat the comma (and its space)
 * the moment it was entered.
 */
interface QuestionDraft {
  text: string;
  options: string;
}

/** Rules saved before 12 Oct carry plain strings; read both, write objects. */
function toQuestionDrafts(questions: (CampaignQuestion | string)[] | undefined): QuestionDraft[] {
  return (questions ?? []).map((q) =>
    typeof q === "string"
      ? { text: q, options: "" }
      : { text: q.text, options: (q.options ?? []).join(", ") },
  );
}

function fromQuestionDrafts(rows: QuestionDraft[]): CampaignQuestion[] {
  return rows
    .map((row): CampaignQuestion | null => {
      const text = row.text.trim();
      if (!text) return null;
      // The server's limits (6 choices of 60 chars) applied here too, so what
      // comes back after saving is what was shown before saving.
      const options = row.options
        .split(",")
        .map((o) => o.trim().slice(0, 60))
        .filter(Boolean)
        .slice(0, 6);
      return options.length ? { text, options } : { text };
    })
    .filter((q): q is CampaignQuestion => q !== null)
    .slice(0, 5);
}

/**
 * How a campaign is matched, as the person thinks of it. The stored fields are
 * unchanged (adLink / matchField / matchValue) — this only decides which input
 * is shown. "raw" is the fallback for an existing rule pinned by ad_id,
 * ad_set_id or tag without a link: those stay editable, just not promoted.
 */
type AppliesTo = "ad" | "campaign" | "adset" | "raw";

const APPLIES_TO_CHOICES: { mode: Exclude<AppliesTo, "raw">; label: string }[] = [
  { mode: "ad", label: "One specific ad — paste its link" },
  { mode: "campaign", label: "A whole campaign — its name exactly as in Ads Manager" },
  { mode: "adset", label: "An ad set — its name" },
];

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
  const [questionRows, setQuestionRows] = useState<QuestionDraft[]>([]);
  const [appliesTo, setAppliesTo] = useState<AppliesTo>("ad");

  const rules = data ?? [];
  const linkAdId = adIdFromLink(draft.adLink ?? "");

  function openNew() {
    setEditingId(null);
    setDraft({ ...EMPTY, storeId: stores[0]?.id ?? null });
    setQuestionRows([]);
    setAppliesTo("ad");
    setOpen(true);
  }

  function openEdit(rule: AdSetAutomationRule) {
    setEditingId(rule.id);
    setDraft({ ...rule });
    setQuestionRows(toQuestionDrafts(rule.questions));
    setAppliesTo(
      rule.adLink
        ? "ad"
        : rule.matchField === "campaign_name"
          ? "campaign"
          : rule.matchField === "ad_set_name"
            ? "adset"
            : "raw",
    );
    setOpen(true);
  }

  function chooseAppliesTo(mode: Exclude<AppliesTo, "raw">) {
    setAppliesTo(mode);
    // The name modes ARE a matchField. The ad mode leaves it alone: the server
    // rewrites a bare link as an exact ad_id match when it saves.
    if (mode === "campaign") setDraft((d) => ({ ...d, matchField: "campaign_name" }));
    if (mode === "adset") setDraft((d) => ({ ...d, matchField: "ad_set_name" }));
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
    if (appliesTo === "ad" && !linkAdId) {
      toast.error("Paste the ad's link — the id inside it connects enquiries to this conversation.");
      return;
    }
    if (appliesTo !== "ad" && !draft.matchValue.trim()) {
      toast.error(
        appliesTo === "campaign"
          ? "Type the campaign's name exactly as it is in Ads Manager."
          : appliesTo === "adset"
            ? "Type the ad set's name."
            : "Say what the campaign is matched by.",
      );
      return;
    }
    const entry: AdSetAutomationRule = {
      ...draft,
      id: editingId ?? `camp-${Date.now().toString(36)}`,
      handling: "ai",
      name: draft.name.trim(),
      questions: fromQuestionDrafts(questionRows),
      // The unchosen mode's field is cleared rather than left behind: a typed
      // match value shadows the link server-side, and a lingering link would
      // silently re-pin a name rule to one ad.
      ...(appliesTo === "ad"
        ? { matchValue: "" }
        : appliesTo === "raw"
          ? {}
          : { adLink: "" }),
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
                  {rule.questions?.length
                    ? ` · ${rule.questions.length} question${rule.questions.length === 1 ? "" : "s"}`
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
              <Label>Applies to</Label>
              <div role="radiogroup" aria-label="Applies to" className="grid gap-1.5">
                {APPLIES_TO_CHOICES.map((o) => (
                  <button
                    key={o.mode}
                    type="button"
                    role="radio"
                    aria-checked={appliesTo === o.mode}
                    onClick={() => chooseAppliesTo(o.mode)}
                    className={
                      appliesTo === o.mode
                        ? "rounded-md border border-primary bg-primary/5 px-3 py-1.5 text-left text-xs font-medium text-foreground"
                        : "rounded-md border px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/60"
                    }
                  >
                    {o.label}
                  </button>
                ))}
              </div>

              {appliesTo === "ad" ? (
                <>
                  <Input
                    id="camp-link"
                    aria-label="Ad link"
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
                      No ad id found in this link — check it was copied from Ads Manager.
                    </p>
                  ) : null}
                </>
              ) : appliesTo === "campaign" ? (
                <Input
                  aria-label="Campaign name in Ads Manager"
                  value={draft.matchValue}
                  placeholder="e.g. Diwali Solitaire"
                  onChange={(e) => setDraft((d) => ({ ...d, matchValue: e.target.value }))}
                />
              ) : appliesTo === "adset" ? (
                <Input
                  aria-label="Ad set name"
                  value={draft.matchValue}
                  placeholder="The ad set's name in Ads Manager"
                  onChange={(e) => setDraft((d) => ({ ...d, matchValue: e.target.value }))}
                />
              ) : (
                /* An existing rule pinned by raw id or tag: show the match as
                   stored rather than forcing it into one of the three shapes. */
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
                    placeholder="e.g. Diwali Solitaire"
                    onChange={(e) => setDraft((d) => ({ ...d, matchValue: e.target.value }))}
                  />
                </div>
              )}
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

            <QuestionsEditor rows={questionRows} onChange={setQuestionRows} />

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

/**
 * The questions block, shared between the campaign editor and the walk-in
 * card so the two forms cannot drift apart. Up to 5 questions; each may carry
 * choices the assistant phrases INSIDE a sentence — never shown as buttons.
 */
function QuestionsEditor({
  rows,
  onChange,
  disabled,
}: {
  rows: QuestionDraft[];
  onChange: (rows: QuestionDraft[]) => void;
  disabled?: boolean;
}) {
  // One empty row is always on screen, so the first question needs no click.
  const visible = rows.length ? rows : [{ text: "", options: "" }];

  function setRow(index: number, patch: Partial<QuestionDraft>) {
    onChange(visible.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  return (
    <div className="grid gap-1.5">
      <Label>Questions to work toward (optional)</Label>
      {visible.map((row, i) => (
        <div key={i} className="grid gap-1">
          <Input
            aria-label={`Question ${i + 1}`}
            maxLength={300}
            disabled={disabled}
            value={row.text}
            placeholder={
              i === 0 ? "e.g. Which carat size are you considering?" : "Another question (optional)"
            }
            onChange={(e) => setRow(i, { text: e.target.value })}
          />
          <Input
            aria-label={`Question ${i + 1} choices`}
            className="h-8 text-xs"
            /* 6 choices × 60 chars plus separators — the server's ceiling. */
            maxLength={370}
            disabled={disabled}
            value={row.options}
            placeholder="Choices the bot may mention (comma separated, optional)"
            onChange={(e) => setRow(i, { options: e.target.value })}
          />
        </div>
      ))}
      {visible.length < 5 ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-fit text-muted-foreground"
          disabled={disabled}
          onClick={() => onChange([...visible, { text: "", options: "" }])}
        >
          <Plus className="h-3.5 w-3.5" /> Add question
        </Button>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Asked one at a time, at natural moments — never as a menu, and never
        re-asked once the customer has answered. Choices are woven into the
        question as a sentence, never shown as buttons.
      </p>
    </div>
  );
}

/** The walk-in form as edited. Strings throughout; nulls appear only on save. */
interface WalkInDraft {
  enabled: boolean;
  firstReply: string;
  questions: QuestionDraft[];
  aiContext: string;
  aiGuardrails: string;
}

/**
 * The walk-in conversation (client, 12 Oct): the same anatomy as a campaign
 * script with no matching, for the customer who messages from NO ad. On, it
 * replaces the legacy button questionnaire for those customers; a campaign
 * still wins whenever an ad referral matches. Off, the old questionnaire
 * keeps running untouched.
 */
export function WalkInConversationConfig() {
  const { data, isLoading } = useBotDefault();
  const save = useSaveBotDefault();
  const role = useSession((s) => s.role);
  const canEdit = role === "head_office";

  // Overlay draft: null means "showing what the server has". Every edit copies
  // the whole form first, so no effect is needed to sync state to the query.
  const [draft, setDraft] = useState<WalkInDraft | null>(null);

  const form: WalkInDraft | null =
    draft ??
    (data
      ? {
          enabled: data.enabled,
          firstReply: data.firstReply ?? "",
          questions: toQuestionDrafts(data.questions),
          aiContext: data.aiContext ?? "",
          aiGuardrails: data.aiGuardrails ?? "",
        }
      : null);

  function edit(patch: Partial<WalkInDraft>) {
    if (form) setDraft({ ...form, ...patch });
  }

  function onSave() {
    if (!form) return;
    if (form.enabled && !form.firstReply.trim()) {
      // The server refuses this too; saying it here keeps the half-typed form.
      toast.error("Switched on, the walk-in conversation needs its first reply.");
      return;
    }
    save.mutate(
      {
        enabled: form.enabled,
        firstReply: form.firstReply.trim() || null,
        questions: fromQuestionDrafts(form.questions),
        aiContext: form.aiContext.trim() || null,
        aiGuardrails: form.aiGuardrails.trim() || null,
      },
      {
        onSuccess: () => {
          setDraft(null);
          toast.success("Walk-in conversation saved.");
        },
        onError: (e) =>
          toast.error(apiErrorMessage(e, "Could not save the walk-in conversation.")),
      },
    );
  }

  if (isLoading || !form) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Walk-in conversation (no ad)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-24 w-full" />
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
              <MessageSquareText className="h-4 w-4" /> Walk-in conversation (no ad)
            </CardTitle>
            <CardDescription>
              On: a customer who messages without tapping an ad gets this
              free-text conversation. Off: the old fixed questionnaire keeps
              running for them. Enquiries from an ad always get their
              campaign&rsquo;s conversation instead.
            </CardDescription>
          </div>
          <div role="radiogroup" aria-label="Walk-in conversation" className="flex rounded-md border p-0.5">
            {([
              { on: false, label: "Off" },
              { on: true, label: "On" },
            ] as const).map((o) => (
              <button
                key={o.label}
                type="button"
                role="radio"
                aria-checked={form.enabled === o.on}
                disabled={!canEdit}
                onClick={() => edit({ enabled: o.on })}
                className={
                  form.enabled === o.on
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
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-1.5">
          <Label htmlFor="walkin-first">First reply — sent exactly as written</Label>
          <Textarea
            id="walkin-first"
            rows={3}
            maxLength={1200}
            disabled={!canEdit}
            value={form.firstReply}
            placeholder="e.g. Hi! Welcome to Eclat Diamonds. What are you looking for today?"
            onChange={(e) => edit({ firstReply: e.target.value })}
          />
        </div>

        <QuestionsEditor
          rows={form.questions}
          onChange={(questions) => edit({ questions })}
          disabled={!canEdit}
        />

        <div className="grid gap-1.5">
          <Label htmlFor="walkin-brief">
            What the assistant knows — products, prices, links
          </Label>
          <Textarea
            id="walkin-brief"
            rows={5}
            maxLength={5000}
            disabled={!canEdit}
            value={form.aiContext}
            placeholder={
              "e.g. Pricing: 0.5ct ₹85,000; 0.7ct ₹1,30,000; 1ct ₹2,40,000. IGI certified, 14-day exchange. Catalogue: https://…"
            }
            onChange={(e) => edit({ aiContext: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            The assistant answers follow-ups only from this. Anything not
            covered here goes to a person instead of being guessed.
          </p>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="walkin-rails">House rules (optional)</Label>
          <Textarea
            id="walkin-rails"
            rows={2}
            maxLength={2000}
            disabled={!canEdit}
            value={form.aiGuardrails}
            placeholder="e.g. No discounts beyond the listed prices."
            onChange={(e) => edit({ aiGuardrails: e.target.value })}
          />
        </div>

        <div className="flex justify-end">
          <Button
            onClick={onSave}
            disabled={save.isPending || !canEdit}
            title={canEdit ? undefined : "Head office configures the walk-in conversation"}
          >
            {save.isPending ? "Saving…" : "Save walk-in conversation"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
