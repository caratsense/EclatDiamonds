# Meta Integration — Setup Runbook

> **Who this is for:** the person doing the Meta account configuration (Sneha).
> It assumes no application code will be written — every step here is clicking in
> Meta's dashboards, in CaratOS settings screens, or running a read-only API check.
>
> **Companion document:** [META-INTEGRATION-AND-CLIENT-MEETING.md](META-INTEGRATION-AND-CLIENT-MEETING.md)
> holds the history, the client meeting notes and the evidence behind every claim
> here. This file is the *do it* version.
>
> **Approach — decided 2026-09-15.** Nothing is wired into Éclat's live campaigns.
> The whole flow is rehearsed on a **demo ad against a demo number**, and only
> after it demonstrably works does any live traffic move onto it. This was
> Shreyansh's call on the internal call and it is the structure of this document:
> Part A is safe to do today, Part B is the rehearsal, Part C is going live.
>
> **Last verified:** 2026-09-15. Facts below were read off the live dashboards or
> the Graph API. Where something is unverified, it says so.

---

## 0. The map — how the two accounts connect

There are two Meta Business portfolios and the split is the whole design.

```
  CARATSENSE portfolio  1283907194812065        ÉCLAT portfolio  920334109418825
  (ours — verified as CARATSENSE AI LLP)        (theirs — verified, Asia/Kolkata)

   ├─ App "CaratOS"  1847228096632841            ├─ Ad account  act_1844495372664629
   │    · our software identity                  │     497 campaigns, ~2,400 leads/mo
   │    · holds the App Secret                   │     ← DO NOT TOUCH THESE
   │    · App Review happens HERE                │
   │    · webhooks point at our backend          ├─ Facebook Page  (id not yet captured)
   │                                             │     the lead forms belong to it
   ├─ System user "CaratOs-backend"              │
   │    122101344069472879                       ├─ 7 WhatsApp accounts
   │                                             │     only ONE is Cloud API — see §1
   ├─ Test WABA  2031636390828744                │
   │    + test number 1368439909676293           └─ Google Merchant
   │    (+1 555-198-9264) — our sandbox
   │
   └─ Business verification ✅
              ▲
              └──────── they share assets as a PARTNER ────────┘
```

**The rule: the app is ours, the assets are theirs.**

- The **app** is a software identity. One app serves every tenant, passes App
  Review once, and must live in CaratSense's portfolio.
- Their **Page, ad account, WABA and numbers** stay in their portfolio. They
  grant access via Partner sharing, and can revoke it. Nothing of theirs moves.
- **A WABA can never be moved between Business portfolios.** There is no
  migration and no support exception.

**Why not a system user inside their portfolio?** Because the token would then
belong to their business — if anyone there deletes that user, our integration
dies and we have no visibility into why. Partner sharing keeps the token on our
system user, in our verified portfolio.

---

## 1. The numbers — SETTLED 2026-09-16

| Role | Number | WABA | State |
|---|---|---|---|
| **Customer bot** — ads land here, the bot answers here | **+91 70216 81648** | `804704315221945` | Cloud API, **Connected**, ready |
| **DSR / internal bot** — staff to head office | **+91 72080 17690** | not yet created | new unused Airtel SIM |

Agreed with Ayushi after she **removed AiSensy** from `804704315221945` on
2026-09-16, which was the condition that had blocked this arrangement.

**Why this way round.** The customer number is the one the live ad forms most
likely already point at, so no form repointing is needed across 497 campaigns.
It is also already registered and Connected — no SIM registration, no
display-name review, no wait. The DSR bot is the one that *initiates* messages
every evening on templates, so it is the job that actually benefits from a fresh
number with clean standing.

**The one caveat.** `+91 70216 81648` showed a **Low** quality rating on
2026-09-15. Not blocking: quality mainly caps how many recipients a business can
*initiate* to, and the customer bot never initiates — the customer always
messages first. A bot that replies in seconds tends to raise a quality rating,
because slow replies are what make people block a business. Re-check the rating
once the WABA is shared with us.

> ⚠️ **AiSensy's removal is unverified by us.** Ayushi did it in her dashboard;
> we cannot read that WABA until it is shared with CaratSense. Confirm it via
> the Graph API before pointing the bot at the number — a screen will not show
> you whether AiSensy's app is still subscribed to the WABA's webhooks.

