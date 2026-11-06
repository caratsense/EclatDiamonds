# Éclat WhatsApp — go-live checklist

> Everything still needed to get from "Meta setup done" to "a customer clicks an
> ad and the bot answers". Written 2026-09-18, after the Meta side was completed
> and outbound was proven on a live number.
>
> Three owners: **Shreyansh** (Railway + merge), **Sneha** (Meta + templates),
> **Ayushi** (approvals + ad changes).

---

## Where we actually are

**Working, verified against the live API:**

```
App           Eclat Diamonds CRM · 1074605415310032 · owned by Éclat, published
WABA          1615176156855467 · "Èclat diamonds and Company" · APPROVED
Number        +91 72080 17690 · id 1332571706604458
              CONNECTED · VERIFIED · CLOUD_API · quality UNKNOWN (clean)
Token         System User · expiry Never · valid
Webhook       configured, verify token accepted, `messages` subscribed
Subscription  app bound to the WABA (subscribed_apps confirms it)
Outbound      PROVEN — live text delivered to a real handset
```

**Not working:**

```
Inbound to CaratOS   Meta delivers; our backend 403s (wrong app secret on Railway)
The bot              does not exist. Every reply so far was typed by hand.
Ads → this number    every lead form still points at the old, broken number
Leads into the CRM   needs App Review for leads_retrieval — not submitted
```

**Parked:** `+91 70216 81648` is still registered to AiSensy's app. Meta returns
`(#10) Application does not have permission for this action`. Only AiSensy or
Meta support can release it.

---

## 1 · Railway variables — Shreyansh

Exact names, taken from the code (`whatsapp.service.ts`,
`whatsapp-credentials.service.ts`, `meta-webhook.service.ts`).

| Variable | Value | Why |
|---|---|---|
| `WHATSAPP_APP_SECRET` | **Éclat's app secret** | verifies `X-Hub-Signature-256`. **This is the one blocking inbound.** Replaces CaratSense's — our test WABA will stop verifying, which is expected |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | unchanged | already set and already accepted by Meta |
| `WHATSAPP_ACCESS_TOKEN` | Éclat's system-user token | the sender credential |
| `WHATSAPP_PHONE_NUMBER_ID` | `1332571706604458` | the API path segment, not the phone number |
| `WHATSAPP_PLATFORM_ORGANISATION_ID` | `org_eclat` | **required** — without it the token is set but no tenant uses it, and the service logs exactly that warning |
| `MESSAGING_RECIPIENT_ALLOWLIST` | **leave unset** | Considered and rejected 2026-09-18: it would block Shreyansh from testing, and the risk it guards against is small — the bot only replies to inbound messages, and seeded demo threads never produce one (`919000000101`–`104`, unallocatable). |

`META_APP_SECRET` and `META_WEBHOOK_VERIFY_TOKEN` stay as they are — Lead Ads
still runs through CaratSense's app.

### Platform path vs per-tenant

`docs/handovers/EXTERNAL-INTEGRATION-READINESS.md` says to leave the three
`WHATSAPP_*` sender variables unset for a per-tenant deployment. **For one
client, use them anyway.** The code sanctions it: the binding is explicit via
`WHATSAPP_PLATFORM_ORGANISATION_ID`, and the service's own comment distinguishes
that from the implicit "first organisation" fallback the architecture forbids.

Migrate to a per-tenant `Integration` + `IntegrationCredential` at client two.
`docs/handovers/PER-TENANT-APP-SECRET.md` has that spec.

### How to know it worked

```
POST /integrations/whatsapp/webhook   signed by Éclat's app
  before → 403 invalid signature
  after  → 200 {"handled":true,"organisationId":"org_eclat", ...}
```

---

## 2 · Code — what has to be built

### 2.1 `whatsapp.service.ts` — interactive messages

Today it sends `text` and `template` only. Ayushi's flow is entirely tappable
options, so it needs:

```ts
async sendButtons(orgId, to, body, buttons, route?)   // max 3, title <= 20 chars
async sendList(orgId, to, body, button, sections, route?)  // max 10 rows, title <= 24
```

Both go through the existing `send()` so credential resolution, routing,
`senderAssetId` and the no-op-with-reason behaviour are inherited unchanged.

**Interim:** the bot works today with numbered text menus over `sendText`. Ship
the flow first, layer interactive on top — it changes one function.

### 2.2 `whatsapp-bot/customer-flow.ts` — WRITTEN

