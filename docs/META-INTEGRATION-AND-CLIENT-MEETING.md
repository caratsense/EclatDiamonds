# Meta Integration & Client Meeting — Working Reference

> **Purpose:** one place for everything about the Éclat client meeting and the Meta
> (WhatsApp / Lead Ads / Instagram) integration into the existing CaratOS CRM.
> Written 2026-09-12. Facts here were checked against the code and the live Meta
> API, not assumed — where something is an assumption or an open question, it says so.
>
> **Scope note (updated 2026-09-15).** Phase-6 was merged to `main` on 11 Sept
> (`91a5d79`), so `main` now carries the multi-tenant platform, the CRM spine and
> the Meta integrations. But `main` is **not** the newest code: branch
> `phase-6-meta-integrations` is 18 commits ahead of it (tip `04ceea2`, 13 Sept)
> and is what staging deploys. Messaging Routes (`cc7b8f4`) exists only there.

---

## 1. The client meeting — what they asked for

Source: `meeting_notes.pdf`, "Product & System Operations Discussion Notes",
reviewed 2026-09-11. Reproduced by section.

### 1.1 Campaign & Ad Management
- Campaign allocation automation
- Pricing uploaded for the ads being run
- Ads will be revisited
- Follow-up messages to go after a week
- Tag option integration
- A button labelled **"Follow up"** (capitalisation specified)
- "IVR" — to be discussed

### 1.2 CRM & Lead Management
- Option to **download an Excel sheet** on CRM; at month-end an **automated Excel of leads**
- Store manager can add a "Date", or a feedback message goes within a week
- Add more metrics
- Add a **"Reminder"** option and a **"Remark"** option
- Check-in footfalls
- Review message sent to already-existing customers

### 1.3 Email, Quotations & Customer Communication
- Excel format to be specified by **Ayushi** — she wants an Excel from Gati to upload
  to the website, including product image and details
- Photos ZIP file and reference to be sent to email
- Head office will have this feature *(HO feature)*
- Add a **"WhatsApp"** option to send the quote directly to the customer;
  final amount approved by a manager
- **Quick Quote:** normal text message sent; everything else sent as PDF
- A **discount approval above 5%** to be decided

### 1.4 Inventory, Stock & E-Commerce
- Loyalty programme connected to the website
- Sort inventory & stock for customisation, under dead-stock items
- **Style number and VIN will be different** — style number given by us, VIN auto-generated
- **No need for stock-transfer**
- "Let marketing go for now"

### 1.5 HRMS, Attendance & System Configuration
- Month-end **salary slip auto-generated** from attendance calculation
- Every person has a **different day off** in the week — custom/manual option
- *Future:* AI chat / voice-note option to enter attendance directly, and for stores
- Home-setup "Hide" — changes in future
- Fix the UI and layering
- **8 numbers for 2 Meta accounts**

### 1.6 Follow-up from Shreyansh (WhatsApp, 11 Sept)
> "the jo login hmlog krenge na wp me it should take login face for in and out both ways"

Interpretation, based on §1.5's "AI chat / voice note option to directly enter on the
attendance area": **attendance punch via WhatsApp, both check-in and check-out.**
The notes mention no face/selfie anywhere — an earlier reading as biometric capture
was wrong and has been withdrawn. **Still worth confirming with him directly.**

---

## 2. Meeting items vs. what actually exists

Checked against `origin/phase-6-meta-integrations` on 2026-09-11.

| Asked for | State | Evidence |
|---|---|---|
| Reminder option | ✅ Exists | `/leads/reminders` GET + PATCH |
| Remark option | ✅ Exists | field present |
| Tags | ✅ Exists | |
| Check-in footfalls | ✅ Exists | `/checkins` module |
| Send quote on WhatsApp | ✅ Exists | `/quotes/:id/share` |
| Discount approval limits | ✅ Exists | `DiscountLimit`, per-role ceilings |
| Different weekly day off per person | ✅ Exists | `/hrms/week-off` PATCH |
| Loyalty programme | ✅ Exists | website linkage is separate work |
| **CRM Excel export / month-end sheet** | ❌ Missing | xlsx is **import-only** (`import.service.ts`, `xlsx.util.ts`); no export endpoint |
| **Salary slip from attendance** | ❌ Missing | no payslip generation anywhere |
| **Style number + auto VIN** | ❌ Missing | neither field exists in the schema |
| **IVR** | ❌ Missing | notes say "to be discussed" |
| **Google reviews** | ❌ Missing | no code |
| **WhatsApp attendance punch** | ❌ Missing | `/whatsapp/link/start` and `/hrms/attendance/check-in`·`check-out` both exist but nothing joins them |

---

## 3. Meta account architecture — history and current state

### 3.1 What went wrong (2026-09-08/09)

Portfolio `911495711382016` was created as *Eclat Diamonds* and held a working WABA
and the number `+91 99308 25893`. Its legal identity was then changed to
**CARATSENSE AI LLP** and business verification submitted. Verification **passed** —
and within hours the account was banned.

Graph API before → after:

| | Before | After |
|---|---|---|
| Portfolio verification | `pending_submission` | ✅ `verified` |
| WABA account review | `APPROVED` | ❌ `REJECTED` |
| Display name | `AVAILABLE_WITHOUT_REVIEW` | ❌ `DECLINED` |
| Number status | `CONNECTED`, TIER_250 | ❌ `BANNED` |
| Portfolio / App | — | ✅ `AVAILABLE` |