### The other nine WhatsApp accounts

The portfolio holds **11** WhatsApp accounts (per the People page asset count),
of which seven were inventoried on 2026-09-15 — see §11.4 of
`META-INTEGRATION-AND-CLIENT-MEETING.md`. Five of those seven run on the
WhatsApp Business **phone app** and cannot be automated at all; one holds only
Meta test numbers and is the right place to rehearse.

**Four have never been looked at.** Worth checking before assuming the estate is
understood.

### The three phone-app numbers are not wasted

Ayushi's plan is for branch managers to work leads **inside CaratOS**, not on
their handsets — see §12.1 of the companion document. Converting a manager's
number to the Cloud API is one-way and takes that handset's chat history with
it, so each conversion needs naming and agreeing individually.

## 2. Before you start

- You are **Admin** on Éclat's portfolio `920334109418825` — confirm at
  `business.facebook.com/settings/people?business_id=920334109418825`. Partner
  sharing requires Admin; if you are only an Employee, the sharing steps are
  blocked on Ayushi.
- Secrets live in `C:/Users/HP/caratsense-meta/meta-integration.env`, outside
  any git repo. **Never** paste a token, app secret, verify token or PIN into a
  document, a chat, a screenshot or a commit.
- IDs — business ids, WABA ids, page ids, ad account ids, phone numbers — are
  **not** secrets and can be shared freely.
- You are working inside a **live account spending real money** on 497
  campaigns. Read-only unless a step says otherwise. Never click
  **"Review and publish"** in Ads Manager.

---

## PART A — Lead Ads

**Do this first.** It has no dependency on WhatsApp, on AiSensy, or on the number
decision in §1, and it is where the volume is. Meta expires instant-form leads
from the API after 90 days, so delay costs leads permanently.

### A0. App subscribed to `page` / `leadgen` — DONE 2026-09-15

Lead notifications arrive on the **`page`** object with the **`leadgen`** field,
which is a *different* subscription from the WhatsApp one. The app was subscribed
only to `whatsapp_business_account` / `messages`, so no lead could have reached
CaratOS even with the Page shared. Now subscribed:

```
whatsapp_business_account -> messages   -> /integrations/whatsapp/webhook
page                      -> leadgen    -> /integrations/meta/webhook
```

The leadgen endpoint was verified first: correct verify token returns the
challenge (HTTP 200), wrong token returns HTTP 403. Reversible with a
`DELETE /{app-id}/subscriptions?object=page`.

### A1. Find the Page

`business.facebook.com/settings/pages?business_id=920334109418825`

Record the Page **name and ID**; lead forms belong to a Page. Put the id in the
env file as `ECLAT_PAGE_ID`.

> They definitely have one — you cannot run lead ads without a Page — even though
> earlier notes listed it as "unconfirmed".

### A2. Add CaratSense as a Partner

`business.facebook.com/settings/partners?business_id=920334109418825`
→ **Add** → *Give a partner access to your assets*
→ partner business ID **`1283907194812065`**

| Asset | Role to grant |
|---|---|
| The Page (from A1) | **Manage Page** — needed to read leads |
| Ad account `act_1844495372664629` | **View performance** — enough for `ads_read` |

**Tell Ayushi before you do it.** You have the permission; changing partner
access on a client's live ad account without a word is not how to use it.

### A3. Confirm the share actually landed

```bash
ENV=C:/Users/HP/caratsense-meta/meta-integration.env
TOKEN=$(grep -E '^WHATSAPP_ACCESS_TOKEN=' "$ENV" | sed 's/^[^=]*=//' | tr -d ' \t\r\n')
curl -s "https://graph.facebook.com/v21.0/act_1844495372664629?fields=id,name,account_status&access_token=$TOKEN" \
  | sed "s/$TOKEN/[REDACTED]/g"
```

- **Before sharing:** `(#200) Ad account owner has NOT grant ads_management or
  ads_read permission` — the expected "not yet".
- **After sharing:** the account's id, name and status.

Ownership is only real when a live read succeeds. Typing an ID into a settings
screen proves nothing.

### A4. Register the assets in CaratOS and run Health

CaratOS → **Settings → Integrations** → register the **Page**, the **Lead Form**
and the **Ad Account** ids, then run **Health**.

