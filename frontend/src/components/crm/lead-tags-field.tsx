"use client";

import Link from "next/link";
import { Tag, X } from "lucide-react";
import { toast } from "sonner";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useLeadTags, useLeadTagsFor, useSetLeadTags } from "@/lib/queries/lead-tags";
import { apiErrorMessage } from "@/lib/utils";

/**
 * Tags on one lead — "potential lead", "bridal", whatever the store chose in
 * Settings → Lead tags. The meeting's ask was to mark a contact so follow-ups go
 * to the ones worth following up; tags were definable but could not be put on a
 * lead anywhere until this.
 *
 * The whole set is written back on every change (PUT), so two quick clicks can
 * never leave the lead with a tag list neither click intended.
 */
export function LeadTagsField({ leadId }: { leadId: string }) {
  const all = useLeadTags();
  const current = useLeadTagsFor(leadId);
  const save = useSetLeadTags(leadId);

  const on = current.data ?? [];
  const onIds = new Set(on.map((t) => t.id));
  const available = (all.data ?? []).filter((t) => !onIds.has(t.id));

  const write = (tagIds: string[]) =>
    save.mutate(tagIds, {
      onError: (e) => toast.error(apiErrorMessage(e, "Could not update the tags.")),
    });

  return (
    <div>
      <p className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Tag className="h-3.5 w-3.5" aria-hidden="true" /> Tags
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        {on.map((t) => (
          <span
            key={t.id}
            className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium"
          >
            <span
              aria-hidden="true"
              className="h-2 w-2 rounded-full"
              style={{ background: t.colour ?? "var(--muted-foreground)" }}
            />
            {t.name}
            <button
              type="button"
              aria-label={`Remove tag ${t.name}`}
              disabled={save.isPending}
              onClick={() => write(on.filter((x) => x.id !== t.id).map((x) => x.id))}
              className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        {available.length > 0 ? (
          <Select
            value=""
            disabled={save.isPending}
            onValueChange={(id) => write([...on.map((t) => t.id), id])}
          >
            <SelectTrigger id={`lead-tag-add-${leadId}`} className="h-7 w-auto gap-1 px-2 text-xs">
              <SelectValue placeholder="+ Add tag" />
            </SelectTrigger>
            <SelectContent>
              {available.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        {all.isSuccess && (all.data ?? []).length === 0 ? (
          <span className="text-xs text-muted-foreground">
            No tags yet —{" "}
            <Link href="/settings/lead-tags" className="text-primary hover:underline">
              create them in Settings
            </Link>
            .
          </span>
        ) : null}
      </div>
    </div>
  );
}
