# Competitor CRM meeting review and two-day enhancement scope

**Reviewed:** 2026-09-07  
**Inputs:** 40:18 meeting summary supplied by the product owner; original scope in `MODULES.md`; CaratOS pivot in `CARATOS_ARCHITECTURE.md`; current repository implementation.  
**Evidence caveat:** no audio/video or verbatim transcript was supplied. Speaker attribution and timestamps below reproduce the supplied meeting notes and should not be presented as verbatim minutes.

## Executive conclusion

The meeting describes a competing omnichannel CRM and its commercial model, not one isolated feature. Most concepts overlap the SOW, but several claims are broader than what CaratOS currently delivers end to end.

The highest-value two-day enhancement is **ad-set-level routing and AI/human control**. The client explicitly raised multi-city routing and franchise campaigns, and CaratOS already has the tenant, store, inbox, attribution and qualification foundations. The repository now contains the first internal slice: tenant-owned prioritized rules, head-office configuration UI, server-side enforcement during inbound ingestion, store/user assignment, AI/human handling, audit logging and rule-resolution tests.

This is not yet a live Meta integration. Meta account access, webhook samples and permission approval are external prerequisites. Until a provider adapter supplies normalized ad-set metadata, the routing engine is ready but cannot derive an ad set from ordinary WhatsApp text alone.

## Who discussed what across the 40 minutes

| Approx. time | Speaker | Discussion and decision signal |
|---|---|---|
| 00:00–03:00 | Presenter | Positioned the product as an omnichannel CRM joining online and offline sources. Listed intent scoring, assignment, segmentation, campaigns, loyalty, reviews and ROAS. |
| 00:00–03:00 | Client | Confirmed multiple product, inquiry and form-ad formats and asked to skip introductions for a live workflow. Demo evidence mattered more than a capability list. |
| 03:00–08:00 | Presenter | Sent a Click-to-WhatsApp demo for fictitious “Tara Jewels” and explained that clicking an ad creates a CRM lead. |
| 03:00–08:00 | Client | Opened the sandbox and asked where multi-question Meta lead-form answers appear. |
| 08:00–13:00 | Presenter | Showed fields mapped into a customer/lead view and an AI conversation associated with its originating ad. Explained dynamic scoring and human takeover. |
| 08:00–13:00 | Client | Challenged the score: deliberately negative answers still produced 65/100. Explainability and calibration must therefore be acceptance criteria. |
| 13:00–17:00 | Presenter | Said the label reflected sandbox configuration; described overnight AI handling and next-morning human queues. |
| 13:00–20:00 | Client | Described multiple cities, store-specific numbers and localized Hyderabad ads. Asked how a central account routes to the correct store manager and required AI off for franchise enquiries. |
| 13:00–20:00 | Presenter | Proposed ad-set-name/tag rules, regional routing and an AI toggle per ad set. This is the clearest new enhancement requirement. |
| 20:00–25:00 | Client | Asked how implementation works and how data volume affects setup/pricing. |
| 20:00–25:00 | Presenter | Described 1–3 months of guided onboarding, historical Excel imports, returning-lead recognition and lead aging. |
| 25:00–32:00 | Client | Asked how digital prospects later entering a showroom are recognized and whether visits need manual entry. |
| 25:00–32:00 | Presenter | Demonstrated phone lookup of prior ads/enquiries, task history, third-party IVR calls/recordings, and barcode/QR capture of products viewed or abandoned. |
| 30:00–33:00 | Client | Asked whether compulsory fields can be changed or removed by their team. |
| 30:00–33:00 | Presenter | Confirmed user-configurable layouts and training during onboarding. |
| 33:00–40:18 | Client | Shared scale (15k–20k customers, eight active and three planned stores), requested monthly billing/trial, and recalled a lower exhibition quote. |
| 33:00–40:18 | Presenter | Quoted ₹50,000/month billed annually up front to 100,000 records with unlimited users; declined monthly/trial; distinguished a 15-user exhibition tier; quoted optional implementation at ₹50,000/month. These are commercial policies, not code requirements. |

## SOW and implementation comparison

