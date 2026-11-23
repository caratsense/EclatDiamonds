"use client";

import { Megaphone } from "lucide-react";

import type { Campaign } from "@/lib/queries/campaigns";

/**
 * "Was this person sent a broadcast, and if so which one."
 *
 * ## Two controls, because it is two questions
 *
 * The first version of this was one flat menu: "All conversations",
 * "Broadcasts — any", then every campaign by name. A reader could not tell from
 * it that the campaign names were a narrowing of the entry above them rather
 * than three unrelated ways to filter, and a tenant with a dozen campaigns had
 * a dozen options competing with the two that are not campaigns at all.
 *
 * So the category comes first and the chooser appears UNDER it, only once
 * Broadcasts is the category. The relationship is then in the shape of the
 * control rather than in the reader's head.
 *
 * ## One URL parameter, not two
 *
 * `""` is off, `"any"` is every broadcast and anything else is one campaign's
 * id — so the category is derivable and there is no second parameter that can
 * contradict the first (category "all" with a campaign still selected). It also
 * keeps the link shareable: a manager sends somebody "the people who got the
 * nails invitation" rather than a description of which menus to click.
 */
export function BroadcastFilter({
  value,
  campaigns,
  onChange,
}: {
  /** `""` | `"any"` | a campaign id. */
  value: string;
  /** Every campaign the caller could load; filtered to the sent ones here. */
  campaigns: Campaign[];
  onChange: (next: string) => void;
}) {
  const sent = campaigns.filter((c) => isSentBroadcast(c.status));
  const on = value !== "";

  return (
    <div className="flex items-center gap-1.5">
      <Megaphone
        className={`h-3.5 w-3.5 ${on ? "text-[#128C7E] dark:text-[#25D366]" : "text-muted-foreground"}`}
      />
      <select
        aria-label="Show only the customers a broadcast was sent to"
        value={on ? "broadcast" : ""}
        onChange={(e) => onChange(e.target.value === "broadcast" ? "any" : "")}
        className={`h-8 rounded-md border bg-background px-2 text-xs font-medium ${
          on
            ? "border-[#25D366]/40 text-[#128C7E] dark:text-[#25D366]"
            : "border-border text-muted-foreground"
        }`}
      >
        <option value="">All conversations</option>
        <option value="broadcast">Broadcasts</option>
      </select>

      {/*
        Only once Broadcasts is the category, and visibly subordinate to it —
        the arrow says the two belong together.

        An empty list is explained rather than hidden. Reading campaigns is
        manager-level (`GET /campaigns` is `@Roles('store_manager')`), so a
        salesperson gets nothing here and would otherwise be left wondering
        which of the two controls was broken. "Any broadcast" still works for
        them, because the inbox query does not need the campaign list.
      */}
      {on && (
        <>
          <span aria-hidden className="text-muted-foreground/50 text-xs">
            ↳
          </span>
          <select
            aria-label="Which broadcast"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="h-8 max-w-[14rem] rounded-md border border-[#25D366]/40 bg-background px-2 text-xs font-medium text-[#128C7E] dark:text-[#25D366]"
          >
            <option value="any">Any broadcast</option>
            {sent.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            {/*
              The selected campaign is no longer on the list — it was cancelled,
              or somebody was sent a link to one they cannot read. Kept as an
              option so the control shows what the inbox is actually filtered
              to instead of silently snapping back to "Any broadcast".
            */}
            {value !== "any" && !sent.some((c) => c.id === value) && (
              <option value={value}>This broadcast</option>
            )}
          </select>
        </>
      )}
    </div>
  );
}

/**
 * Has this campaign actually reached anybody?
 *
 * Only these three, and the list is written against the real
 * `MessagingCampaignStatus` enum rather than from memory. The version this
 * replaces asked for `["sending", "sent", "partially_failed", "finished"]` —
 * and `sent` and `finished` are not statuses this product has ever had, while
 * `completed`, the one that every finished broadcast ends up in, was missing.
 * So the chooser offered nothing but a campaign that happened to be mid-flight
 * at that second: the nails invitation had gone to 203 people and could not be
 * picked, which is half of why the filter was reported as doing nothing.
 *
 * A draft, an unapproved one or a cancelled one has reached nobody, so offering
 * it could only ever produce an empty inbox and the question of whether the
 * filter is broken. `queued` and `expanding` are excluded for the same reason —
 * the recipients are being worked out, nothing has been delivered yet.
 */
export function isSentBroadcast(status: string): boolean {
  return status === "sending" || status === "completed" || status === "partially_failed";
}
