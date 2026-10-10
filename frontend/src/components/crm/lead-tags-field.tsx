"use client";

import { Tag, X } from "lucide-react";
import { toast } from "sonner";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useState } from "react";

import {
  useCreateLeadTag,
  useLeadTags,
  useLeadTagsFor,
  usePartyTagsFor,
  useSetLeadTags,
  useSetPartyTags,
} from "@/lib/queries/lead-tags";
import { ROLE_RANK } from "@/lib/types";
import { useSession } from "@/store/use-session";
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
  const current = useLeadTagsFor(leadId);
  const save = useSetLeadTags(leadId);
  return <TagsField id={leadId} current={current.data} save={save} />;
}

/** The same chips on a CUSTOMER (client, 9 Oct) — one vocabulary, two targets. */
export function PartyTagsField({ partyId }: { partyId: string }) {
  const current = usePartyTagsFor(partyId);
  const save = useSetPartyTags(partyId);
  return <TagsField id={partyId} current={current.data} save={save} />;
}

function TagsField({
  id,
  current,
  save,
}: {
  id: string;
  current: { id: string; name: string; colour: string | null }[] | undefined;
  save: { isPending: boolean; mutate: (ids: string[], opts: { onError: (e: unknown) => void }) => void };
}) {
  const all = useLeadTags();
  const create = useCreateLeadTag();
  const role = useSession((st) => st.baseRole);
  // Creating vocabulary is a manager act (the server enforces it too);
  // applying existing tags stays open to the floor.
  const canCreate = ROLE_RANK[role] >= ROLE_RANK.store_manager;
  const [newTag, setNewTag] = useState("");

  const on = current ?? [];
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
            <SelectTrigger id={`lead-tag-add-${id}`} className="h-7 w-auto gap-1 px-2 text-xs">
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
        {canCreate ? (
          /* Type a tag that does not exist yet — "imp", "bought" — and it is
             created and put on this customer in one move (client, 10 Oct). */
          <form
            className="inline-flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              const name = newTag.trim();
              if (!name) return;
              const existing = (all.data ?? []).find(
                (t) => t.name.toLowerCase() === name.toLowerCase(),
              );
              if (existing) {
                if (!onIds.has(existing.id)) write([...on.map((t) => t.id), existing.id]);
                setNewTag("");
                return;
              }
              create.mutate(
                { name },
                {
                  onSuccess: (made) => {
                    setNewTag("");
                    write([...on.map((t) => t.id), made.id]);
                  },
                  onError: (err) => toast.error(apiErrorMessage(err, "Could not create the tag.")),
                },
              );
            }}
          >
            <input
              aria-label="New tag"
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              maxLength={40}
              placeholder="New tag…"
              className="h-7 w-24 rounded-md border bg-background px-2 text-xs"
            />
            <button
              type="submit"
              disabled={!newTag.trim() || create.isPending || save.isPending}
              className="h-7 rounded-md border px-2 text-xs font-medium text-muted-foreground hover:bg-muted/60 disabled:opacity-50"
            >
              {create.isPending ? "…" : "Tag"}
            </button>
          </form>
        ) : all.isSuccess && (all.data ?? []).length === 0 ? (
          <span className="text-xs text-muted-foreground">
            No tags yet — ask a manager to add one here.
          </span>
        ) : null}
      </div>
    </div>
  );
}