| Competitor capability | SOW / CaratOS fit | Current evidence | Verdict |
|---|---|---|---|
| Unified online/offline CRM | Modules 1 and 7; CaratOS CRM spine | Identity, inbox, leads, check-ins, Customer 360 | **Built foundation; only WhatsApp connected inbound** |
| All-source lead ingestion | Module 1 channels and connector framework | Provider-neutral integration/import contracts | **Partial** — no live Meta Lead Ads/RCS/IVR adapters |
| CTWA lead creation | WhatsApp is an explicit channel | Referral parsed from the stored provider payload; routes, opens a Lead when a store is known, writes measured attribution | **Connected (fixture-tested)** — needs a live Meta ad + app review to prove delivery |
| Meta form answer mapping | Compatible with custom lead fields/imports | Custom attributes and CSV/XLSX import | **Gap** — no Meta form adapter |
| AI customer conversation | Beyond original CRM wording | Existing AI extracts qualification signals; it does not autonomously converse/send | **Gap; do not market as built** |
| Intent score / next action | Enhancement to Module 1 | Explainable policy, score, evidence, confidence, bands and next action | **Built**, but not triggered after every inbound message |
| AI toggle per ad set | New competitor-driven control | Per-rule `ai`/`human` enforced during ingestion; human-only never auto-replies | **Working end to end by `ad_id`**; ad-set matching still needs Marketing API |
| Store assignment from ad set | Fits multi-store SOW; matching rule is new | Rule sets `Conversation.storeId`/assignee; unmatched stays unassigned, no store guessed | **Working end to end by `ad_id`** |
| AI segmentation | Module 1/17 overlap | Loyalty and history exist; automatic segment engine does not | **Gap** |
| Returning lead / lead aging | Module 1 history/follow-up overlap | Identity matching, timeline and follow-ups | **Partial** — no dedicated aging/cohort report |
| Customizable/required forms | CaratOS custom attributes | Attribute definitions and admin UI | **Partial** — not a full form-layout builder |
| Historical Excel import | Data migration/connector scope | CSV/XLSX mapping, preview and import | **Built** |
| Mobile showroom lookup | Modules 1/7 and PWA direction | Phone lookup, Customer 360 and responsive UI | **Built as web/PWA**, not native |
| Barcode/QR interest | Modules 5/7 overlap | Scanner input resolves product and stores ProductInteraction | **Built for keyboard/Bluetooth scanner**; camera QR needs device work |
| IVR and recordings | Phone is a channel; vendor not specified | Call notes only | **Gap plus vendor/consent dependency** |
| RCS/WhatsApp/email/SMS campaigns | Module 16 | Campaign planning; WhatsApp outbound with credentials | **Partial** — no RCS or unified send orchestration |
| Digital loyalty | Module 17 | Plans, members, referrals, wallets and payouts | **Built core**; web redemption unproven |
| Ratings / Google Reviews | Not explicit | No production aggregation found | **New gap** |
| ROAS including walk-ins | Module 16 plus attribution | Separate measured/declared attribution and campaign ROAS | **Partial** — spend/click ingestion and walk-in window needed |
| Volume pricing, billing, no trial, guided implementation | Commercial packaging | Not runtime functionality | **Business decisions requiring an SOW amendment** |

## Two-day delivery boundary

### Day 1 — completed internal slice

- Prioritized rules matching exact ad-set ID, ad-set-name text, or tags.
- Destination store/organisation queue, optional assignee, and `AI first`/`Human only`.
- Head-office-only API, tenant validation, audit entry and configuration screen.
- Rule application inside channel-neutral inbound conversation ingestion.
- Explicit handoff reason; unmatched traffic stays unassigned.

### Day 2 — DELIVERED 2026-09-07 (except where noted)

- **DONE** — Meta CTWA referral mapped into a normalized routing context.
  `integration/contracts/ad-referral.ts` (neutral) + `integrations/meta-referral.ts`
  (adapter) + wiring through `whatsapp-bot.service.ts`. The referral was already being
  stored verbatim in `WhatsAppEvent.payload`; nothing read it. The engine could not fire
  in production before this — no caller supplied a routing context.
- **DONE** — measured `AttributionTouch` with the opaque ad and click ids,
  `evidence: 'measured'`, kept separate from the salesperson's declared source.
- **CORRECTED SCOPE** — campaign and ad-set ids are **not** available from CTWA. Meta
  sends only `source_id` (the AD id). The routing engine gained an `ad_id` match field so
  a tenant can route by ad id today with no app review; `ad_set_id`/`ad_set_name` remain
  and never match until a Marketing API adapter supplies them. Deriving an ad set from the
  ad headline was rejected as fabricated attribution.
- **DONE** — a Lead is opened on an ad click, but **only when a matched rule supplied a
  real store**. `Lead.storeId` is non-nullable and a store is never guessed, so unmatched
  ad traffic stays a visible unassigned conversation with its `sourceAdId` preserved.
- **NOT DONE** — qualification is not yet re-triggered after each inbound message for
  `ai` threads. Deferred: it belongs with the conversational-agent work, which is gated on
  an approved provider and a tenant feature flag.
- **PARTIAL** — the configuration screen states which match fields work today and why;
  inbox badges for matched rule and source ad are not yet rendered (the data is on the
  `Conversation` row: `sourceAdId`, `matchedRuleId`).
- **DONE** — migration `20260907120000_crm_ad_referral_routing` rehearsed zero-to-current
  on a disposable database; full backend suite green.

**Tested with a sanitized fixture of the documented CTWA payload shape, not with live
Meta traffic.** Parsing, routing, tenancy and attribution are proven; delivery from Meta
is not.

### Not honest to promise inside two days

- Production conversational AI with safe generation, opt-outs, WhatsApp compliance and delivery monitoring.
- Full Meta Lead Ads setup without app review, tokens, ad/form access and real payloads.
- IVR recordings without vendor credentials, retention and consent/legal review.
- RCS plus every outbound channel.
- Automated segmentation and complete Google Reviews aggregation.

## Acceptance evidence

1. Hyderabad retail routes to Hyderabad and remains `AI first`.
2. Franchise traffic routes to the designated human queue with AI disabled.
3. A higher-priority tag rule wins over a broad location-name rule.
4. Unknown traffic remains visible and unassigned.
5. A tenant cannot select another tenant’s store or employee.
6. Webhook replay does not duplicate messages or leads.
7. Source campaign/ad-set/ad identifiers remain measured attribution, separate from declared source.
8. Negative conversation text does not receive an unjustified score; signals and policy version explain it.

## Inputs needed

- Approve CaratOS pricing, user limits, billing, trial and implementation policy separately.
- Provide Meta access or sanitized CTWA and Lead Ads webhook examples.
- Provide the first routing table: match → store → owner/team → AI/human.
- Confirm whether “AI off” means named-person assignment or regional queue.
- Define store-sale ROAS: attribution window, returns/cancellations and treatment of declared attribution.
