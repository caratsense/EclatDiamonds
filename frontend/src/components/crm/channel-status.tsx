"use client";

import Link from "next/link";
import { Check, MessageCircle, ShieldAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { useProviderCatalogue } from "@/lib/queries/tenant-config";

/**
 * Which channels this inbox can actually deliver on.
 *
 * The point of this strip is to stop the inbox implying more than is true. A
 * thread can arrive and be replied to for any channel; whether that reply can
 * LEAVE the building depends on a connected provider, and the two are easy to
 * confuse when the compose box looks identical either way.
 *
 * `platform_env` is called out specifically. It means the credential belongs to
 * the platform rather than to this organisation — workable for a single tenant,
 * and exactly the thing that must change before a second one shares the same
 * number. Saying "connected" alone would hide that.
 */
export function ChannelStatus() {
  const { data } = useProviderCatalogue();
  const channels = data?.providers.filter((p) => p.category === "messaging") ?? [];
  if (channels.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">Channels:</span>
      {channels.map((c) => {
        const tenantOwned = c.credentialScope === "tenant";
        return (
          <span
            key={c.code}
            className="inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1"
            title={c.blockedReason ?? c.description}
          >
            <MessageCircle className="h-3 w-3 text-muted-foreground" />
            <span className="font-medium">{c.name}</span>
            {!c.available ? (
              <Badge variant="outline" className="h-4 px-1.5 text-[10px] font-normal">
                Not connected
              </Badge>
            ) : tenantOwned ? (
              <Check className="h-3 w-3 text-emerald-600" />
            ) : (
              <Badge
                variant="outline"
                className="h-4 gap-1 border-amber-500/50 px-1.5 text-[10px] font-normal text-amber-600"
              >
                <ShieldAlert className="h-2.5 w-2.5" />
                Shared credential
              </Badge>
            )}
          </span>
        );
      })}
      <Link
        href="/settings/integrations"
        className="text-muted-foreground underline underline-offset-2"
      >
        Manage
      </Link>
    </div>
  );
}
