"use client";

import { Check, Tag } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLeadTags } from "@/lib/queries/lead-tags";

/**
 * Filter the CRM board by tag. Picking several shows leads carrying ANY of them;
 * picking none shows every lead.
 *
 * Only active tags are offered. A retired tag that arrived in a shared link still
 * filters — it is counted on the button so the narrowing is never invisible.
 */
export function LeadTagFilter({
  value,
  onChange,
}: {
  value: string[];
  onChange: (tagIds: string[]) => void;
}) {
  const tags = useLeadTags();
  const active = tags.data ?? [];
  const selected = new Set(value);
  const names = active.filter((t) => selected.has(t.id)).map((t) => t.name);
  const hidden = value.length - names.length;

  const label = !value.length
    ? "All tags"
    : names.length === 1 && !hidden
      ? names[0]
      : `${value.length} tags`;

  const toggle = (id: string) =>
    onChange(selected.has(id) ? value.filter((v) => v !== id) : [...value, id]);

  return (
    <div className="grid gap-1.5">
      <span id="lead-tag-filter-label" className="text-xs text-muted-foreground">
        Tags
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            id="lead-tag-filter"
            aria-labelledby="lead-tag-filter-label lead-tag-filter"
            variant="outline"
            size="sm"
            className="h-9 w-[9.5rem] justify-start gap-1.5 font-normal"
          >
            <Tag className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{label}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
            Show leads tagged with any of
          </DropdownMenuLabel>
          {tags.isLoading ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">Loading…</p>
          ) : active.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">
              No tags yet. A manager adds them in Settings.
            </p>
          ) : (
            active.map((t) => (
              <DropdownMenuItem
                key={t.id}
                role="menuitemcheckbox"
                aria-checked={selected.has(t.id)}
                // Keep the menu open so several tags can be picked in one go.
                onSelect={(e) => {
                  e.preventDefault();
                  toggle(t.id);
                }}
              >
                <span className="flex h-4 w-4 items-center justify-center">
                  {selected.has(t.id) ? <Check className="h-4 w-4" /> : null}
                </span>
                <span
                  aria-hidden="true"
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: t.colour ?? "var(--muted-foreground)" }}
                />
                <span className="truncate">{t.name}</span>
              </DropdownMenuItem>
            ))
          )}
          {hidden > 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              Also filtering by {hidden} retired tag{hidden === 1 ? "" : "s"}.
            </p>
          ) : null}
          {value.length ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => onChange([])}>Clear tags</DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
