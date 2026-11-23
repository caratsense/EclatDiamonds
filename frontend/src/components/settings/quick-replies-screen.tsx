"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Clock,
  MessageSquarePlus,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { isTemplateSendable, useMessageTemplates } from "@/lib/queries/meta-admin";
import {
  type QuickReplyKind,
  type QuickReplyRow,
  useCreateQuickReply,
  useDeleteQuickReply,
  useQuickReplies,
  useReorderQuickReplies,
  useUpdateQuickReply,
} from "@/lib/queries/quick-replies";
import { ROLE_RANK } from "@/lib/types";
import { apiErrorMessage } from "@/lib/utils";
import { useSession } from "@/store/use-session";

/** The value the branch picker uses for "every branch"; Select needs a string. */
const EVERY_BRANCH = "__all__";

/**
 * Settings › Quick replies.
 *
 * ## Why the screen is here and not in the inbox
 *
 * Three quick replies were hardcoded in the conversations page, wording and
 * all, so changing one was a deployment. The client asked for "an add button to
 * create a quick reply or to edit" — but the person who adds one is not the
 * person who uses one. Using a chip happens mid-sentence with a customer
 * waiting; arranging them is a quiet five minutes with the whole list in view,
 * a branch to choose for each and an approved template to pick. Those are
 * different screens, so the inbox keeps a link to this one and nothing else.
 *
 * ## The two kinds, which is the whole point
 *
 * WhatsApp allows free text only within 24 hours of the customer's last
 * message; after that only an approved template may be sent. So a quick reply
 * is one or the other, and the screen says which: free text fills the composer
 * and is offered inside the window, a template-backed reply is offered at any
 * time and is the only thing that reaches somebody whose message was missed
 * yesterday. That was the client's actual question.
 *
 * ## Who may change what
 *
 * A branch manager writes replies for the branches they run. A reply every
 * branch reads is head office's, because it rewords what all eleven shops say
 * next — the server enforces it, and the picker simply does not offer "every
 * branch" to anybody else rather than offering it and then refusing the save.
 */
