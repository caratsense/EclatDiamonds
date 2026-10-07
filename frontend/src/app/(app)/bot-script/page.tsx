"use client";

import { SectionHeader } from "@/components/section/section-header";
import { BotScriptConfig } from "@/components/crm/bot-script-config";
import { getNavItem } from "@/lib/navigation";

const nav = getNavItem("bot-script")!;

/**
 * The customer bot's script, on its own page beside Conversations.
 *
 * Deliberately a light page: it mounts one component and fetches one endpoint.
 * Its previous home — a tab inside Business Configuration — loads the whole
 * industry-pack grid and six other tabs' worth of components before anything
 * here can be reached, which is why it was slow to arrive. Whoever is rewording
 * the bot should not pay for the rest of that screen.
 */
export default function BotScriptPage() {
  return (
    <div className="space-y-6">
      <SectionHeader title={nav.title} purpose={nav.purpose} />
      <BotScriptConfig />
    </div>
  );
}
