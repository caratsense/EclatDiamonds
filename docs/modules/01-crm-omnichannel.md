# Module 1 — Omnichannel CRM (lead capture, conversation trail, assignment)

> **Status: DESIGN ONLY. Nothing in this document is implemented.**
> Written 2026-09-08 against `main` @ `9589ac5`. Extends the existing CRM module
> rather than replacing it.
> Purpose: agree the shape before any code is written. Review, mark up, then build.

## 1. What the client asked for

Éclat want a CRM where they can:

1. **Capture leads from every channel** — Instagram, Facebook, WhatsApp, website —
   into one place, without anyone retyping them.
2. **See the full conversation trail** for each lead — the actual messages, not a
   summary someone typed afterwards.
3. **See leads convert** — movement through the pipeline, and what was won or lost.
4. **Hand a lead to a human.** After the bot/automation has interacted, a specific
   lead gets assigned to a specific person, who then owns it.

Reference point given by the client: the Zithara-style unified lead platform.

**Restated as the four capabilities this document designs:**

| # | Capability | One-line definition |
|---|---|---|
| C1 | Channel ingestion | An inbound event on any channel becomes a Lead automatically |
| C2 | Conversation trail | Every message in and out, stored against the lead, in order |
| C3 | Pipeline and conversion | Stage movement and won/lost outcome, reportable |
| C4 | Bot-to-human handoff | Automation stops, a named human takes over, and that is visible |

## 2. What already exists

More than you would expect. Verified against the codebase, not assumed.

### Already built and reusable

