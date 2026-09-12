# External integration readiness

**Written for:** the person who will create the provider accounts and paste the
credentials in — not for whoever wrote the code.

Every route, header, environment variable and setting name in this document was
read out of the source at the commit it ships with. None of it is an example or
an illustration: if a name here is wrong, the code is wrong with it.

**No secret values appear anywhere in this document, and none should be added to
it.** Where a value is needed, the document says where to put it, not what it is.

---

## How to read the status of anything

Three words are used precisely throughout CaratOS and throughout this document.

| Word | Means |
|---|---|
| **LIVE** | A real provider has answered successfully at least once. |
| **FIXTURE-TESTED** | The request the provider documents is built and exercised end to end against a test transport. No provider has answered it. |
| **UNAVAILABLE** | There is no working path at all, and the reason names what is missing. |

`GET /adapters` reports this per channel for the signed-in tenant, and reports
`verified: false` until a provider actually answers. Nothing in the product
reports itself connected because a credential was saved.

At the time of writing **no integration in this list is LIVE.** That is the
entire content of the work below.

---

## 1. Meta and WhatsApp

### What the client must obtain

1. A Meta Business account with **Business Verification** completed.
2. A Meta App with **App Review** passed for the permissions below.
3. A **WhatsApp Business Account (WABA)** — two of them, per the current plan.
4. **Eight phone numbers**, registered and verified across those two WABAs.
5. A Facebook **Page**, and an **Instagram professional account** linked to it,
   if Instagram Direct is wanted.
6. A **System User** token, or a long-lived user token, with:
   - `whatsapp_business_messaging`
   - `whatsapp_business_management`
   - `leads_retrieval` and `ads_read` (Lead Ads and spend)
   - `instagram_manage_messages` (Instagram Direct only)

### Deployment configuration

| Variable | What it is |
|---|---|
| `META_APP_SECRET` | Signs and verifies inbound Meta webhooks. |
| `META_WEBHOOK_VERIFY_TOKEN` | Echoed back during the webhook handshake. Any unguessable string; it must match what is typed into Meta. |
| `META_GRAPH_API_VERSION` | **Never defaulted** — e.g. `v21.0`. The request shape changes between versions, so an unset value disables Graph calls rather than guessing. |
| `WHATSAPP_APP_SECRET` | Signature verification for the WhatsApp webhook. |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | Handshake token for the WhatsApp webhook. |
| `WHATSAPP_API_VERSION` | Defaults to `v21.0`. |
| `WHATSAPP_GRAPH_BASE` | Defaults to `https://graph.facebook.com`. |
| `CREDENTIAL_ENCRYPTION_KEY` | **Required.** Base64, exactly 32 bytes. Tenant tokens are refused rather than stored unencrypted without it. |
| `CREDENTIAL_ENCRYPTION_KEY_VERSION` | Integer stamped on rows it writes. |
| `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS` | The prior key during a rotation. Decrypt-only. |
| `MESSAGING_RECIPIENT_ALLOWLIST` | Comma-separated numbers. On staging this is the blast door: anything not listed is refused rather than sent. |

`WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` and
`WHATSAPP_PLATFORM_ORGANISATION_ID` are the **platform-owned transitional
sender**. They apply to exactly one organisation, named explicitly by the third
variable, and to no other tenant. Leave all three unset for a per-tenant
deployment.

### Callback URLs to register in Meta

| Purpose | Method and path |
|---|---|
| WhatsApp webhook handshake | `GET /integrations/whatsapp/webhook` |
| WhatsApp inbound + receipts | `POST /integrations/whatsapp/webhook` |
| Meta Lead Ads handshake | `GET /integrations/meta/webhook` |
| Meta Lead Ads delivery | `POST /integrations/meta/webhook` |

Subscribe the app to the fields: `messages`, `message_template_status_update`
(WhatsApp) and `leadgen` (Lead Ads).

### Per-tenant setup inside CaratOS

1. **Settings → Integrations** — connect `whatsapp_cloud`, once per WABA. Two
   WABAs means two connections, each with its own access token.
2. Register each phone-number id against its own connection. Registering a
   number no longer switches the others off; a number may only be claimed by one
   connection across the whole platform.
3. **Settings → Messaging Routes** (`GET /messaging-routes`) — map each branch to
   the number it answers on. **This is not optional with more than one number:**
   an unrouted branch is refused at send time, with a message naming it, rather
   than sending as a different branch.
4. **Settings → Integrations → Meta → Assets** — register Page, Form, Ad Account
   and Instagram ids; then **Health** to verify the token can actually read them.
   `providerOwnershipVerified` stays false until that check passes.
5. Templates: names and languages are registered per connection and synchronised
   from Meta. A template is only sendable when Meta itself reported `APPROVED`
   within the last 24 hours — a locally typed status is never trusted.

### The eight-number to branch mapping