`providerOwnershipVerified` stays `false` until a live Health read succeeds. If
it stays false, A2 did not take — go back rather than proceeding.

### A5. Start App Review

`developers.facebook.com/apps/1847228096632841/app-review/permissions/`

Request **Advanced Access** for:

| Permission | What it buys |
|---|---|
| `leads_retrieval` | pulling instant-form leads into the CRM |
| `ads_read` | resolving ad → ad set → campaign for routing and reporting |
| `pages_show_list` | listing the client's Pages |
| `pages_read_engagement` | reading the Page the forms belong to |
| `pages_manage_ads` | required alongside `leads_retrieval` for form leads |
| `business_management` | **reading assets shared to us by another business** — this is the exact permission the Graph API named when it refused us: `(#200) Requires business_management` |
| `ads_management` | only if the final lead/asset flow needs it — request only if used |

Per `docs/NEW-FEATURES-AND-INTEGRATION-SETUP.md` §5.1. **Request everything in one
submission.** Discovering a missing permission after approval costs a whole
review cycle, and Meta also expects the minimum actually used — so drop
`ads_management` unless the flow genuinely needs it.

Meta may additionally require, beyond the privacy-policy URL already live at
`caratsense.in/privacy`: **data-deletion instructions** and a **reviewer
screencast** demonstrating each permission in use.

Review takes days and sometimes needs a screencast. **Start it before you need
it** — it is the longest-lead item on the project and blocks nothing while it
runs.

### A6. Test leadgen delivery without spending anything

Meta provides a **Lead Ads Testing Tool** at
`developers.facebook.com/tools/lead-ads-testing`. It generates a test lead
against a chosen Page and form and fires the real `leadgen` webhook, with no ad
spend involved.

*Unverified on this account* — confirm it is reachable with your access level —
but if it works it is the cheapest possible proof that leadgen webhooks reach
CaratOS. It does **not** exercise the WhatsApp handoff; that needs Part B.

---

## PART B — The demo rehearsal

**Nothing in this part touches a live campaign, a live form, or a live number.**
The point is to prove ad → form → WhatsApp → bot end to end, in conditions we
control, before any customer is anywhere near it.

The demo ad also **decouples the number decision from the integration test** —
it can point at whatever number we choose, so AiSensy, the quality rating and
"which number do the live forms use" do not have to be resolved first.

### B0. Get Éclat's sign-off

A demo ad is still a real ad in their account, with real spend, however small.
It needs explicit approval — what it will run as, roughly what it will cost, and
that it will be paused immediately after the test. This is not something to do
quietly because the amount is trivial.

### B1. Settle the number (§1)

Blocked on Ayushi. If she picks **B**, a SIM has to come from their side and
that becomes the critical path for the whole WhatsApp half — which is why it is
worth asking today rather than after the other questions come back.

> **Caveat to check first:** the `+1 555…` numbers on `731574706328598` are Meta
> sandbox numbers, and it is doubtful a real ad can be attached to one. If that
> is confirmed, the demo ad needs a real registered number, and the new SIM
> becomes the unlock for everything rather than an optional extra.

### B2. Create the WABA and register the number

In **Éclat's** portfolio → *WhatsApp accounts* → **Add**.

- Display name should relate to **Èclat diamonds and Company** — the verified
  entity that owns the portfolio. A name matching the verified entity passes
  review; a mismatched one is what got the original WABA declined and then
  banned.
- Set a **6-digit PIN** during registration and record it in the env file. It is
  needed again for any later re-registration and is routinely forgotten.

### B3. Share it to CaratSense and mint a token

WABA → **Assign partner** → CaratSense `1283907194812065`.

> The **Assign partner** button is enabled only on Cloud API accounts. Greyed out
> means you have selected one of the five phone-app accounts.

Then in **CaratSense's** Business Settings → *Users → System users* →
**CaratOs-backend** → *Assign assets* → the shared WABA → **Full control**.

**Generate new token:**

- App: **CaratOS** (`1847228096632841`)
- Scopes: `whatsapp_business_messaging`, `whatsapp_business_management`
- **Expiry: Never.** A 60-day token expires mid-quarter and the failure surfaces
  as error `190` with no obvious cause.

Paste it straight into the env file. Not into chat, not into a ticket.