export function QuickRepliesScreen() {
  const role = useSession((s) => s.role);
  const stores = useSession((s) => s.stores);
  const canManage = ROLE_RANK[role] >= ROLE_RANK.store_manager;

  const list = useQuickReplies();
  const templates = useMessageTemplates();
  const create = useCreateQuickReply();
  const update = useUpdateQuickReply();
  const remove = useDeleteQuickReply();
  const reorder = useReorderQuickReplies();

  const branches = useMemo(() => stores.filter((s) => !s.isAggregate), [stores]);
  /*
   * Only templates that can actually be sent are on offer.
   *
   * `isTemplateSendable` is the same verdict the server applies at send time
   * (provider APPROVED, confirmed within the day, row still active). Offering
   * the rest would let somebody build a quick reply that looks finished and
   * reaches nobody — and the inbox would then silently not show the chip,
   * which is the worst of both.
   */
  const sendable = useMemo(
    () => (templates.data ?? []).filter((t) => isTemplateSendable(t) && !t.metadata.isCarousel),
    [templates.data],
  );

  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  if (!canManage) {
    return (
      <div className="mx-auto max-w-md px-6 py-24 text-center">
        <h1 className="font-display text-2xl font-bold tracking-tight">Quick replies</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Anyone can use a quick reply from the inbox. Changing what they say is a manager&rsquo;s
          job, because a reply reworded underneath a team changes what everybody says next.
        </p>
        <Button asChild className="mt-6">
          <Link href="/conversations">Back to Conversations</Link>
        </Button>
      </div>
    );
  }

  const rows = list.data?.rows ?? [];
  const placeholders = list.data?.placeholders ?? [];
  const canWriteEveryBranch = list.data?.canWriteEveryBranch ?? false;

  const move = (index: number, delta: number) => {
    const next = [...rows];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    reorder.mutate(
      next.map((r) => r.id),
      { onError: (e) => toast.error(apiErrorMessage(e, "Could not change the order.")) },
    );
  };

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Link
          href="/conversations"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" /> Conversations
        </Link>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <MessageSquarePlus className="size-5" /> Quick replies
        </h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          The chips above the message box in Conversations. Your team taps one instead of typing
          the same answer again.
        </p>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-base">The two kinds</CardTitle>
            <CardDescription>
              WhatsApp decides which of your replies can be sent when, so every quick reply is
              one kind or the other.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border bg-muted/30 p-3">
            <p className="flex items-center gap-1.5 text-sm font-semibold">
              <Pencil className="size-3.5" /> Wording
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Fills the message box so your team can add a line before sending. Offered only
              within 24 hours of the customer&rsquo;s last message &mdash; WhatsApp&rsquo;s rule,
              not ours.
            </p>
          </div>
          <div className="rounded-lg border bg-muted/30 p-3">
            <p className="flex items-center gap-1.5 text-sm font-semibold">
              <Clock className="size-3.5" /> Approved template
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Sends straight away, at any time &mdash; including when 24 hours have passed and
              nothing else can reach them. This is the one for a message somebody missed.
            </p>
          </div>
        </CardContent>
      </Card>

      {adding ? (
        <QuickReplyForm
          title="Add a quick reply"
          branches={branches}
          canWriteEveryBranch={canWriteEveryBranch}
          placeholders={placeholders}
          templates={sendable}
          busy={create.isPending}
          onCancel={() => setAdding(false)}
          onSave={(input) =>
            create.mutate(input, {
              onSuccess: () => {
                setAdding(false);
                toast.success(`"${input.label}" added.`);
              },
              onError: (e) => toast.error(apiErrorMessage(e, "Could not add that quick reply.")),
            })
          }
        />
      ) : (
        <Button onClick={() => setAdding(true)} className="gap-1.5">
          <Plus className="size-4" /> Add a quick reply
        </Button>
      )}

      {list.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={MessageSquarePlus}
          title="No quick replies yet"
          description="Add the answers your team types most often, and they become one tap in the inbox."
        />
      ) : (
        <div className="space-y-2">
          {rows.map((row, index) =>
            editing === row.id ? (
              <QuickReplyForm
                key={row.id}
                title={`Edit "${row.label}"`}
                row={row}
                branches={branches}
                canWriteEveryBranch={canWriteEveryBranch}
                placeholders={placeholders}
                templates={sendable}
                busy={update.isPending}
                onCancel={() => setEditing(null)}
                onSave={(input) =>
                  update.mutate(
                    { id: row.id, ...input },
                    {
                      onSuccess: () => {
                        setEditing(null);
                        toast.success("Saved.");
                      },
                      onError: (e) => toast.error(apiErrorMessage(e, "Could not save that.")),
                    },
                  )
                }
              />
            ) : (
              <Card key={row.id} className={row.isActive ? undefined : "opacity-60"}>
                <CardContent className="flex flex-wrap items-start gap-3 p-3">
                  <div className="flex shrink-0 flex-col gap-0.5">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-6"
                      aria-label={`Move "${row.label}" earlier`}
                      disabled={index === 0 || reorder.isPending}
                      onClick={() => move(index, -1)}
                    >
                      <ArrowUp className="size-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-6"
                      aria-label={`Move "${row.label}" later`}
                      disabled={index === rows.length - 1 || reorder.isPending}
                      onClick={() => move(index, 1)}
                    >
                      <ArrowDown className="size-3.5" />
                    </Button>
                  </div>

                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold">{row.label}</span>
                      <StatusPill tone={row.kind === "template" ? "good" : "mute"}>
                        {row.kind === "template" ? "Template" : "Wording"}
                      </StatusPill>
                      <StatusPill tone="mute">
                        {row.storeName ?? (row.storeId ? "Another branch" : "Every branch")}
                      </StatusPill>
                      {row.isActive ? null : <StatusPill tone="wait">Switched off</StatusPill>}
                    </div>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {row.kind === "template"
                        ? (row.templateName ?? "No template chosen")
                        : (row.body ?? "")}
                    </p>
                    {row.warning ? (
                      <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                        <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                        <span>{row.warning}</span>
                      </p>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="gap-1 text-xs"
                      onClick={() =>
                        update.mutate(
                          { id: row.id, isActive: !row.isActive },
                          {
                            onError: (e) =>
                              toast.error(apiErrorMessage(e, "Could not change that.")),
                          },
                        )
                      }
                    >
                      {row.isActive ? "Switch off" : "Switch on"}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-8"
                      aria-label={`Edit "${row.label}"`}
                      onClick={() => setEditing(row.id)}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-8 text-destructive"
                      aria-label={`Delete "${row.label}"`}
                      disabled={remove.isPending}
                      onClick={() => {
                        /*
                         * A plain confirm, not a dialog. Deleting a quick reply
                         * loses a shortcut and nothing else — no message, no
                         * customer record — so the ceremony a destructive
                         * dialog implies would overstate it. "Switch off" is
                         * beside it for anybody who only wants it gone for a
                         * season.
                         */
                        if (!window.confirm(`Delete "${row.label}"?`)) return;
                        remove.mutate(row.id, {
                          onSuccess: (r) => toast.success(`"${r.label}" deleted.`),
                          onError: (e) =>
                            toast.error(apiErrorMessage(e, "Could not delete that.")),
                        });
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ),
          )}
        </div>
      )}

      {templates.isError ? (
        <HelpNote more="Templates are read from the connected WhatsApp number. Without them a quick reply can still be wording, which works inside the 24-hour window.">
          Your approved templates could not be read, so only wording can be added right now.
        </HelpNote>
      ) : null}
    </div>
  );
}

/** Add and edit are the same form; the only difference is what it starts from. */
function QuickReplyForm({
  title,
  row,
  branches,
  canWriteEveryBranch,
  placeholders,
  templates,
  busy,
  onSave,
  onCancel,
}: {
  title: string;
  row?: QuickReplyRow;
  branches: { id: string; name: string }[];
  canWriteEveryBranch: boolean;
  placeholders: { token: string; what: string; standIn: string }[];
  templates: { id: string; name: string | null; externalId: string }[];
  busy: boolean;
  onSave: (input: {
    label: string;
    kind: QuickReplyKind;
    body?: string;
    templateAssetId?: string;
    storeId?: string | null;
  }) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(row?.label ?? "");
  const [kind, setKind] = useState<QuickReplyKind>(row?.kind ?? "free_text");
  const [body, setBody] = useState(row?.body ?? "");
  const [templateAssetId, setTemplateAssetId] = useState(row?.templateAssetId ?? "");
  const [storeId, setStoreId] = useState<string>(
    row ? (row.storeId ?? EVERY_BRANCH) : canWriteEveryBranch ? EVERY_BRANCH : (branches[0]?.id ?? ""),
  );

  const submit = () => {
    const trimmed = label.trim();
    if (trimmed.length < 2) {
      toast.error("Give the chip a short name, so your team knows what it says.");
      return;
    }
    if (kind === "free_text" && !body.trim()) {
      toast.error("Type the words this quick reply should send.");
      return;
    }
    if (kind === "template" && !templateAssetId) {
      toast.error("Choose the approved template this should send.");
      return;
    }
    onSave({
      label: trimmed,
      kind,
      ...(kind === "free_text" ? { body: body.trim() } : { templateAssetId }),
      storeId: storeId === EVERY_BRANCH ? null : storeId,
    });
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">{title}</CardTitle>
        <Button size="icon" variant="ghost" className="size-8" aria-label="Cancel" onClick={onCancel}>
          <X className="size-4" />
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="qr-label">What the chip says</Label>
            <Input
              id="qr-label"
              value={label}
              maxLength={32}
              placeholder="Store Location"
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="qr-kind">Kind</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as QuickReplyKind)}>
              <SelectTrigger id="qr-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="free_text">Wording &mdash; fills the box</SelectItem>
                <SelectItem value="template">Template &mdash; sends any time</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {kind === "free_text" ? (
          <div className="space-y-1">
            <Label htmlFor="qr-body">The words</Label>
            <Textarea
              id="qr-body"
              value={body}
              rows={3}
              maxLength={4096}
              placeholder="Hello {customer}! Our {branch} showroom is open 10:30 AM to 8:30 PM."
              onChange={(e) => setBody(e.target.value)}
            />
            <HelpNote
              label="What can go in the words"
              more={
                <ul className="space-y-0.5">
                  {placeholders.map((p) => (
                    <li key={p.token}>
                      <code className="font-mono">{`{${p.token}}`}</code> &mdash; {p.what}. If it
                      is not known, &ldquo;{p.standIn}&rdquo; is sent instead.
                    </li>
                  ))}
                </ul>
              }
            >
              Use{" "}
              {placeholders.map((p, i) => (
                <span key={p.token}>
                  {i > 0 ? ", " : ""}
                  <code className="font-mono">{`{${p.token}}`}</code>
                </span>
              ))}{" "}
              and they are filled in when the chip is used.
            </HelpNote>
          </div>
        ) : (
          <div className="space-y-1">
            <Label htmlFor="qr-template">The approved template</Label>
            {templates.length === 0 ? (
              <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                No template on this account can be sent at the moment. Synchronise templates on
                Settings &rsaquo; Message Templates, then come back &mdash; only a template Meta
                has approved can reach somebody after 24 hours.
              </p>
            ) : (
              <Select value={templateAssetId} onValueChange={setTemplateAssetId}>
                <SelectTrigger id="qr-template">
                  <SelectValue placeholder="Choose a template" />
                </SelectTrigger>
                <SelectContent>
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name ?? t.externalId}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <HelpNote more="A template's wording is approved by Meta and cannot be edited here, which is why pressing the chip sends it rather than putting it in the box. Change the words on Settings › Message Templates and Meta reviews them again.">
              Pressing this chip sends the template immediately.
            </HelpNote>
          </div>
        )}

        <div className="space-y-1">
          <Label htmlFor="qr-branch">Which branch</Label>
          <Select value={storeId} onValueChange={setStoreId}>
            <SelectTrigger id="qr-branch" className="sm:w-80">
              <SelectValue placeholder="Choose a branch" />
            </SelectTrigger>
            <SelectContent>
              {/* Offered only to head office, because the server allows it only
                  to head office — a picker that let a branch manager choose it
                  and then failed the save would be a worse version of the rule. */}
              {canWriteEveryBranch ? (
                <SelectItem value={EVERY_BRANCH}>Every branch</SelectItem>
              ) : null}
              {branches.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {canWriteEveryBranch ? null : (
            <p className="text-xs text-muted-foreground">
              A quick reply every branch sees is head office&rsquo;s to add.
            </p>
          )}
        </div>

        <div className="flex gap-2">
          <Button onClick={submit} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