**Outstanding client input.** CaratOS cannot infer which branch answers on which
number, and refuses to guess. Provide a table of `phone number → branch`, then
enter it under Settings → Messaging Routes. Until then, every branch refuses to
send and the screen lists which ones.

### Rotating a token

Replace the access token on the connection in Settings → Integrations. The old
one stops working immediately. For the master encryption key, publish the new key
as `CREDENTIAL_ENCRYPTION_KEY`, the old as `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS`,
bump the version, then re-wrap through
`POST /integrations-registry/credentials/rewrap` until no rows remain on the old
version. Drop `PREVIOUS` only then.

**Status: FIXTURE-TESTED.** Inbound signature verification, asset ownership,
routing, template gating and the outbound sender all ship and are tested. No live
WABA has answered.

---

## 2. AI provider

### Deployment configuration

| Variable | What it is |
|---|---|
| `CRM_AI_PROVIDER` | `anthropic` or `openai`. An unrecognised value is refused, never silently redirected. Unset with a key present defaults to `anthropic`. |
| `CRM_AI_API_KEY` | The credential. |
| `CRM_AI_MODEL` | Model id. Defaults per vendor when unset. |
| `CRM_AI_BASE_URL` | Optional override for an OpenAI-compatible gateway. |

### What is implemented, per capability

| Capability | anthropic | openai |
|---|---|---|
| Reply drafting (for human approval) | yes | yes |
| Signal extraction for lead qualification | yes | **no** |

Both are reported separately at `GET /adapters` under `ai.capabilities`, because
they genuinely differ. Extraction is written against Anthropic's message API and
its JSON contract; on OpenAI, qualification falls back to the tenant's own phrase
rules, which is a real qualification rather than a simulation.

### Before switching it on

- Load the tenant's own knowledge documents, or drafts will be generic.
- Auto-send is **off** by default and stays off until somebody enables it after
  connecting a channel. Drafts wait for approval; an unapproved draft is never
  counted as a reply to the customer.
- Cost control is the provider's billing dashboard. CaratOS does not meter spend.

**Status: UNAVAILABLE until a key is provided.** Reported as such, with the
sentence a settings screen shows verbatim.

---

## 3. Instagram and Messenger

Requires everything in §1, plus App Review for `instagram_manage_messages` and an
Instagram professional account linked to the Page.

- Register the Instagram account id as an `instagram_account` asset on an
  `instagram` connection.
- Outbound uses `POST /{ig-user-id}/messages` with
  `{ recipient: { id }, message: { text } }` and the Page token as a bearer.
- Instagram's own messaging window applies; the omnichannel gate owns that policy
  and the adapter does not re-decide it.

**Status: FIXTURE-TESTED.** The request is built and exercised in full against a
test transport. No Instagram account has answered it. Messenger has no outbound
adapter at all and reports `unavailable`.

---

## 4. Telephony / IVR

### Inbound — real, and the half that works

1. Connect a `telephony` integration in Settings → Integrations.
2. Rotate a webhook token; it is shown **once**.
3. Point the provider at `POST /integrations/telephony/webhook` with the header
   `x-caratos-telephony-token`.
4. Map the provider's payload onto the normalised one. There is no vendor
   adapter, deliberately — see below.

A call to an unmapped number is logged and reported as **unrouted**, never filed
against a guessed branch.

### Outbound — vendor-neutral by necessity

There is no single telephony API. Exotel, Knowlarity, Twilio, Ozonetel and every
on-premise PRI gateway differ in URL, authentication and field names, so CaratOS
requires the tenant to declare theirs on the integration row:

| Setting | What it is |
|---|---|
| `capabilities.outboundCall` | Must be `true`. Outbound dialling is a separate product with most Indian providers. |
| `config.outboundCallUrl` | The dialling endpoint. **https only** — the request carries the API key and both customer numbers. |
| `config.outboundCallMap` | `{ "to": "<their field>", "from": "<their field>" }`. Defaults to `To` / `From`. |
| Credential `api_key` | Sent as `Authorization: Bearer …`. |

Until all four are present, `GET /adapters/voice` reports `unavailable` and names
the missing one — and the five-minute SLA's automatic-call switch reports the
same sentence rather than silently skipping every breach.

**Recording security:** recording URLs are stored with an expiry and are never
returned to a role that cannot see the call. Transcripts are not implemented.

**Status: inbound FIXTURE-TESTED end to end against the application's own
container; outbound FIXTURE-TESTED against a test transport.** No telephony
network has been contacted.

---

## 5. Email