| Thing | Where | Note |
|---|---|---|
| `Lead` model | `backend/prisma/schema.prisma` | ref, storeId, customerName, phone, value, source, stage, interest, address, birthday, anniversary |
| **Lead assignment** | `Lead.ownerId` to `owner User?` | C4's storage layer already exists |
| **Conversion tracking** | `Lead.outcome` (`open`/`won`/`lost`), `lostReason`, `closedAt` | C3 partly exists |
| Pipeline stages | `enum LeadStage` — `inquiry`, `quotation`, `order_placed` | Only 3 stages |
| Activity notes | `LeadNote` — `kind`: `note`/`call`/`visit`/`whatsapp` | Manual entries, not messages |
| Follow-up reminders | `LeadFollowUp` — auto FU1 +7d, FU2 +30d | Built 2026-07-06 |
| Source vocabulary | `enum LeadSource` — `walk_in`, `phone`, `whatsapp`, `website`, `instagram`, `referral` | **Values exist; nothing populates them automatically** |
| Store scoping and RBAC | `StoreScopeService` | Reuse wholesale. Do not write new auth |
| Notifications | `NotificationsService` | Dedupe keys, HO fan-out |
| WhatsApp transport | `integrations/whatsapp.service.ts` | `sendText`, `sendTemplate`, webhook + HMAC. ⚠️ **Single-tenant** — reads one `WHATSAPP_PHONE_NUMBER_ID` from env. See §5a |
| Inbound message log | `WhatsAppEvent` (on `feat/whatsapp-bot`, PR #2) | Raw payload, `wamid` idempotency, retry/status |

### The honest gap

- **No Facebook, Instagram, Messenger or Lead Ads code exists anywhere.** The only
  Meta integration in the backend is `whatsapp.service.ts`. `LeadSource.instagram`
  is a dropdown value a salesperson picks by hand.
- `WhatsAppEvent` is **staff-oriented**, not customer-oriented. It keys on
  `phoneE164` and resolves to a `userId` — a CaratSense employee. It has no notion
  of a customer, a lead, or a conversation thread. It also only reliably stores
  **inbound**; bot replies are not persisted.
- The existing handoff endpoints (`/dashboard/handoffs`) are **cross-department
  task hand-offs**, unrelated to bot-to-human lead handoff. Do not overload them.
- `LeadNote` is a human-typed activity log. It is **not** a message trail and
  should not be stretched into one.

**Conclusion:** C3 and C4 are mostly present. C1 and C2 are net-new and are the
real build.

## 3. Proposed architecture

Four layers. Each is independently testable and independently shippable.

```
  Instagram DM   Facebook/IG Lead Ads   Messenger   WhatsApp   Website form
        |               |                   |           |            |
        +---------------+---------+---------+-----------+------------+
                                  |
                                  v
                    (1)  CHANNEL ADAPTERS  (one per channel)
                         normalise -> ChannelEvent (raw, idempotent)
                                  |
                                  v
                    (2)  IDENTITY RESOLUTION
                         ChannelIdentity -> Contact -> Lead
                                  |
                                  v
                    (3)  CONVERSATION STORE
                         Conversation + Message (channel-agnostic)
                                  |
                                  v
                    (4)  ROUTING AND ASSIGNMENT
                         bot -> queued -> human (Lead.ownerId)
```

### (1) Channel adapters

One adapter per channel, all producing the same normalised shape. The WhatsApp
bot's proven pattern is the template and should be copied deliberately:

- **Persist-then-200.** Meta retries for days if it does not get a fast ack. Write
  the raw event, return 200, process off the request. Already proven in production
  by the bot.
- **Idempotency on the provider's message id.** `WhatsAppEvent.wamid` is unique; a
  retry collides and is dropped. Every channel needs its own equivalent key.
- **Fail closed on signature verification** in production.

Adapters are the only channel-specific code. Everything downstream is generic.

### (2) Identity resolution — the hard part

A person is `+919876543210` on WhatsApp, `17841...` on Instagram, an email on the
website form. These must collapse to one customer or the CRM shows four leads for
one human.

Proposal: a `Contact` as the person, and `ChannelIdentity` rows binding each
channel handle to it. A Lead points at a Contact.

**Deliberately not automatic across channels.** Same-channel matching (phone to
phone) is safe. Cross-channel merging on a name is a guess, and a wrong merge
exposes one customer's conversation to another — the same class of bug as a
store-scope leak. Design: auto-link within a channel, **suggest** cross-channel
merges for a human to confirm.

Open: relationship between a new `Contact` and the existing `Party` model
(`Lead.partyId` already exists). See OQ-4.

### (3) Conversation store

Channel-agnostic `Conversation` (a thread) and `Message` (one message, either
direction). This is C2 and it is what `WhatsAppEvent` cannot do.

`WhatsAppEvent` stays as the raw-ingest and audit layer. `Message` is the
CRM-facing projection. Do not merge them — one is an integration concern with
retries and provider payloads, the other is a product surface.

**Outbound must be stored too.** Today the bot's replies vanish. A trail showing
only the customer's half is not a trail.

### (4) Routing and assignment

State lives on the Conversation, not the Lead:

```
bot ---------> queued ---------> human ---------> closed
   bot yields   unassigned,      assigned to      resolved
   or customer  visible in       a named user     or idle
   asks         a queue
```

`Lead.ownerId` already exists and stays the answer to "whose lead is this".
Conversation assignment answers "who is replying right now" — usually the same
person, but not necessarily.

Triggers for bot-to-human: explicit customer request, bot cannot parse after N
attempts, high-intent keyword, or a manual pull by a salesperson. Which of these
are in scope is OQ-6.

## 4. Data model — proposed

**New**

| Model | Purpose | Key fields |
|---|---|---|
| `Contact` | The person, channel-independent | id, storeId, name, phone?, email?, createdAt |
| `ChannelIdentity` | One handle on one channel | contactId, channel, externalId (unique per channel), displayName, verifiedAt |
| `Conversation` | A thread | id, storeId, contactId, leadId?, channel, state (`bot`/`queued`/`human`/`closed`), assignedToId?, lastMessageAt, windowExpiresAt |
| `Message` | One message | conversationId, direction (`in`/`out`), authorType (`customer`/`bot`/`user`), authorId?, type, body, mediaUrl?, externalId (unique), sentAt, deliveredAt?, readAt? |
| `ChannelEvent` | Raw inbound, per channel | Generalises `WhatsAppEvent`. channel, externalId unique, payload, status, attempts |

**Changed**

| Model | Change | Why |
|---|---|---|
| `Lead` | add `contactId String?` | Link to the resolved person |
| `LeadSource` | add `facebook`, `messenger`, `lead_ad` | Enum currently lacks them |
| `LeadStage` | possibly extend beyond 3 stages | See OQ-2 |

All additive and nullable, so the Gati sync agent and `backfill-legacy.mjs` are
untouched — the same rule the July and August work followed.

**Rules that carry over, non-negotiable:**

- Every new table carries `storeId`, and every query goes through `StoreScopeService`.
- Money stays `Decimal`. No float arithmetic on rupees.
- Migrations hand-timestamped `YYYYMMDDHHMMSS_name`, applied with `migrate deploy`.

## 5. Meta prerequisites — the real schedule risk

None of this is only code. Each channel needs permissions that go through **App
Review**, and App Review requires a **verified business**.

| Channel | Needs | Gate |
|---|---|---|
| FB/IG **Lead Ads** | Facebook Page, `leadgen` webhook, `leads_retrieval` | App Review |
| **Instagram DMs** | `instagram_manage_messages`, IG Business account linked to a Page | App Review |
| **Messenger** | `pages_messaging`, Page access token | App Review |
| **WhatsApp** | ~~Already live~~ **Channel destroyed — must be rebuilt.** See §5a | Éclat's own portfolio + new number |

**Status of the gate:** business verification for CARATSENSE AI LLP **passed** on
2026-09-08. The use case selected in the wizard was *"App requires access to
permissions on Meta for Developers"* — this build is exactly what it unlocks.

**Éclat has no Facebook Page.** Portfolio `911495711382016` shows
`Primary Page: None`. Lead Ads, Messenger and Instagram DMs are all impossible
without one. Client-side action, and it blocks three of the four channels.

## 5a. The WhatsApp channel this document assumed no longer exists

> Added 2026-09-08, after the incident. This section overrides every earlier
> statement in this document about WhatsApp being "already live".

Completing business verification banned the WABA. Portfolio `911495711382016`
was verified as **CARATSENSE AI LLP** while its WABA displayed **Eclat
Diamonds**; Meta re-reviewed every asset, declined the display name, and banned
both the WABA (`141014`) and the number `+91 99308 25893`. The test WABA was
banned too. Full evidence and reasoning in `docs/DECISIONS.md` (2026-09-08).

**The decided architecture — one Business Portfolio per client:**

```
CARATSENSE AI LLP portfolio (verified)   ← owns the APP, not client WABAs
        │  partner asset sharing
        ├──────────────────┬──────────────────
        ▼                  ▼
  Éclat portfolio     Client B portfolio    ← UNVERIFIED, no documents
  └ WABA "Éclat"      └ WABA "Client B"     ← display name matches owner ✅
```

Three constraints this puts on Module 1:

1. **The customer-facing channel is Éclat's WABA, not CaratSense's.** It does
   not exist yet — Éclat must create a portfolio, a Page, and register a new
   number. Tracked as **OP-30**.
2. **TIER_250.** Client portfolios stay deliberately unverified (Éclat has no
   GST it will share), which caps the channel at **250 unique recipients per
   rolling 24 hours** and 2 numbers. Fine at current lead volume; it is a real
   ceiling for the inbox at scale, and it is the trigger for revisiting
   verification — which must then be done with **Éclat's** documents, never
   CaratSense's.
3. **`WhatsAppService` is single-tenant.** One WABA per client makes the token
   and phone-number-id per-tenant database values, not env vars. Build that seam
   before the inbox is written against it — the same lesson as store-scoping.

**Hard rule:** never run business verification on a client portfolio, and never
with CaratSense's documents. That is precisely what caused this.

### Messaging windows — a product constraint, not a technical one

WhatsApp allows free-form replies only within **24 hours** of the customer's last
message; outside it, only an approved template. Messenger and Instagram have their
own windows and human-agent allowances.

This shapes the inbox: a salesperson opening a conversation 30 hours later
**cannot simply type a reply**. The UI must show window state and offer templates
when the window is closed. Designing the inbox without this produces messages that
silently fail to send.

Exact Messenger and Instagram window durations and human-agent tag rules to be
confirmed against current Meta documentation at build time — they have changed
before.

## 6. Open questions — need the client

| # | Question | Blocks |
|---|---|---|
| OQ-1 | Which channels for phase 1? All four, or WhatsApp + Lead Ads first? | Scope |
| OQ-2 | Is `inquiry -> quotation -> order_placed` enough, or do they want their real sales stages? | Data model |
| OQ-3 | Who owns an inbound lead before assignment — a queue per store, a default owner, or round-robin? | Routing |
| OQ-4 | New `Contact` vs existing `Party`? Party carries Gati legacy customers; leads are pre-customer | Data model |
| OQ-5 | Store attribution: which store owns an Instagram DM? There is no branch in the payload | **Multi-store — critical** |
| OQ-6 | What triggers bot-to-human? Customer asks / bot fails / keyword / manual pull? | Routing |
| OQ-7 | Is the bot customer-facing at all? Today it deliberately ignores unknown numbers (anti-enumeration). Customer capture reverses that policy | Security |
| OQ-8 | Does Éclat have a Facebook Page and an IG Business account? | 3 of 4 channels |
| OQ-9 | Retention — how long are customer conversations kept? | Compliance |

**OQ-5 and OQ-7 are the two that need answering before any code.** OQ-5 because
store attribution is baked into every table and retrofitting it is a rewrite.
OQ-7 because opening the bot to unknown numbers reverses a deliberate security
decision documented in `docs/WHATSAPP-BOT.md` section 2.

## 7. Suggested phasing

Each phase ships something usable on its own.

| Phase | Scope | Depends on |
|---|---|---|
| **0** | Confirm this document. Answer OQ-5 and OQ-7. Éclat creates a **portfolio, a Page and a new WABA** (OP-30) | — |
| **0a** | Make `WhatsAppService` per-tenant — token + phone-number-id from the DB, not env | — |
| **1** | Conversation store + trail on the WhatsApp channel. No new channels | PR #2 merged, **0, 0a** |
| **2** | Bot-to-human handoff + assignment + agent inbox, WhatsApp only | Phase 1 |
| **3** | **Lead Ads** ingestion (FB + IG forms) to Lead. Highest lead volume, simplest payload, no live conversation | Verification, Page, App Review |
| **4** | Instagram DM + Messenger into the same inbox | Phase 3, App Review |
| **5** | Cross-channel identity merge (suggested, human-confirmed) | Phase 4 |

Rationale for that order: phases 1 and 2 still need **no App Review**, so they run
while the long poles proceed in parallel. Phase 3 before 4 because a lead form is a
one-shot payload, whereas DMs bring the whole window and threading problem with them.

⚠️ **Corrected 2026-09-08.** This originally read "phases 1 and 2 can start
immediately" on the assumption that a live WhatsApp channel already existed. It
does not — see §5a. Phase 1 is now gated on Éclat standing up their own WABA
(**0**, client-side) and on the multi-tenant refactor (**0a**, ours). Only 0a can
start today.

## 8. Non-goals

Explicitly out of scope unless the client asks:

- Marketing campaign send-out (Module 16 territory)
- Chatbot NLU / AI auto-reply beyond the existing guided flows
- Customer-facing ticketing (Module 13 exists)
- CCTV/footfall (dropped — see `docs/DECISIONS.md`)
- Replacing the internal DSR bot. It stays; the customer channel is additive

## 9. What this does not answer

Written from the codebase and the client's verbal brief. Not yet validated with:

- A walkthrough of Zithara with the client, to pin down what they actually mean
- Éclat's real sales stages (OQ-2)
- Expected lead volume, which decides whether the in-memory notifications bus is
  adequate or Redis becomes necessary (OP-16 in `docs/DECISIONS.md`)

---

_Next: review and mark up this document. No implementation until phase 0 closes._