Errors: `141014` (WABA banned), `141006` (payment method). **The test WABA was
banned too**, which is what proves this was portfolio-level identity enforcement
rather than content, conduct or the number's history — the SIM was brand new,
quality was GREEN, no catalogue was ever uploaded and there was almost no traffic.

**Mechanism.** Meta requires a WABA's display name to relate to the entity that owns
it. While the portfolio was unverified, `Eclat Diamonds` was never reviewed at all
(`AVAILABLE_WITHOUT_REVIEW`). Verification completing triggered a review of every
asset; the reviewer saw an account verified as CARATSENSE AI LLP presenting as a
different company with a different website, and declined it.

Meta's own documentation confirms display-name review is triggered *"when reaching
higher messaging limits"* — and verification is what raises those limits.

### 3.2 What was decided

After discussion with Shreyansh (11 Sept): **everything under CaratSense.**
Portfolio, WhatsApp display name and verification all name CARATSENSE AI LLP.
No client-branded WABA inside a CaratSense-verified portfolio — that is exactly
what caused the ban.

The banned WABA and number are **left untouched** — no rename, no appeal, no
deletion. Deleting forfeits any future appeal and does not free the number.

### 3.3 Current live state

| Asset | ID | State |
|---|---|---|
| Business Portfolio | `1283907194812065` | CaratSense · **verified** (approved 2026-09-11) |
| App | `1847228096632841` | CaratOS · **published** |
| System user | `61594186384679` | CaratOs-backend · Admin |
| Test WABA | `2031636390828744` | `APPROVED` |
| Test number | `1368439909676293` | `+1 555-198-9264` · CONNECTED · GREEN |
| Old portfolio | `911495711382016` | CARATSENSE AI LLP · verified · healthy |
| Old WABA | `1352084950472773` | **banned — do not touch** |
| Old number | `+91 99308 25893` | **banned** |

Privacy policy live at `https://caratsense.in/privacy` — a real server-side path,
not an SPA route, so Meta's crawler can read it. This was required to publish the app.

---

## 4. How the integration works

### 4.1 The connection model

Éclat keep ownership of their Page and ad account — their brand, their billing,
their customers. They **share** those assets with CaratSense's portfolio as a
Partner. Nothing of theirs moves, and they can revoke it.

```
Éclat's Page + ad account
        │  shared as a Partner
        ▼
CaratSense portfolio  (1283907194812065)
        │  our app reads them with one system-user token
        ▼
CaratOS
```

WhatsApp is the exception: the number is registered under CaratSense, per §3.2.

### 4.2 How a Meta lead physically arrives

```
Customer fills a lead form on a Facebook or Instagram ad
        │
        ▼
   Meta's servers
        │  signed HTTP POST — "leadgen", carries a leadgen_id
        ▼
   POST /integrations/meta/webhook          (HMAC via META_APP_SECRET)
        │  verify signature, return 200 fast
        ▼
   GET /{leadgen_id} → Graph API            (needs leads_retrieval)
        │  returns the actual form answers
        ▼
   resolve-or-create Party + ContactPoint + Lead   (source = meta_ads)
        │
        ▼
   ad-set routing → assign to the right store and salesperson
```

**Click-to-WhatsApp is simpler**: the ad opens a normal WhatsApp chat and the first
inbound message carries a `referral` object naming the ad. Same webhook we already
have configured — no separate integration.

### 4.3 Webhook endpoints

| Webhook | URL | Verify token |
|---|---|---|
| WhatsApp Cloud | `https://backend-staging-e5cd.up.railway.app/integrations/whatsapp/webhook` | `WHATSAPP_WEBHOOK_VERIFY_TOKEN` |
| Meta Lead Ads | `https://backend-staging-e5cd.up.railway.app/integrations/meta/webhook` | `META_WEBHOOK_VERIFY_TOKEN` |

Subscribe `messages` on the WhatsApp webhook, `leadgen` on the Page webhook
(configured under **Webhooks → Page**, separately from WhatsApp).

The two tokens are **deliberately different** — one token for both would let either
Meta app authenticate as the other.

### 4.4 Asset registration

IDs go into **Settings → Integrations → Meta assets** on CaratOS: Phone Number ID,
Page ID, Form ID, Ad Account ID (numeric, no `act_` prefix).

Each shows **"Claimed only"** until a live health check proves the token can genuinely
read it, then **"Confirmed."** Typing an ID in is never treated as proof of ownership.

---

## 5. Verified status (as at 2026-09-12)

### Working — proven, not assumed
```
Webhook handshake          both tokens, challenge echoed correctly
Webhook registered         active, `messages` field subscribed (v26.0)
App → WABA subscription    CaratOS subscribed
Signature verification     signed → 200, unsigned/wrong → 403
INBOUND end to end         real message reached staging, stored as a conversation
Outbound from Meta         template send landed on a real phone
System user token          SYSTEM_USER, expires_at 0 (never), can send
Business verification      verified
App published              yes
Privacy policy             live and crawler-readable
```

**Inbound evidence** (staging logs, 11 Sept):
```
POST /integrations/whatsapp/webhook  200  20ms
[WhatsAppBotService] inbound from 919340749064: filed as customer
                     conversation cmtvuf5rr002bt6017i9mbyje
                     (sender not yet linked to a customer)
[WhatsAppBotService]   ai gate: unassigned — Conversation is not
                     routed yet, so nothing replies automatically.
```

### Not yet verified
- **Outbound from staging** — needs `WHATSAPP_ACCESS_TOKEN`,
  `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`,
  `WHATSAPP_PLATFORM_ORGANISATION_ID` on Railway
