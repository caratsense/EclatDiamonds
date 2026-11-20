"use client";

import Link from "next/link";
import { useState } from "react";
import { Check, ChevronDown, MessageCircle, ShieldAlert } from "lucide-react";

import { useProviderCatalogue } from "@/lib/queries/tenant-config";

/**
 * Which channels this inbox can actually deliver on.
 *
 * The point of this strip is to stop the inbox implying more than is true. A
 * thread can arrive and be replied to for any channel; whether that reply can
 * LEAVE the building depends on a connected provider, and the two are easy to
 * confuse when the compose box looks identical either way.
 *
 * ## Why it collapses
 *
 * It used to print every provider in the catalogue as an equal-weight chip —
 * seven of them, five reading "Not connected". That inverted the signal: the
 * one channel a manager actually works in was the same size as six they have
 * never used, and the row was the noisiest thing on a screen whose job is to
 * show conversations.
 *
 * Connected channels are named, because those are the ones that can carry a
 * reply. The rest collapse to a single count that opens on demand — still one
 * click from the truth, no longer competing with the inbox for attention.
 *
 * `platform_env` is still called out specifically. It means the credential
 * belongs to the platform rather than to this organisation — workable for a
 * single tenant, and exactly the thing that must change before a second one
 * shares the same number. Saying "connected" alone would hide that.
 */
export function ChannelStatus() {
  const { data } = useProviderCatalogue();
  const [showAll, setShowAll] = useState(false);

  const channels = data?.providers.filter((p) => p.category === "messaging") ?? [];
  if (channels.length === 0) return null;

  const live = channels.filter((c) => c.available);
  const idle = channels.filter((c) => !c.available);

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {live.map((c) => {
        const tenantOwned = c.credentialScope === "tenant";
        return (
          <span
            key={c.code}
            className="inline-flex items-center gap-1.5 rounded-full border border-[#25D366]/30 bg-[#25D366]/10 px-2.5 py-1"
            title={c.blockedReason ?? c.description}
          >
            <MessageCircle className="h-3 w-3 text-[#128C7E] dark:text-[#25D366]" />
            <span className="font-medium">{c.name}</span>
            {tenantOwned ? (
              <Check className="h-3 w-3 text-emerald-600" />
            ) : (
              /* Shared credential: workable for one tenant, wrong for two. */
              <ShieldAlert className="h-3 w-3 text-amber-500" />
            )}
          </span>
        );
      })}

      {live.length === 0 && (
        <span className="text-muted-foreground">
          No channel can send yet.
        </span>
      )}

      {idle.length > 0 && !showAll && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/30 px-2.5 py-1 text-muted-foreground hover:text-foreground"
        >
          {idle.length} not connected
          <ChevronDown className="h-3 w-3" />
        </button>
      )}

      {showAll &&
        idle.map((c) => (
          <span
            key={c.code}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-muted-foreground"
            title={c.blockedReason ?? c.description}
          >
            <MessageCircle className="h-3 w-3" />
            <span>{c.name}</span>
          </span>
        ))}

      <Link
        href="/settings/integrations"
        className="text-muted-foreground underline underline-offset-2"
      >
        Manage
      </Link>
    </div>
  );
}