| Variable | What it is |
|---|---|
| `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | All four required. Any missing and every send is a logged dry run. |
| `SMTP_PORT` | Defaults to 587. 465 uses implicit TLS. |

Per tenant, on an `email` integration:

- `config.sendingDomain` — the domain mail is sent as.
- `config.sendingDomainVerified` — set to `true` only after SPF, DKIM and DMARC
  are actually confirmed. **CaratOS does not perform a DNS check**; this records
  that an operator did, and `verified` stays false because nothing here looked.

Until both are set, customer-facing email is held back and reported as `dry_run`
with that as the reason. Internal mail — the month-end report to the owner's own
address — still goes, which is what the reporting module relies on.

Delivery receipts are not implemented for email.

**Status: DRY RUN until SMTP is configured.** The path is complete and runs.

---

## 6. Gati import

**Outstanding client input: the final workbook and the image package.**

1. Import a sample workbook at **Data & Imports**, choose the entity, and map the
   columns. Save the mapping as a profile — it stores the headers it was built
   from, so it refuses to apply to a file whose columns have changed rather than
   mapping confidently and wrongly.
2. Dry-run first. The preview reports what would be created, updated and
   rejected, and why, without writing anything.
3. Images: a ZIP whose filenames match SKU, legacy id or product name. Matching
   is case- and separator-insensitive (`BANGLE_300` matches `bangle-300.png`),
   with optional trailing-index stripping for `NECK-400_main-2`.
4. Replay is idempotent: the same file imported twice does not duplicate products
   or mint a second VIN.

The rejected-row report is downloadable from the batch.

**Status: FIXTURE-TESTED.** Ayushi's real workbook and image package are still
needed to verify the final column mapping.

---

## 7. Loyalty website API

1. **Settings → Loyalty → Points programme**: set the earn rate (both halves) and
   what a point is worth. Until both halves are set, earning is refused with that
   as the reason rather than silently awarded at 1:1.
2. Issue an **API key** — shown once, stored as a hash.
3. Issue a **signing secret** — shown once, stored encrypted.

| Item | Value |
|---|---|
| Base path | `/public/loyalty` |
| Auth header | `x-caratos-loyalty-key` |
| Signature header (outbound) | `x-caratos-signature` |
| Signature scheme | `t=<unix seconds>,v1=<hex hmac-sha256 of "<t>.<raw body>">` |

| Operation | Route |
|---|---|
| Look a member up | `GET /public/loyalty/members/:phone` |
| Statement | `GET /public/loyalty/members/:phone/ledger` |
| Enrol | `POST /public/loyalty/members` |
| Earn on a purchase | `POST /public/loyalty/earn` |
| Redeem at checkout | `POST /public/loyalty/redeem` |
| Reverse a cancelled sale | `POST /public/loyalty/reverse` |

**Rules the website must follow:**

- Every movement needs an `idempotencyKey` of 16–120 characters, unique per
  attempt. A replay returns the **original** movement rather than debiting again.
- The website reports the **spend**, never the points. CaratOS computes what a
  purchase earns from the rate head office set.
- Put the key in **server-side** configuration. Never in browser JavaScript.
- Verify the signature on every announcement, and bound the timestamp: a valid
  HMAC with a stale `t` is a replay.
- Read `spendablePoints` (never negative) for anything a customer can spend.
  `pointsBalance` is signed and can be negative after a reversal;
  `adjustmentDebt` is that amount, and it is a debt rather than a discount.

Sandbox: point the announcement URL at a test endpoint and use a test member.
Nothing distinguishes a sandbox tenant from a live one, so use a separate
organisation.

**Status: FIXTURE-TESTED.** Inbound is driven end to end against the
application's own container. Outbound announcements have only ever been exercised
against a deliberately unreachable URL, to prove they record their own failure.

---

## 8. Production release

### Migrations

`npx prisma migrate deploy` runs as the pre-deploy command. Every migration in
this release is **additive** — new tables and new nullable or defaulted columns.
No column is dropped, renamed or retyped, so a rollback to the previous
application version runs against the new schema unchanged.

### Configuration checklist

Required before first boot: `DATABASE_URL`, `JWT_SECRET`,
`CREDENTIAL_ENCRYPTION_KEY`, `CORS_ORIGINS`.

Recommended: `META_GRAPH_API_VERSION`, `SCHEDULER_ENABLED`, `R2_*` (or
`STORAGE_PROVIDER`), `SMTP_*`, `OPS_ALERT_WEBHOOK_URL`.

Staging only: `MESSAGING_RECIPIENT_ALLOWLIST`, to stop a test message reaching a
real customer.

### Backup and rollback

Take a database backup immediately before deploying. Because every migration is
additive, rolling the application back does not require rolling the schema back.
If a migration must be undone, restore the backup — the migrations are not
written to be reversed.

### Smoke tests after deploy

1. Sign in as head office; the sidebar draws.
2. `GET /health/ready` returns ready.
3. `GET /adapters` — every channel reports a state and a reason.
4. `GET /management/kpis` returns a window and a timezone.
5. `GET /messaging-routes` lists numbers and branches.
6. Send one WhatsApp message to an allowlisted number and confirm the receipt.

### Monitoring

- `OPS_ALERT_WEBHOOK_URL` receives dead-job alerts.
- `GET /jobs` shows the queue, retries and dead letters.
- The management view surfaces dead jobs, failed scheduled reports and rejected
  import rows for the window.