- **Lead Ads** — handshake passes, but no real `leadgen` event has ever arrived
  because Éclat have no Page, form or ad account
- **Real number** — still on Meta's test number, 5 allowlisted recipients only
- **Templates** — none on a real WABA; the five visible are Meta's samples

### The root cause that cost a day
`WHATSAPP_APP_SECRET` was unset on Railway, so correctly-signed payloads were
rejected with `403 invalid signature`. Proven by posting a payload signed exactly as
Meta signs it. **The verify token and the app secret are different variables** —
setting one does not set the other.

---

## 6. The bot gap — important

The system **does not reply to customers on its own.** Two gates:

**1 · Routing** — `ai-responder.ts`:
```ts
if (convo.handling !== 'ai') {
  return { outcome: 'unassigned',
    reason: 'Conversation is not routed yet, so nothing replies automatically.' };
}
```
Routing sets `handling` to `ai` or `human`. An organic message with no ad referral
and no round-robin policy gets neither.

**2 · Nothing delivers** — even with routing set:
```ts
// A DRAFT, stored as such. Nothing here delivers a message.
// Even with `autoSendEnabled` on, delivery would still need the WhatsApp…
return { outcome: 'replied_draft',
         reason: 'Draft stored for review; nothing was sent.' };
```
`autoSendEnabled` is stored and audited but **never read to send anything**.

So CaratOS is **assistive** (AI drafts, human approves), not autonomous. Éclat saw
Zithara's overnight-bot model and expect that. Already flagged as MISSING in
`docs/handovers/COMPETITOR-PARITY-STATUS.docx`; confirmed live by testing.

### Why it was built this way
Outside the 24-hour window WhatsApp permits only approved templates. An autonomous
reply at 2am to a closed window means silent failures or a falling quality rating —
which is what restricts numbers. One number has already been lost.

### Precedent worth knowing
**The Weather Point** (same workspace) runs a WhatsApp bot with **no AI at all** —
`sahaj_bot.py`, a scripted guided flow with a `BotSession` state machine: menu,
one question at a time, summary, confirm. Predictable, no API key, no hallucination
risk. A viable alternative to AI drafting for a first customer-facing bot.

### Three options — Éclat's decision
1. **Assistive** — drafts, human approves. Available now.
2. **Auto-reply inside the 24-hour window only**, hand to a human outside it. Safe middle ground.
3. **Fully autonomous** — needs approved templates first, which do not exist.

### Also missing before any of it can run
`CRM_AI_PROVIDER`, `CRM_AI_MODEL`, `CRM_AI_API_KEY` are **not set on staging**.
Without them the bot cannot compose anything. Setting them is free and risk-free:
the bot starts drafting, nothing sends, and the drafts can be read at
`/crm/ai/drafts` to judge quality before any decision is made.

---

## 7. What we need from Éclat — Meta only

1. **A Facebook Page.** Free, ~10 min. They have none. Unlocks Lead Ads, Instagram DMs and Messenger — three channels from one thing. **Biggest blocker.**
2. **An Instagram business account, linked to that Page.**
3. **An ad account — or confirmation they don't run Meta ads.** Blocks all ad-sourced enquiries and every ROAS figure.
4. **Their lead forms** (Instant Forms attached to their ads).
5. **A new SIM in the business name.** Becomes API-only; must not be a personal number; must receive one SMS or call at setup.
6. **What the automatic messages should say** — every automatic WhatsApp message needs writing and Meta approval in advance (hours to a day).
7. **Partner access** to the above once they exist.

**Priority:** 1 → 3 → 5 → 2 → 6. Items 1–3 start the App Review clock, which is the
long pole and cannot be submitted until the assets exist.

---

## 8. Open questions

| # | Question | Owner |
|---|---|---|
| 1 | "8 numbers for 2 Meta accounts" — unverified businesses get **2 numbers**, verified get 20. So: verify both entities, or run 4 WABAs at 2 each? Which 8 numbers, for what, whose 2 accounts? | Shreyansh / client |
| 2 | Bot autonomy — assistive, window-limited, or fully autonomous? | Éclat |
| 3 | Does Éclat actually run Meta ads? | Éclat |
| 4 | Shreyansh's "login face" message — attendance punch via WhatsApp, both directions? | Shreyansh |
| 5 | Who approves discounts above 5%? | Éclat |
| 6 | IVR — real requirement or "to be discussed" only? | Éclat |
| 7 | Google reviews — real requirement? | Éclat |
| 8 | Invoices: do they stay in Gati? 350 `.repx` templates exist there and CaratOS generates none. Never said out loud to the client. (`OP-22`) | Shreyansh / client |

---

## 9. Reference

**Repos and branches**
- `D:/workspace-caratsense/EclatDiamonds` — `main` @ `9589ac5`, **stale**
- `D:/workspace-caratsense/EclatDiamonds-staging` — worktree on `phase-6-meta-integrations`, the real code
- CaratOS work: 11 commits by Shreyansh, 9–10 Sept, unmerged

**Key documents on the branch**
- `docs/handovers/COMPETITOR-PARITY-STATUS.docx` — 38 capabilities classified BUILT / FIXTURE / LIVE / PARTIAL / BLOCKED / MISSING
- `docs/COMPETITOR-CRM-ENHANCEMENT-REVIEW.md` — analysis of the Zithara demo meeting
- `docs/META-STAGING-TEST-CHECKLIST.md` — the operator checklist for this work
- `docs/INTEGRATION-OPERATIONS-RUNBOOK.md`
- `docs/NEW-FEATURES-AND-INTEGRATION-SETUP.md`