### B4. Connect it in CaratOS — per tenant, not env vars

CaratOS → **Settings → Integrations → connect `whatsapp_cloud`** for the Éclat
organisation. The token is encrypted at rest with `CREDENTIAL_ENCRYPTION_KEY`.

**Leave these three Railway variables UNSET:**

```
WHATSAPP_ACCESS_TOKEN
WHATSAPP_PHONE_NUMBER_ID
WHATSAPP_PLATFORM_ORGANISATION_ID
```

Per `docs/handovers/EXTERNAL-INTEGRATION-READINESS.md` they are a
"platform-owned transitional sender" and must stay unset for a per-tenant
deployment. Setting them makes every tenant send from one number.

**How to tell it worked:** the webhook response changes from
`{"handled":true,"organisationId":"org_eclat","integrationId":null}` to the same
thing with a real `integrationId`. `null` means it is still on the platform path.

### B5. Build the demo form and the demo ad

Copy the **7-slide form** (the Delhi PV / Rohini / Borivali one) rather than
inventing a new one — the point is to reproduce the real flow, including the
`Message … on WhatsApp` checkbox on the privacy slide and the `Chat on WhatsApp`
button on the final slide. Point its WhatsApp option at the demo number.

For the ad itself:

- **Minimum budget**, narrowest possible audience — ideally targeted so that in
  practice only you see it.
- Name it unmistakably, e.g. `ZZ DEMO — do not touch — CaratOS integration test`,
  so nobody on the media team mistakes it for a live campaign.
- **Pause it the moment the test is done.**

### B6. Run the test and record what arrives

Click your own ad from your own phone, fill the form, tap **Chat on WhatsApp**,
send the message.

Then capture, from the staging logs, exactly what the webhook received:

- Did a `leadgen` webhook fire at form submission? What fields did it carry —
  phone number, form id, ad id?
- Did the inbound WhatsApp message carry a **`referral` object**? If so, what is
  in `source_id`?
- Did CaratOS create a Conversation, and with what `organisationId`,
  `integrationId` and `sourceAdId`?

### B7. The one question this settles

Meta attaches a `referral` object carrying the ad id to inbound messages from
**click-to-WhatsApp ads**, and `integrations/meta-referral.ts` already parses it.
Whether the same referral arrives when someone comes through a **lead form's
"Chat on WhatsApp" button** is **not verified**, and the ad-to-store routing
design depends on it.

- **If the referral is attached** — routing works exactly as designed: `ad_id`
  matches a rule, the rule supplies the store, the bot answers branch-aware.
- **If it is not** — the fallback is sound. The `leadgen` webhook fires at form
  submission carrying phone number, form id and ad id, so CaratOS knows the
  branch *before* the customer ever messages, and matches on phone number when
  they do.

Do not build routing assumptions on top of this until the demo has run.

---

## PART C — Going live

Only after Part B has demonstrably worked.

### C1. Messaging Routes — mandatory, not optional

CaratOS → **Settings → Messaging Routes** → map each branch to the number that
answers for it.

With more than one number, **an unrouted branch is refused at send time**, with
an error naming the branch, rather than quietly sending as a different branch.

**Blocked on Ayushi** — the number → branch map. This cannot be guessed.

### C2. Decide what happens to the live forms

Two separate questions, both the client's:

1. **Form A has no WhatsApp option at all** — it ends at `Call now`. That covers
   Bandra, Bandra Broadway, Kala Ghoda and Udaipur, which is roughly **1,600 of
   the ~2,400 monthly leads**. Adding the WhatsApp option is a form edit on their
   side, not a build, and it is the cheapest high-impact change available.
2. **Which number the live forms point at.** If they point at
   `+91 70216 81648` and the bot ends up on a new number, the forms have to be
   repointed. Worth knowing before promising a date.

### C3. Resolve AiSensy

If the bot ends up on `804704315221945`, AiSensy's partner access has to be
settled — removed, or confirmed genuinely dormant. Two systems answering one
number produces duplicate replies to real customers.

If the bot goes on a new number (option B), this stops being urgent and can be
tidied up later.

---

## 3. What is NOT your job

Shreyansh's, and no amount of dashboard configuration substitutes:

