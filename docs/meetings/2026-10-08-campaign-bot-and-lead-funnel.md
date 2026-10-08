# Campaign-scripted bot + lead funnel on Today — 8 October 2026, action items

Client feedback after seeing the Bot Script page: the per-question wording
editor is **not** what was asked for. The ask is campaign-based conversation
setup (AiSensy-style), plus a lead funnel view on the Today dashboard.
Delivery rule from the client: **raise a PR, do not merge.**

---

## A. Campaign-based bot conversations

**The ask, in the client's terms.**

1. **Campaign setup in the dashboard.** An authorised admin/staff member
   creates a campaign entry: name, campaign/ad link or reference, the response
   the bot sends when a customer arrives from that campaign, any question the
   bot should ask, and relevant follow-up responses / product info / pricing /
   links. Each campaign has its own editable configuration.
2. **Match incoming WhatsApp enquiries to the campaign.** Ad → customer's
   WhatsApp enquiry → that campaign's configured response. Pasting a campaign
   link must *connect to routing*, not sit in a text field.
3. **Per-campaign conversation.** The client decides what the bot first
   replies, what it asks, what it provides. Example: a ring ad with a "Know
   the price" CTA → the bot recognises that ring's campaign and sends its
   configured pricing response, then that campaign's follow-up question.
4. **Natural and open-ended.** **No predefined answer options, numbered menus
   or "choose one" buttons.** Customers type freely; the bot understands and
   answers from the campaign's configured content. Configured questions guide,
   they do not force a questionnaire; if the customer already answered or asks
   something else, the bot responds accordingly.
5. **Proof.** At least two campaigns with different initial responses and
   follow-up questions, each receiving its own conversation.

**What the repo survey found (and why the plan is what it is).**

- Referral → rule matching **already existed**: `AdSetAutomationRule` (settings
  JSON, `crm/adset-rules.service.ts`), matched in `ingestInbound`, with the
  winning rule stored on `Conversation.matchedRuleId`. The "Ad routing" tab
  even offered "AI first" with per-ad prompt boxes (`aiContext`,
  `aiGuardrails`).
- But the prompts were **dead data**: `ingestInbound` discarded them, the AI
  responder was unreachable from inbound WhatsApp (`claimBotTurn` returns true
  for every non-human thread, so the gate's only call site could never fire),
  and `handling='ai'` actually delivered the **button questionnaire** — the
  exact thing the client is rejecting.
- So the campaign entity is the ad rule, extended — not a new table, no
  migration, and the "campaign that routes an enquiry" is by construction the
  "campaign whose script answers it".

**What was built.**

| # | Change | Where |
|---|--------|-------|
| A1 | Rule gains `adLink`, `firstReply`, `questions[]` (validated, capped); a pasted ad link with no typed match **becomes** the exact `ad_id` match (`adIdFromLink`, server AND editor) | `crm/adset-rules.service.ts` |
| A2 | `CampaignBotService`: `scriptFor()` (is this thread campaign-scripted) + `handle()` (opener verbatim on arrival; free-text turns answered by the model from the campaign brief; deterministic handoffs for "talk to a person", screened content, unconfigured/unconfident model) | `whatsapp-bot/campaign-bot.service.ts` (new) |
| A3 | The inbound fork: campaign-scripted threads go to the campaign conversation and never see the questionnaire; everything else unchanged | `whatsapp-bot.service.ts` |
| A4 | `AiReplyContext` gains `campaign` + `historyText`; a dedicated `campaignSystemPrompt` (answers only from the brief, **never menus/numbered options**, guides toward unanswered questions one at a time); `CAMPAIGN_SEND_MIN_CONFIDENCE` between draft and auto-send floors | `crm/ai-responder.ts`, `crm/ai/policy.ts`, `crm/ai/provider-ai-responder.ts` |
| A5 | Replies recorded honestly: the owner's verbatim opener as `bot`, generated turns as `ai` | `recordBotReply` |
| A6 | Bot Scripts page reworked: **campaign conversations first** (list + add/edit dialog: name, ad link with live "Connected: ad …" parse feedback, match, store, first reply, up to 3 questions, brief, house rules, On/Off); the old wording editor demoted to "Walk-in chat (no campaign)" below | `bot-script/page.tsx`, `crm/campaign-scripts-config.tsx` (new) |
| A7 | Proof: `campaign-bot.e2e-spec.ts` — two campaigns with different openers/questions each answered from their own config; link-parse round-trip; brief/guardrails/history reach the model; low-confidence, wants-human, unconfigured and screened turns hand off; routing-only/disabled/human threads report no script | `test/campaign-bot.e2e-spec.ts` (11 tests) |

**Still true after this change.** Organic traffic and routing-only rules keep
the existing scripted flow; `handling='human'` still silences every bot; the
opt-out check still runs before anything speaks; media still goes to a person;
a campaign's conversation needs a configured AI provider (`CRM_AI_PROVIDER`,
`CRM_AI_MODEL`, `CRM_AI_API_KEY`) for follow-up turns — without one the opener
still sends and follow-ups hand to a person with the campaign named.

## B. Lead funnel on the Today dashboard

**The ask.** How many leads came and how many converted — per day, pie-chart
sort of format, on the existing dashboard.

**Survey.** No per-day lead series existed anywhere; the only conversion count
was a 90-day scalar in the omnichannel funnel. "Converted" is well-defined in
the model: `Lead.outcome = 'won'`, stamped with `closedAt` when a lead reaches
`order_placed`.

**What was built.**

- `GET /dashboard/charts` now returns `leadFunnel`: period totals (came =
  created in window, converted = closed won in window) plus a per-day strip of
  at least the last 7 days, bucketed on store-local days, store-scoped like
  every other dashboard number.
- `LeadFunnelChart` on the dashboard, under the sales charts: a donut of the
  period's split (conversion % as the centre figure) beside a per-day
  came-vs-converted bar strip. Uses the app's existing ECharts presets and
  chart tokens (series colours `--chart-1` indigo / `--chart-5` emerald —
  validated for CVD separation and normal-vision distance in both themes;
  values are direct-labelled in tooltips and the card header, as the light-mode
  contrast check requires). Reacts to the dashboard's own period buttons.

---

## Verify

- Backend: `campaign-bot` 11/11; `ctwa-routing`, `whatsapp-bot`, `ai-auto-reply`,
  `qualification-bot-vocabulary`, `bot-script` green; `tsc` clean.
- Frontend: `tsc`, ESLint, vitest green; production `next build` green.
- Manual: two campaigns configured on the Bot Scripts page; `/dashboards`
  shows the funnel card.

## Parked / explicitly out of scope here

- True NLU beyond the campaign brief (A3 premium path) — the campaign
  conversation is grounded in the owner's brief by design.
- A separate quotation-number decision — client is checking with Ayushi.
- `MarketingCampaign` (budget/spend planning) stays a separate concept; if the
  client later wants spend-vs-leads in one view, join on
  `externalCampaignId` ↔ `Conversation.sourceCampaignId`.