**Environments**
- Staging backend: `https://backend-staging-e5cd.up.railway.app`
- Staging login: `staging.admin@caratsense.in` (password via `staging-bootstrap.mjs --password`, not stored anywhere)
- Railway: Eclat Diamonds → **staging** environment (not production)
- Local: worktree frontend, `BACKEND_ORIGIN` → staging, proxied via `/_api` (no CORS change needed)

**Secrets file** — `C:/Users/HP/caratsense-meta/meta-integration.env`, outside any git repo.
IDs safe to record; tokens and secrets never in chat, documents or screenshots.

**What Gati is** — Gati Softtech's **APRS-SJEP**, the SQL Server jewellery ERP Éclat
run today. CaratOS reads from it every 15 minutes via an on-site agent
(`synceclatcaratsense/`), one direction, read-only. Their real data — parties,
products, stock, sales, orders — already flows into CaratOS from it.

---

## 10. Client communications and materials (added 2026-09-15)

### 10.1 Call with Ayushi — 12 September

| Question | Answer |
|---|---|
| Which portfolio? | **Éclat's own** — she will share access |
| Ads? | Yes, run by an ads team. Each ad currently points at an **individual store's WhatsApp number** |
| What she wants | One number, routed internally to the correct store manager |
| Bot model | **Preset options → scripted answers → ~2 replies → handover to store manager.** One bot, not per-store. She supplies the questions, answers and store numbers |
| Existing API | "API is there, I have to align it." Activate on CaratOS first, then she moves it into ads for a trial |
| WhatsApp provider | **AiSensy** (a reseller). Last used **June** — dormant |

**Significance:** the bot she described is a **guided flow**, not an autonomous AI
conversation. Menu-driven, scripted, with a fixed handover rule. Buildable as a
state machine — the same pattern as The Weather Point's `sahaj_bot`. No AI key,
no hallucination risk, and no 24-hour-window exposure because it only ever
responds to someone who has just messaged.

This largely answers the open bot-autonomy question in §6.

### 10.2 The bot script — as supplied by Ayushi, 13 September

> ⚠️ **Incomplete.** The message truncates at Q5; the remainder has been requested.

**Q1 — What are you looking for?**
Options: Engagement Ring / Wedding Jewellery / Other Jewellery
Reply: *"Perfect. We'll help you find the right jewellery based on what you're looking for."*

**Q2 — What's your approximate budget?**
Options: Under ₹50K / ₹50K–₹1L / ₹1L–₹2L / ₹2L+
Reply: *"Perfect. We'll recommend options within your preferred budget."*

**Q3 — When are you planning to purchase?**
Options: Within 7 days / This month / 1–3 months / Just exploring
Reply: *"Got it. Our team can help you find suitable options based on your timeline."*

**Q4 — Are you specifically looking for lab-grown diamonds?**
Options: Yes / I'm open to options
Reply: *"Absolutely. We specialise in certified lab-grown diamond jewellery."*

**Q5 — Do you have a preferred diamond shape?**
Options: *(not supplied)*

Every question is a **qualification** question — intent, budget, timeline,
product fit. It maps directly onto lead scoring, not just conversation.

### 10.3 Access shared by the client

| Asset | State | Note |
|---|---|---|
| Facebook | ✅ **Sent** 14 Sept | Not yet inspected |
| Google Merchant Centre | ✅ **Sent** 14 Sept | New — never previously discussed. Google Shopping product feed; likely tied to the Gati→website Excel thread |
| Instagram | ❌ Declined credentials | Correct route: link the Instagram professional account to the Facebook Page; access then flows through the Page |
| Website backend | ❌ Declined shared login | Asked for a **separate admin account** instead. Admin config at `eclatdiamonds.in/admin/config` |

**Open:** the login she quoted, `9876543210`, is the standard Indian placeholder
number. Needs confirming as real or illustrative.

**Principle applied throughout:** no passwords, ever. Meta access is granted
business-to-business through Partner sharing; the client keeps ownership and can
revoke at any time.

### 10.4 Still outstanding from the client

1. **The rest of the bot script** — Q5 onwards
2. **Store numbers, and which branch answers on which** — now a hard dependency, see §10.5
3. **AiSensy status** — still connected? still paying?
4. **The 6-digit PIN** set when their numbers were registered
5. Whether their portfolio already holds a **Page** and an **ad account** — answerable by us now that access is shared
6. Their **business verification** status — decides the 2-number vs 20-number limit

### 10.5 Method change — 13 September

The handover doc `docs/handovers/EXTERNAL-INTEGRATION-READINESS.md` supersedes
the earlier approach:

> `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` and
> `WHATSAPP_PLATFORM_ORGANISATION_ID` are the **platform-owned transitional
> sender**… **Leave all three unset for a per-tenant deployment.**

**WhatsApp now connects per tenant, inside the app** — Settings → Integrations,
one connection per WABA, tokens encrypted in the database. Not through Railway
environment variables.

**Messaging Routes is now mandatory:**

> *"This is not optional with more than one number: an unrouted branch is refused
> at send time, with a message naming it, rather than sending as a different
> branch."*

So the `phone number → branch` table is a blocker, not a nicety.

### 10.6 Post-merge verification — 15 September

Re-checked after phase-6 was merged to `main` and 20 further commits landed:

```
health                  HTTP 200
webhook handshake       PASS
signed inbound payload  HTTP 200 → {"handled":true,"organisationId":"org_eclat"}
```

