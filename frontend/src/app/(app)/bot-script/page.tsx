"use client";

import { SectionHeader } from "@/components/section/section-header";
import { BotScriptConfig } from "@/components/crm/bot-script-config";
import { CampaignScriptsConfig } from "@/components/crm/campaign-scripts-config";
import { getNavItem } from "@/lib/navigation";

const nav = getNavItem("bot-script")!;

/**
 * What the bot says — CAMPAIGNS FIRST (client, 8 Oct).
 *
 * The page's primary content is the per-campaign conversation setup: an
 * enquiry arriving from a specific advertisement gets that campaign's exact
 * first reply, questions and brief, in free text with no menus. The per-step
 * wording editor below it governs the one flow that remains scripted — a
 * walk-in chat that arrived from no campaign at all.
 */
export default function BotScriptPage() {
  return (
    <div className="space-y-6">
      <SectionHeader title={nav.title} purpose={nav.purpose} />
      <CampaignScriptsConfig />
      <div>
        <h2 className="mb-1 font-display text-lg font-bold tracking-tight text-foreground">
          Walk-in chat (no campaign)
        </h2>
        <p className="mb-4 text-sm text-muted-foreground">
          A customer who messages without tapping any ad still gets the guided
          questions below, in your own words.
        </p>
        <BotScriptConfig />
      </div>
    </div>
  );
}
