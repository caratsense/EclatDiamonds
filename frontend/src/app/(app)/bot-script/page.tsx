"use client";

import { SectionHeader } from "@/components/section/section-header";
import {
  CampaignScriptsConfig,
  WalkInConversationConfig,
} from "@/components/crm/campaign-scripts-config";
import { getNavItem } from "@/lib/navigation";

const nav = getNavItem("bot-script")!;

/**
 * What the bot says — ONE screen, free text everywhere (client, 12 Oct).
 *
 * Campaigns first: an enquiry arriving from a specific advertisement gets that
 * campaign's exact first reply, questions and brief. Below it, the walk-in
 * conversation covers the customer who arrived from no ad at all — the same
 * form minus the matching. The old per-step wording editor (buttons and fixed
 * answers) is gone from this screen: switching the walk-in conversation OFF is
 * what keeps that legacy questionnaire running.
 */
export default function BotScriptPage() {
  return (
    <div className="space-y-6">
      <SectionHeader title={nav.title} purpose={nav.purpose} />
      <CampaignScriptsConfig />
      <WalkInConversationConfig />
    </div>
  );
}