**WhatsApp inbound still works.** `integrationId: null` in the response confirms
it is still running on the platform path — it will populate once Éclat's WABA is
connected as a per-tenant integration.

---

## 11. Éclat's own Meta estate — opened 2026-09-15

The client's Meta access arrived on 14 September and was opened for the first time
on the 15th. Everything in this section was read off Business Settings, not
assumed. It changes several things this document previously stated.

### 11.1 The portfolio

```
Èclat diamonds and Company
Business ID            920334109418825
Business verification  VERIFIED
Time zone              Asia/Kolkata
```

**This corrects the 2026-09-08 decision entry in `DECISIONS.md`**, which recorded
that client portfolios would be left unverified because "Éclat has no GST it is
willing to share". They are already verified. Practical consequences: higher
messaging tiers are available, up to 20 numbers rather than 2, and a display name
matching the verified entity will pass review rather than being declined. The
ban that started all of this cannot repeat here, because their portfolio's legal
identity is their own.

**OP-30 is stale on two counts** and should be rewritten: it instructs Éclat to
share assets with portfolio `911495711382016` (the *banned* one — the live one is
`1283907194812065`), and it tells them to obtain a new SIM, which was written
before we knew what they already own.

### 11.2 The ad account — live, and larger than anyone said

```
Ad account   act_1844495372664629
Campaigns    497 (many Active)
Window read  16 Aug – 14 Sep 2026
```

| Campaign | Results | Reach |
|---|---|---|
| Lead Campaign Bandra linking | 719 Leads (Form) | 145,630 |
| Lead Campaign — Bandra Broadway | 433 Leads (Form) | 360,273 |
| Lead Campaign Delhi Paschim Vihar | 455 Leads (Form) | 194,019 |
| Lead Campaign Delhi Rohini | 342 Leads (Form) | 241,957 |
| Lead Campaign Udaipur | 434 Leads (Form) | 533,895 |
| 10/08 Franchise Lead ad | 141 Meta leads | 40,656 |
| 12/09 Traffic campaign | 1,843 landing page views | 73,738 |

Roughly **2,400 instant-form leads in 30 days**. Two things follow.

**The campaign names already encode the branch.** Cross-referenced against the
real Gati branches recorded on 2026-07-31 (`MUMBAI BANDRA`, `BANDRA BROADWAY`,
`DELHI ROHINI`, `DELHI PASCHIM VIHAR`, `UDAIPUR ASHOK NAGAR`), five of five
match. The ad-to-store routing table largely exists already, written by their own
media team.

**`leads_retrieval` is not a low-priority item.** It was ranked low in earlier
planning. On this volume it is arguably the highest-value part of the whole
integration, and unlike everything WhatsApp it has no dependency on AiSensy or on
which WABA turns out to be usable. Meta expires instant-form leads from the API
after 90 days, so every week without it is leads lost permanently.

### 11.3 The two lead forms

Supplied by Ayushi as screen recordings, 15 September.

**Form A — 4 slides.** Bandra, Bandra Broadway, Kala Ghoda, Udaipur, and all
other locations.

| # | Slide | Content |
|---|---|---|
| 1 | Intro | "Let Us Find Your Perfect **Ring** — Our Bandra team will call you." |
| 2 | Prefill | Full name, Phone, **Email** |
| 3 | Privacy | Submit |
| 4 | Message for leads | "Thank You, We're On It…" → **`Call now`** |

**Form B — 7 slides.** Delhi Paschim Vihar, Delhi Rohini, Borivali only.

| # | Slide | Content |
|---|---|---|
| 1 | Custom Q | Intro + **Occasion** — Engagement/Proposal, Anniversary, Wedding gift |
| 2 | Custom Q | **Budget** — under ₹50K, ₹50K–1L, ₹1L–2.5L, ₹2.5L+, "discuss with your team" |
| 3 | Custom Q | **When would you like to hear from us** — Immediately / Within an hour / Tomorrow / Anytime |
| 4 | Custom Q | **Visit our store?** — Yes / No, I prefer online |
| 5 | Prefill | Full name, Phone (**no email**) |
| 6 | Privacy | ☑ **"Message Èclat Diamonds and Company on WhatsApp"** (checked) → Submit |
| 7 | Message for leads | "…Feel free to WhatsApp us directly" → **`Chat on WhatsApp`** |

**The WhatsApp handoff exists only on Form B.** Form A ends at "Call now" and has
no WhatsApp path at all. Mapped onto the volumes above, roughly **1,600 of the
~2,400 monthly leads cannot reach a WhatsApp bot today**. Adding the WhatsApp
option to Form A is a form edit on the client's side, not a build — this is the
single cheapest, highest-impact change available, and it is a client decision.

### 11.4 WABA inventory — seven accounts, one usable

Ayushi described "2 contacts". There are seven WhatsApp accounts in the
portfolio, accumulated over time.

| WABA ID | Name | Type | Number | Status | Quality | Partner |
|---|---|---|---|---|---|---|
| **804704315221945** | Eclat Diamonds | **Cloud API** | **+91 70216 81648** | **Connected** | **Low** | **AiSensy** |
| 731574706328598 | Èclat Diamonds And Company | Cloud API | +1 555-821-7884 / -7483 | Pending | — | none |
| 1390089019638998 | Eclat Labgrown Diamond Jewellery | Business app | +91 72088 68037 | Offline | — | — |
| 1457131419241715 | Eclat Diamonds Delhi Ro | Business app | +91 72080 17689 | Offline | — | — |
| 187343911132743 | Èclat Diamonds | Business app | +91 93728 59806 | Connected | — | — |
| 481256101743767 | Èclat Diamonds | Business app | +91 83696 10734 | Offline | High | — |
| 752631037876022 | Eclat Diamonds | Business app | not captured | — | — | 0 partners |

