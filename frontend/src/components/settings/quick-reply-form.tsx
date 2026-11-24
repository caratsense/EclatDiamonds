"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Textarea } from "@/components/ui/textarea";
import type { QuickReplyKind, QuickReplyRow } from "@/lib/queries/quick-replies";

/** The value the branch picker uses for "every branch"; Select needs a string. */
export const EVERY_BRANCH = "__all__";

/**
 * The add/edit form for one quick reply.
 *
 * Its own file because it is now opened from two places. Settings shows it
 * inline, with the whole list around it to reorder and scope. The inbox opens
 * it in a dialog over the thread — the client asked for that directly ("I told
 * you to add an edit button onto it... I wanted an option to create a quick
 * reply and then that gets saved"), and she is right that the moment somebody
 * decides an answer is worth keeping is the moment they have just typed it.
 * One form, so the two can never drift into disagreeing about what is valid.
 */
export function QuickReplyForm({
  title,
  row,
  branches,
  canWriteEveryBranch,
  placeholders,
  templates,
  busy,
  initialBody,
  chrome = "card",
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
  /**
   * Words to start from when adding — what the salesperson has already typed
   * into the composer. "That answer again" is the moment somebody realises it
   * should be a chip, and retyping it there is how the thought gets dropped.
   * Ignored when editing: `row` already carries its own words.
   */
  initialBody?: string;
  /** `bare` drops the Card and its header, for a dialog that has its own. */
  chrome?: "card" | "bare";
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
  const [body, setBody] = useState(row?.body ?? initialBody ?? "");
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

  const fields = (
    <div className="space-y-4">
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
    </div>
  );

  if (chrome === "bare") return fields;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">{title}</CardTitle>
        <Button size="icon" variant="ghost" className="size-8" aria-label="Cancel" onClick={onCancel}>
          <X className="size-4" />
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
      {fields}
      </CardContent>
    </Card>
  );
}