Pure functions, same shape as `dsr-flow.ts`: step list, options, `parseChoice`,
`resolveNext`, `firstUnanswered`, `promptFor`, `greeting`, `closingFor`,
`handoffSummary`, `isStop`, `wantsHuman`.

### 2.3 `whatsapp-bot/customer-bot.service.ts` — TO BUILD

- session state per conversation, advancing one step per inbound message
- skips any step the lead form already answered
- two unreadable replies in a row → hand to a person, never a third re-ask
- on "call me now" → `handling: 'human'` + assign the branch manager, and post
  `handoffSummary()` into the thread so the manager sees the answers
- `STOP` honoured immediately and permanently

### 2.4 Wiring

Inbound → if the conversation is bot-handled and `handling !== 'human'`, advance
the flow. Reuse `ConversationAiGate`'s boundary rather than adding a second one.

### The empty-integration trap — hit on staging 2026-09-19, will hit production

Staging had an `Integration` row (`int_staging_whatsapp`, provider
`whatsapp_cloud`) with **no assets and no credential**, created by
`scripts/staging-bootstrap.mjs` so the admin screens have something to show.

That row silently disables the platform binding. `chooseAsset()` finds a
non-disabled WhatsApp integration with zero `phone_number` assets and returns a
hard **refusal** — not a fall-through:

```
A WhatsApp integration exists but no phone number has been registered against it.
```

A refusal never reaches step 2, so `WHATSAPP_ACCESS_TOKEN` and
`WHATSAPP_PHONE_NUMBER_ID` are never read. The symptom is the worst kind: the
bot runs perfectly, decides a correct reply, and the send is logged as
`[dry-run]`. Nothing errors.

**Check before go-live, on every environment:**

```
GET /integrations/whatsapp/sender     → must read  "usable": true
```

If it reads `usable: false` with the sentence above, delete the empty row:

```
DELETE /integrations-registry/<id>
```

Then re-check. No redeploy is needed — the sender is resolved per send.

Do **not** instead register the number as a tenant asset while the platform
binding is set: the API correctly refuses with *"That WhatsApp phone number ID
belongs to the platform sender."* The two paths are mutually exclusive; this
deployment has chosen the platform binding (§1 above).

Re-running `staging-bootstrap.mjs` recreates the row and breaks sending again.
Its upsert is `update: {}`, so deleting the row is durable until that script is
re-run.

### The bot's replies are not recorded in the thread

`whatsapp-bot.service.ts` calls `wa.sendText()` without persisting an outbound
`Message`. A manager opening a handed-off conversation sees only the customer's
side, and an empty outbound list is **not** evidence that a send failed. Worth
fixing before handover.

---

## 3 · Templates — Sneha

**The bot conversation needs NO templates.** The customer always messages first,
which opens the 24-hour window, and inside it free text, buttons and lists all
send with no review. This is worth telling Ayushi — she believed the questions
needed Meta approval. They do not.

Templates are needed only to **start** a conversation:

| Template | Category | When | Status |
|---|---|---|---|
| `eclat_followup_1week` | **Marketing** | 7 days after a lead goes quiet | to create |
| `eclat_followup_1month` | **Marketing** | 30 days | to create |
| `eclat_dsr_reminder` | Utility | daily store report | later, DSR bot |

### Where

**WhatsApp Manager → WABA `1615176156855467` → Message templates → Create.**

It must be that WABA. Templates are per-WABA and do not transfer — the 19
approved templates on the old number are **not** reusable here.

### Rules that cause rejections

- Name: lowercase, digits, underscores. **Cannot be renamed** after creation.
- Language: `en` and `en_US` are different templates. If code sends `en` and the
  template was approved as `en_US`, every send fails `132001` and the dashboard
  looks fine.
- Variables are positional `{{1}}`, `{{2}}`, need sample values, and cannot sit
  adjacent to each other or at the very start or end of the body.
- Marketing templates are billed per message and rejected more often than
  utility ones.

### Cost, before anyone commits to it

At ~2,400 leads a month, two follow-ups each is roughly **4,800 paid marketing
messages a month**. Service conversations — a customer messaging first — include
**1,000 free per month**, but follow-ups are business-initiated and none of them
are free. Worth a decision: everyone, or only qualified leads?

### Approval order

Draft copy → **Ayushi approves the wording** → submit to Meta → Meta approves.
Two approvals, and the copy freezes at the second. Draft copy is in
`docs/WHATSAPP-BOT-SCRIPT-DRAFT.md`.

---

## 4 · Ads — Sneha + Ayushi

**Do not touch the 497 live campaigns yet.**

### 4.1 One demo ad first