**How to read this table.** "Cloud API" accounts show a *Connected/Pending*
status, carry a quality rating, and have **Assign partner** enabled. "Business
app" accounts are numbers running on the WhatsApp Business *phone app* on a
staff handset — they cannot receive webhooks, cannot be automated, and their
**Assign partner** button is greyed out. The distinction is not cosmetic: a
number on the Business app must be **deregistered from the phone** before it can
join the Cloud API, which is one-way and takes the chat history away from
whoever currently answers it.

**Consequences.**

- There is exactly **one production Cloud API number in the entire portfolio**:
  `+91 70216 81648`. Unless a new number is registered, that is the bot's number.
- Its **quality rating is Low**, meaning recipients have been blocking or
  reporting. Low quality reduces messaging limits and carries genuine
  restriction risk. Given one WABA has already been lost to a ban, this is not a
  number to rehearse on.
- **AiSensy holds partial access to it.** They do not own it — Éclat does — so
  nothing needs migrating out of a reseller's account, which was the feared case.
  But two systems replying on one number will collide, and that must be resolved
  rather than worked around.
- `731574706328598` is API-capable with only Meta test numbers registered. It is
  the natural place to rehearse the whole flow without touching the live number.

### 11.5 Screening questions are not the bot script

The 10-question list supplied on 13 September was **read as the bot's script and
that was wrong**. Corrected on 15 September by the client:

```
THE 10 QUESTIONS  =  the screening set the AD FORM asks.
                     Ayushi will instruct the ads team to use exactly
                     these and nothing beyond them.
                            |
                            v   answers arrive as lead data
THE BOT           =  responds to what the customer already answered.
                     Script still outstanding.
```

Ayushi, on the 15 September call: the replies in that list are not the bot's
answers, and she will send the bot answers separately — *"मैं bot answer भी बनाके
आपको भेज देती हूँ"*. And: *"जो मैंने भेजा है ना, वो अभी के लिए थोड़ा ignore कर दो"*.

She also clarified the shape: a customer receives **4–5 questions, not all ten**,
chosen by what they said. That is a branching flow, not a questionnaire, and it is
what the state machine must model.

**What survives the correction.** Three problems in that list are form-design
issues rather than script issues, and still need client answers, because the
screening form is the source of the branch and budget data CaratOS will store:

- **Q7 offers a Hyderabad showroom.** Hyderabad appears in no Gati branch record
  and has no campaign. Either it is a store nobody told the dev side about, or
  it is an error that will collect unroutable leads.
- **Q7 offers a single "Delhi"** while Rohini and Paschim Vihar are separate
  stores with separate campaigns and budgets. Messaging Routes refuses an
  unrouted branch at send time, so a combined option cannot route.
- **Budget bands disagree** between the 10-question list (₹1L–2L, ₹2L+) and the
  live 7-slide form (₹1L–2.5L, ₹2.5L+). One of the two will be stored wrongly.

### 11.6 From the internal call, 15 September

- **Shreyansh:** nothing is to be integrated into live ads. A **demo ad** will be
  created and routing started from there. He reports no current blockers; website
  leads are arriving normally.
- **Vedant:** CRM is the priority if a choice has to be made; both in parallel if
  possible. Store integration to begin within a week. He also wants the two UIs
  (Aadi's and Shreyansh's) merged, after testing.
- **Ayushi:** the ad form exists to filter out accidental ad clicks — details are
  only released once the form is filled. Bot replies should read as natural
  conversation, e.g. after a budget answer, *"Is it okay if I connect you on a
  call so our agent can discuss the design you have in mind?"*, with a
  salesperson following up. Intent matters: "just exploring" is low intent;
  high intent should reach sales properly.
- **Action on Sneha:** Vedant asked for the bot script to be redrafted in natural
  language, and for ElevenLabs' agent tooling to be looked at as a reference.
  This is sequential — Ayushi's draft first, then the redraft.

### 11.7 A correction worth passing to the client

Ayushi believes the questions must be *"approved by Meta"*. **They do not need
to be.** Template approval applies only to messages a business *initiates*. In
this flow the customer always messages first, which opens the 24-hour customer
service window, and inside that window free text, reply buttons and list
messages can all be sent with no review at all.

Templates become necessary only to re-engage someone after 24 hours of silence.
Telling her this removes a blocker she believes exists, and means the script can
be changed freely during testing rather than waiting on review cycles.

### 11.8 Two code gaps, both on Shreyansh's side

1. **`whatsapp.service.ts` can only send `text` and `template`.** There is no
   `interactive` support, so reply buttons (max 3 options) and list messages (up
   to 10 rows) cannot be sent. Ayushi's flow is entirely options-based. Without
   this the bot can only offer numbered text menus.
2. **Nothing generates the guided reply.** `ai-responder.ts` still only drafts
   for human approval. The state machine on `feat/whatsapp-bot` is the store-to-HO
   *reporting* bot — different direction, different users — and is unmerged.

### 11.9 One unknown that the demo ad will settle

Meta attaches a `referral` object carrying the ad id to inbound messages from
**click-to-WhatsApp ads**, and `integrations/meta-referral.ts` already parses it.
Whether the same referral is attached when someone arrives via a **lead form's
"Chat on WhatsApp" button** has *not* been verified, and the ad-to-store routing
design depends on it.