1. **Interactive messages.** `whatsapp.service.ts` sends only `text` and
   `template`. Reply buttons (max 3 options) and list messages (up to 10 rows)
   are not implemented. Ayushi's flow is entirely options-based.
2. **The guided-flow state machine.** `ai-responder.ts` only drafts replies for
   human approval; `autoSendEnabled` is stored and audited but never read to
   send. The state machine on `feat/whatsapp-bot` is the store-to-HO *reporting*
   bot, and is unmerged.

---

## 4. Verification commands

All read-only. All redact the token. Run from Git Bash.

```bash
ENV=C:/Users/HP/caratsense-meta/meta-integration.env
TOKEN=$(grep -E '^WHATSAPP_ACCESS_TOKEN=' "$ENV" | sed 's/^[^=]*=//' | tr -d ' \t\r\n')
V=v21.0
r() { sed "s/$TOKEN/[REDACTED]/g"; }

# who owns this token — should be CaratOs-backend
curl -s "https://graph.facebook.com/$V/me?fields=id,name&access_token=$TOKEN" | r

# can we see Éclat's business yet?
curl -s "https://graph.facebook.com/$V/920334109418825?fields=id,name,verification_status&access_token=$TOKEN" | r

# their ad account
curl -s "https://graph.facebook.com/$V/act_1844495372664629?fields=id,name,account_status&access_token=$TOKEN" | r

# a WABA and its numbers (only works after it has been shared to us)
curl -s "https://graph.facebook.com/$V/<WABA_ID>?fields=id,name,account_review_status&access_token=$TOKEN" | r
curl -s "https://graph.facebook.com/$V/<WABA_ID>/phone_numbers?fields=display_phone_number,verified_name,quality_rating,status&access_token=$TOKEN" | r

# staging webhook handshake (replace TOKEN_VALUE with the verify token from the env file)
curl -s "https://backend-staging-e5cd.up.railway.app/integrations/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=TOKEN_VALUE&hub.challenge=ping"
```

---

## 5. Error codes you will actually hit

| Code | Means | Do |
|---|---|---|
| `(#200) Requires business_management` | asset not shared with us | redo A2 / B3 |
| `(#200) owner has NOT grant ads_read` | ad account not shared | redo A2 |
| `190` | token expired or revoked | mint a new one with **Never** expiry |
| `131030` | recipient not in the allowlist | add the number, or unset the allowlist |
| `132001` | template name/language mismatch | template identity is **name + language** |
| `141006` | no payment method on the WABA | client must add one |
| `141014` | WABA banned | not recoverable by us |
| `403 invalid signature` | `WHATSAPP_APP_SECRET` wrong or unset on Railway | this cost a day once already |

---

## 6. Safety rules

- **Never touch** the banned WABA `1352084950472773` or number `+91 99308 25893`
  — no rename, no appeal, no deletion. Deleting forfeits any future appeal.
- **Never run business verification on a client portfolio**, and never with
  CaratSense's documents. That is exactly what caused the original ban.
- **Never click "Review and publish"** in their Ads Manager.
- **Never modify, pause or duplicate an existing live campaign.** The demo ad is
  new and separate.
- **Never paste secrets** into documents, chat, screenshots or commits.
- Rehearse on the demo number, never on a live one.

---

## 7. Who is blocking what

| Item | Blocked on | Note |
|---|---|---|
| **Which number for the bot** | **Ayushi** | §1 — gates all of Part B |
| A SIM, if option B is chosen | **Éclat** | becomes the critical path |
| Sign-off for the demo ad | **Éclat** | B0 |
| Number → branch map | **Ayushi** | C1, cannot be guessed |
| AiSensy status | **Ayushi** | C3 |
| Which number the live forms point at | **Ayushi** | C2 |
| Adding WhatsApp to Form A (~1,600 leads/mo) | **Ayushi** | C2 |
| Hyderabad showroom — real or error | **Ayushi** | form design |
| Delhi split — Rohini vs Paschim Vihar | **Ayushi** | form design, blocks routing |
| Budget band mismatch | **Ayushi** | form design |
| The actual bot script | **Ayushi** | promised, not sent |
| Natural-language redraft | **Sneha** | after Ayushi's draft |
| Interactive messages, state machine | **Shreyansh** | §3 |
| **Nothing — start today** | **you** | **Part A, all of it** |