- A new lead form, copying the live 7-slide structure, with its
  `Message … on WhatsApp` option pointing at **`+91 72080 17690`**
- Minimum budget, narrowest audience, named unmistakably
  (`ZZ DEMO — do not touch`)
- Pause it the moment the test passes

### 4.2 What the demo proves

```
ad click → form → "Chat on WhatsApp" → message lands on the new number
        → Meta webhook → CaratOS → bot replies → handoff to a branch manager
```

And it settles the one open design question: whether a **lead form's** WhatsApp
handoff carries the `referral` object with the ad id, the way a click-to-WhatsApp
ad does. `integrations/meta-referral.ts` already parses it if present. If it is
absent, the fallback is the `leadgen` webhook, which carries phone, form id and
ad id at submission — so the branch is known before the customer messages.

### 4.3 Only then, the live campaigns

They run a separate campaign per city — Bandra, Bandra Broadway, Delhi Rohini,
Delhi Paschim Vihar, Udaipur. Repointing means editing each form's WhatsApp
option to the new number.

Two client decisions to settle first:

- **Form A** (Bandra, Bandra Broadway, Kala Ghoda, Udaipur) ends at `Call now`
  and has **no WhatsApp option at all** — roughly 1,600 of the ~2,400 monthly
  leads cannot reach a bot. Adding it is a form edit on their side.
- **Routing:** each campaign's ad id maps to a store via ad-set routing rules,
  which feeds `Conversation.storeId` and therefore which manager gets the
  handoff.

---

## 5 · Order of work

| # | Task | Owner | Blocks |
|---|---|---|---|
| 1 | Railway variables | **Shreyansh** | everything inbound |
| 2 | Customer bot + interactive messages | **Shreyansh / Sneha** | the bot replying |
| 3 | Approve bot copy | **Ayushi** | building step 2 to final wording |
| 4 | Follow-up templates → Ayushi → Meta | **Sneha** | follow-ups only |
| 5 | Demo ad + demo form on the new number | **Sneha + Ayushi** | end-to-end proof |
| 6 | App Review — `leads_retrieval` and five others | **Sneha** | leads into the CRM |
| 7 | Repoint live forms | **Ayushi** | production traffic |
| 8 | Messaging routes: number → branch | **Sneha** | multi-number sending |

Steps 1 and 6 can start immediately and independently. Step 6 is days of Meta's
time, so start it regardless of everything else.

---

## 5a · Éclat's portfolio enforces two-person approval

Discovered 2026-09-20 01:42 IST, mid-rotation. Generating a system-user token on
portfolio `920334109418825` returns:

> *Approval needed — we need someone else from this business to approve this
> request. We've already notified someone from your business.*

This is not a misconfiguration and there is no way around it from our side. It
governs **every** credential operation on this portfolio, so plan for it:

- A token can never be rotated by one person. Always budget a second admin's
  availability into the change window.
- Nothing breaks while a request is pending. The OLD token stays valid, so
  WhatsApp keeps sending — the request gates the new token, not the old one.
- `GET /{business_id}/business_users` returns an empty list to a system-user
  token, so the approvers cannot be listed by API. Read them from
  Business Settings → People, filtered to Admin.

### Consequences still open because of it

- **`ads_read` is not on the token.** The Marketing API use cases WERE added to
  the app successfully (Create/Measure/Ad-leads, with the WhatsApp use case
  intact), so the permission will appear in the dropdown once a token can
  actually be generated. Until then, read ad ids and the shareable preview link
  from the Ads Manager UI rather than by API.
- **The exposed token is still live.** Rotation is the real reason this matters;
  it cannot complete until the request is approved.

### Also confirmed by API, same session

```
Èclat diamonds and Company · 920334109418825
verification_status : not_verified     <- caps messaging at 250 unique/24h
two_factor_type     : none
```

Business verification (§6 below / phase 6) is therefore still genuinely
outstanding, not merely undocumented.

---

## 6 · Open items

- **AiSensy** releasing `+91 70216 81648`, or a Meta support ticket for it
- **Éclat's privacy policy URL** content confirmed — `eclatdiamonds.in/privacy-policy`
  returns 200 but is JS-rendered and unverified
- **The SIM for `+91 72080 17690` must stay active.** Re-verification arrives by
  SMS, and an expired verification with no reachable SIM is exactly what made the
  old number unusable
- **Rotate the CaratSense system-user token** — exposed in a session transcript
- **Seven ring URLs, per-city store links, showroom hours** — still needed from
  Ayushi before the bot copy is final