If it is not attached, the fallback is sound: the **leadgen webhook** fires at
form submission carrying the phone number, form id and ad id, so CaratOS knows
the branch before the customer ever messages and can match on phone number when
they do. Shreyansh's demo-ad test is the right experiment to settle it.

---

## 12. The bot — specification as supplied by Ayushi, 2026-09-16

This supersedes the 10-question list in §10.2, which was the **ad form's screening
set**, not the bot (see §11.5). What follows is the bot itself, plus the
constraints each part runs into.

> **Read this as a specification, not as copy.** Ayushi has supplied the
> **pointers** — what the bot must cover, how the conversation branches, and what
> the customer is offered at each step. The indicative wording quoted below is
> hers and shows intent; it is **not** the final message text.
>
> **Writing the actual messages is CaratSense's job**, and Ayushi approves them.
> That is the deliverable Vedant asked for on 15 September when he said the script
> should be redrafted in natural language. So every `> **Bot:**` block here is a
> requirement to be met, not a string to be pasted into code.

### 12.1 The requirement behind it

Ayushi's stated goal, in her words as relayed on 16 September:

> Every conversation that happens must be **recorded and usable in the CRM** —
> including after the customer has been routed to a store manager — so that lead
> quality can be judged (hot vs cold), and conversion measured.

And decisively, resolving the argument in §11 about where humans work:

> The managers will also use **the same software** to interact with the customer,
> **not the official WhatsApp app**. So we are getting all of those numbers
> converted to API.

**That is the whole visibility problem solved at the source.** The reason a
manager's phone conversation is invisible is that the WhatsApp Business App has
no API (§11 and the runbook cover why). Moving those numbers onto the Cloud API
and having managers work inside CaratOS removes the blind spot entirely rather
than trying to see through it.

It is not free — see §12.8 — but it is the correct answer and it is the client's
own decision.

### 12.2 Two ad types, two entry flows

| | Ad type | Customer arrives wanting | Bot's job |
|---|---|---|---|
| **1** | Price enquiry | a price for a specific product | quote it, then offer a next step |
| **2** | Purchase intent | to talk to staff | ask 4 qualifying questions, then route |

The four questions on flow 2 exist to establish genuine intent before a
salesperson's time is spent — the same filtering logic as the ad form itself.

### 12.3 Flow 1 — price enquiry

Customer sends a product, a screenshot, or asks for a price.

> **Bot:** Here is a breakup for the product you have selected *(as per 14kt
> yellow gold, VVS-EF diamond colour and clarity)* … We can also customise the
> gold colour you like, or in 9KT and 18KT. We can also customise the diamond
> features as per your requirements.
>
> Would you like me to send a revised quotation with specific details, or connect
> with you on a quick call if you have any questions?
>
> Alternatively I can share our website link, or our store address if you want to
> explore more designs.

Branch on the reply: **connect to an agent**, **send store address**, or **send
website link**.

> **Note — this flow needs more than messaging.** "Here is a breakup" means a real
> price computed from a real product at a real gold rate. That is Module 2
> (quotation and pricing), not the bot. And "the product you have selected" implies
> identifying a product from a **screenshot the customer sent** — which is the
> catalogue visual-similarity search (DINOv2 + SigLIP, on `main`). Both exist;
> neither is wired to WhatsApp. Flow 1 is substantially more work than flow 2.

### 12.4 Flow 2 — qualification

1. **What are you looking for today?**
   Engagement Ring / Wedding Jewellery / Daily Wear / Other Jewellery
2. **Is this purchase for yourself or someone special?**
   Myself / Partner / Family / Gift
3. **What is your approximate budget?**
   Under ₹50K / ₹50K–₹1L / ₹1L–₹2L / ₹2L+
4. **When are you planning to purchase?**
   Within 7 days / This month / 1–3 months / Just exploring

Then:

> **Bot:** You can find *(whatever they want)* designs on our website *(link)* and
> I will connect with you to discuss your requirements in detail.
> Can you confirm what time suits you for a quick call? Can we connect now?

**If the customer declines a call:**

> **Bot:** Sure, I will connect with you later. Meanwhile, would you like to
> compare pricing for any product? Please share a screenshot of the design you
> have in mind.
>
> Alternatively, if you would like to visit an Éclat showroom, here are links to
> our showroom in your city. Please let me know when you would like to visit.
> *(send store links)*

### 12.5 The rings sub-branch

Triggered when Q1 = Engagement Ring.

> **Bot:** You can find engagement rings on our website to check our designs, and
> I will connect with you to discuss your requirements in detail shortly.
> Do you have a preferred diamond shape? I can send you a link with those rings.

Customer: **Round / Oval / Emerald / Princess / Pear / Other**

> **Bot:** Perfect, here is the link to *oval* rings *(or whichever shape they
> chose)*.
> Can you confirm what time suits you for a quick call? Can we connect now? I can
> help you with more custom designs.

Declining a call falls through to the same "share a screenshot / showroom links"
branch as above.

> **Six options exceeds the 3-button limit** — this one needs a WhatsApp **list
> message**, not reply buttons. See §12.8.
>
> **It also needs six real URLs**, one per shape, and they must be live pages. A
> link to an empty filter is worse than no link.

### 12.6 Handoff to a store manager

The customer is asked whether they want a call or to speak to staff. On yes, the
thread is routed to the store manager for the relevant branch, who continues the
conversation — **inside CaratOS**, not on a personal handset.

Three ways this can work technically, and the choice matters:

| | Mechanism | Templates? | Drop-off | Visibility |
|---|---|---|---|---|
| **A** | Conversation **stays on the bot number**; the manager takes it over in CaratOS | none needed | none | full |
| **B1** | Manager's own API number messages the customer first | **template required** — no 24h window exists on that number | none | full |
| **B2** | Bot sends a `wa.me` link to the manager's number; **customer** taps and messages | none needed | some — a tap is required | full |

All three are visible in the CRM **provided the manager's number is on the Cloud
API**. The difference is cost and friction, not visibility.

**A is what the code implements today.** `Conversation.senderAssetId` states it
outright: *"THE NUMBER THIS THREAD ARRIVED ON, and the one a reply must leave
from. Outranks the branch's route at send time."* The stated reason is that
answering from a different number starts a second thread on the customer's phone,
abandons the 24-hour window opened on the first, and reads to them as a different
business.

**Ayushi has described B.** That is buildable, but it is a deliberate departure
from a documented design decision, and it should be Shreyansh's call rather than
something assumed. B1 additionally costs an approved template and a paid
conversation on every single handoff.

**Open — needs a decision.**

### 12.7 The sales-staff intake form

After the manager has spoken to the customer, they fill in a structured form in
CaratOS. Ayushi's fields:

- **Is this purchase for an upcoming proposal or occasion?** — Yes / No / Just exploring
- **What is your approximate budget?** *(if the customer did not give one)* — Under ₹50K / ₹50K–₹1L / ₹1L–₹2L / ₹2L+
- **Would you like to explore our latest designs?** — Yes, show me the collection
- **Would you like to know about Éclat's exchange and buyback policy?** — and confirm whether this was actually told to the customer

This is the lead-scoring input: it is what turns a conversation into hot/cold.

> **Design note.** Two of these duplicate what the bot already asked (budget,
> intent). The form should **pre-fill from the conversation** and ask the manager
> to confirm or correct, not re-ask from blank. Re-keying what the customer
> already said is how intake forms stop being filled in.
>
> The last item is not a question about the customer at all — it is a
> **compliance checkbox** on the salesperson. Worth modelling as such.

### 12.8 Follow-ups — and the constraint nobody has costed

**After one week:**

> We haven't heard back from you and it's been a week! If you are still exploring,
> would you like to reconnect with us on a call, or sign up for our latest designs?
> Every week we share new designs and new offers on WhatsApp. You can stop any time
> you like.
>
> Éclat provides high quality certified diamonds and gold with lifetime buyback
> and exchange policy.
>
> *Offer three options, including **book a store appointment**.*

**After one month:**

> Don't forget to finalise the jewellery you were planning to buy.
> What would you like our team to help you with?
> — Find a ring / Choose a diamond / Pricing / Showroom visit appointment /
> Expert consultation and services

**These are the most technically constrained part of the entire specification,
and it is worth being explicit with the client about why.**

- Both fire **long after the 24-hour customer service window has closed**.
  Everything inside the window is free-form and free of review; everything outside
  it requires a **pre-approved template**.
- Both read as **marketing**, not utility — "new designs and new offers",
  "sign up". Meta categorises them accordingly, marketing templates are the
  category most often **rejected**, and they are **billed per message**.
- At ~2,400 leads a month, a one-week and a one-month follow-up on each is
  roughly **4,800 paid marketing conversations a month**. That is a real line
  item and the client should see the number before it is built.
- The opt-out — *"You can stop any time you like"* — is correct and necessary.
  It must be honoured in code, not just written in the copy.

**Recommendation:** get these two templates drafted and submitted for approval
early. They are the longest-lead item in the whole bot, and a rejection costs a
full resubmission cycle.

### 12.9 What this needs that does not exist yet

| Need | Status | Owner |
|---|---|---|
| **Interactive messages** — reply buttons (3) and list messages (10) | **Missing.** `whatsapp.service.ts` sends only `text` and `template` | Shreyansh |
| Customer-facing guided state machine | **Missing** on the CRM path. The DSR bot (`whatsapp-bot/dsr-flow.ts`) is the working pattern to copy | Shreyansh |
| Handoff to a *different* number (B1/B2) | **Contradicts** `senderAssetId`'s stated rule — needs a decision | Shreyansh |
| Manager numbers on Cloud API | Not started. **One-way per number**, and it takes that handset's chat history | Sneha + Éclat |
| Pre-filled sales intake form | Not started | Shreyansh |
| Two follow-up templates, approved | Not started — **longest lead time** | Sneha |
| Price breakup from a screenshot (flow 1) | Pricing = Module 2; image match = catalogue search on `main`. Neither wired to WhatsApp | Shreyansh |
| Six live shape-filtered ring URLs, per-city store links, website links | Not supplied | Ayushi |
| Opt-out honoured in code | Not started | Shreyansh |

### 12.10 Questions this specification raises

1. **Which numbers become manager numbers, and for which branches?** Converting a
   number to the API deregisters it from that manager's phone permanently and
   takes the chat history with it. Each one needs naming and agreeing.
2. **Flow 1 quoting** — does the bot send a real computed price, or an indicative
   range? A wrong price sent automatically to a customer is a commercial problem,
   not a bug.
3. **The six ring-shape URLs, the per-city store links and the website link** —
   all referenced in the script, none supplied.
4. **Is "Hyderabad" a real showroom?** Still unanswered from §11.5, and store
   links are now needed per city.
5. **Who approves the follow-up template copy** before it goes to Meta, given a
   rejection costs a resubmission cycle?
6. **Does the opt-out stop only marketing follow-ups, or all bot messages?**
