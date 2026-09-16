# WhatsApp Reporting Bot — Onboarding Guide

> For anyone joining work on the bot. Read this top to bottom once; after that,
> the code map in §4 is the part you'll come back to.
> State as of 2026-08-21 — branch `feat/whatsapp-bot`, PR #2.

## 1. What this is (and is not)

An **internal** bot on the WhatsApp Business Cloud API for **store → head office**
communication. It is *not* customer-facing and must never talk to anyone whose
number is not explicitly linked to a CaratSense user.

Two functions, decided with the team lead:

1. **Daily report** — a store manager files their end-of-day numbers (walk-ins,
   enquiries, sales, payment split, old gold) through a guided 10-question chat.
   The result is a `DailyReport` row, the same table the web form writes.
2. **Message to Head Office** — free text that lands in the HO dashboard's
   notification bell. **One-way**: HO reads it in the dashboard and does not
   reply through the bot.

Why a bot at all: managers already type this exact report into a WhatsApp group
every evening. The bot captures it into the system instead of chat scrollback.
(The Cloud API cannot read groups, so "just parse the group" was never an option.)

## 2. How a message flows

```
Store manager's phone
   │  WhatsApp message to the business number
   ▼
Meta Cloud API
   │  POST /integrations/whatsapp/webhook  (HMAC-signed; Meta retries up to ~7 days)
   ▼
IntegrationsController.receiveWhatsApp        integrations.controller.ts
   │  1. verifySignature(rawBody)  — fails CLOSED in production
   │  2. WhatsAppBotService.ingest() — store in WhatsAppEvent, ack 200 in ~350ms
   │  3. processing continues OFF the request
   ▼
WhatsAppBotService.route()                    whatsapp-bot.service.ts
   │  resolve sender → WhatsAppIdentity → User
   │  ├─ unknown number + code-shaped text → complete linking
   │  ├─ unknown number otherwise          → ignore (no reply, no enumeration)
   │  └─ known user → WhatsAppConversationService.handle()
   ▼
WhatsAppConversationService                   whatsapp-conversation.service.ts
   │  session state machine: idle / dsr / dsr_confirm / message
   │  ├─ DSR: ask → parse → …×10 → summary → YES → upsert DailyReport
   │  └─ message: → NotificationsService.emit() to every HO user
   ▼
reply goes back via WhatsAppService.sendText()
```

The two design rules that everything hangs off:

- **Persist-then-200.** Meta expects a fast 200 and *retries for days* when it
  doesn't get one. If we processed inline, a slow reply would become a
  redelivery, and a redelivered daily report would be a second row silently
  doubling every roll-up. So the webhook writes the raw message to
  `WhatsAppEvent` (unique on Meta's `wamid` — a retry collides and is dropped)
  and acks immediately. This was validated for real: the backend died mid-test,
  Meta retried, every message was processed once.
- **The phone number alone is never identity.** The only credential an inbound
  message carries is its `from` number. A number maps to a user *only* through a
  verified `WhatsAppIdentity` row, created when the user proves control of the
  number (§5). `User.phone` is deliberately not used — it's non-unique and the
  OTP login scan-matches it, which is fine when a code is also required, fatal
  when the number is the whole credential.

## 3. Data model (4 new tables + 2 changes)

All in `backend/prisma/schema.prisma`; migrations `20260820120000_whatsapp_identity`,
`20260821120000_whatsapp_event`, `20260821130000_whatsapp_session_dsr_source`.

| Model | What it is |
|---|---|
| `WhatsAppIdentity` | Verified number↔user binding. `phoneE164` unique (digits, no `+`, e.g. `919876543210`). `status: active \| revoked`. The **only** path from a sender to a user |
| `WhatsAppLinkCode` | One-time linking code. bcrypt hash only, 10-min TTL, single-use. Mirrors the `LoginOtp` pattern |
| `WhatsAppEvent` | Every inbound message, raw. `wamid` unique = idempotency key. `status: received → processing → processed \| ignored \| failed`, max 3 attempts. Doubles as the audit/message log |
| `WhatsAppSession` | Conversation state per number: `flow` (`idle`/`pick_store`/`dsr`/`dsr_confirm`/`message`), `step`, `draft` (answers so far, plus the reserved `_reportDate` key holding the day being filed for), 30-min expiry so an abandoned half-report never resurfaces as today's |

Changes to existing tables:

- `DailyReport.source` — `web` (form) or `whatsapp` (bot), so HO can tell channels apart.
- `DailyReport` **unique on `(storeId, reportDate)`** and the write is an upsert.
  A manager resubmitting (or a webhook retry) *updates* the day instead of
  adding a row. We checked for existing duplicates before adding the index.

## 4. Code map — `backend/src/whatsapp-bot/`

| File | Role |
|---|---|
| `whatsapp-bot.module.ts` | Wiring. Imported by `IntegrationsModule` (webhook) and `UsersModule` (revoke-on-deactivate) |
| `whatsapp-bot.service.ts` | The pipeline: `ingest()` (persist + ack), `processPending()` (claim + process, retries), `route()` (who is this, what do they mean) |
| `whatsapp-identity.service.ts` | Linking (`startLinking` / `completeLinking`), `resolveActiveUser`, list/revoke, `revokeForUser` (called on user deactivation) |
| `whatsapp-conversation.service.ts` | The state machine: menu, guided DSR, confirmation, store→HO message, session load/save |
| `dsr-flow.ts` | **Pure functions, no DB/WhatsApp** — the 10 questions, the Indian-format number parsers, the report-date parser (`today`/`yesterday`/`21-08`), prompt + summary rendering. Start here to understand the DSR, and test it here: no infrastructure needed |
| `whatsapp-bot.scheduler.ts` | `@Cron` sweep every 5 min → `processPending()` via `JobRunnerService.runOnce` (replica-safe) |
| `whatsapp-bot.controller.ts` | REST: `POST /whatsapp/link/start` (any user, for self), `GET /whatsapp/identities` + `POST /whatsapp/identities/:id/revoke` (manager+, store-scoped) |

Touchpoints outside the folder:

- `integrations/whatsapp.service.ts` — transport only: `sendText`, `sendTemplate`,
  `verifyWebhook` (GET handshake), `verifySignature` (HMAC, **fails closed in prod**).
  Dry-runs (logs instead of sending) until `WHATSAPP_ACCESS_TOKEN` +
  `WHATSAPP_PHONE_NUMBER_ID` are set.
- `integrations/integrations.controller.ts` — the `@Public()` webhook endpoints.
- `users/users.service.ts` `deactivate()` — also revokes WhatsApp bindings.
- Reused wholesale: `StoreScopeService` (ALL authorization — the bot has no
  authorization logic of its own), `NotificationsService` (HO delivery, dedupe
  keys), `AuditService`, `JobRunnerService`.

## 5. The linking flow (identity)

1. Signed-in user calls `POST /whatsapp/link/start` → gets an 8-char code
   (unambiguous alphabet, no 0/O/1/I) valid 10 minutes. *(No frontend for this
   yet — see §9.)*
2. User sends that code to the bot **from the number they want to bind**.
3. Bot matches the code (bcrypt compare over unconsumed codes), binds
   `phoneE164 → userId`, consumes the code, replies "Linked as <name>".
4. Edge rules: a number already bound to someone else is refused ("phone_taken");
   re-linking your own number is idempotent; deactivating a user revokes all
   their bindings; revoked numbers go back to being strangers.

Strangers (unknown numbers) sending anything that is *not* code-shaped are
ignored entirely — no reply, so a wrong-number can't probe or get spammed.

## 6. The conversation

Commands work anywhere: `hi`/`menu` (menu + reset), `cancel`/`stop` (discard).

**Menu** → `1` daily report, `2` message HO.

**Daily report** (guided — bot asks, user answers, one field at a time):
10 questions in the order the report is read out at close: walk-ins, serious
enquiries, delivered & billed, new bookings, advance received, cash, card, UPI,
old gold grams, old gold value. Required fields accept `0`; the two old-gold
ones accept `skip` (stored as null). Unreadable input **re-asks** — never stores
a guess. Then a full summary is played back; only `YES` writes the row.

**Which store, and which day.** Both are chosen explicitly rather than inferred,
because getting either wrong writes real numbers onto the wrong row and nothing
looks broken afterwards:
- A user attached to **more than one branch is asked which**, before the
  questions start. Single-store users are not prompted.
- The date defaults to the store's today, and the confirmation step accepts
  **`DATE 20/08`** to change it — for the manager who files Friday's numbers on
  Saturday morning. Backdating is capped at `MAX_BACKDATE_DAYS` (14) and future
  dates are refused.

The parser (`dsr-flow.ts`) accepts what people actually type: `4.5L`,
`1,20,000`, `₹75,000`, `50k`, `1.2cr`. Indian digit grouping (2,2,3) is why
comma-stripping is mandatory — `4,50,000` is not a float.

On submit: upsert `DailyReport` (store-scope checked via `StoreScopeService`,
exactly like the REST API), audit row, notification to every HO user with a
per-day dedupe key (resubmission refreshes the bell instead of stacking).

**Message to HO**: whatever the user types next fans out to all HO users as a
high-priority notification titled "Message from <store>". One-way; session
resets after send.

## 7. Environment & Meta setup

`backend/.env` (gitignored; see `.env.example`):

```
WHATSAPP_PHONE_NUMBER_ID      # the sending number's id (Meta → API Setup)
WHATSAPP_BUSINESS_ACCOUNT_ID  # the WABA id
WHATSAPP_ACCESS_TOKEN         # System User token (permanent). NOT the 24h console token
WHATSAPP_WEBHOOK_VERIFY_TOKEN # arbitrary string, must match Meta's webhook config
WHATSAPP_APP_SECRET           # Meta app secret — inbound HMAC verification
WHATSAPP_BOT_NUMBER           # display-only, shown to users when linking
```

Meta-side state (already done, documented so you know where things live):

- Meta app **"Éclat Diamonds"** (Business type), **published** — required for
  real-phone inbound; unpublished apps only receive dashboard test events.
- Webhook: callback = `<public-https>/integrations/whatsapp/webhook`, verify
  token as above, subscribed to the **`messages`** field.
- **The WABA must be subscribed to the app** (`POST /{waba-id}/subscribed_apps`).
  This is the step everyone misses: without it Meta accepts messages and simply
  never forwards them. If inbound is mysteriously silent, check
  `GET /{waba-id}/subscribed_apps` first.

**Local dev loop:** backend on `:4000` + an ngrok tunnel with the reserved
domain, e.g. `ngrok http 4000 --url=<reserved>.ngrok-free.dev`. If the tunnel or
backend is down, Meta queues and retries — you'll see ngrok 502s, then a burst
of deliveries when it's back; idempotency makes that safe.
**Production:** no tunnel. Point Meta's callback at the Railway URL.

## 8. Testing without a phone

Signature verification means every test POST must be HMAC-signed. The pattern
(see the scripts in the PR history): build the Meta payload shape
`{entry:[{changes:[{value:{messages:[{from, id, type, text:{body}}]}}]}]}`,
sign the exact body with `sha256=HMAC(app_secret, body)` in
`x-hub-signature-256`, POST to the webhook. Unique `id` (wamid) per message —
reusing one tests the dedupe path.

`dsr-flow.ts` is pure — parser edge cases (`4.5L`, `1,20,000`, garbage, `skip`)
can be unit-tested with no infrastructure at all.

## 9. Current status & what's left

**The bot's behaviour is complete and verified from a real handset**: linking,
the guided report (every number format), store→HO messages, correct store and
date selection, retry-safety under a real outage, fail-closed signatures, and
revoke-on-deactivate. The compliance API behind the HO view is built too.

What that does **not** mean is "shipped". The bot only reaches the outside world
through a tunnel on a developer's laptop right now — see item 1.

### Left to do

**1. Production webhook — off ngrok, onto Railway.** The single thing between
"works" and "live". The backend already deploys to Railway and has a permanent
HTTPS URL; point Meta's callback at
`https://<service>.up.railway.app/integrations/whatsapp/webhook`, set the
`WHATSAPP_*` variables there, and no tunnel is involved again. Until this is
done the bot is only alive while someone's laptop is.

**2. Evening nudges.** Remind branches that have not filed. The scheduler and
the compliance query it needs both exist, so the code is small.
⚠️ **Two external gates, not one:** the template `eclat_dsr_reminder` must be
approved (submitted 2026-08-21), *and* the WABA needs a payment method —
business-initiated messages are billed, and "Add payment to send
business-initiated messages" is still unchecked in Meta's Production setup.
Replies inside the 24h window stay free, which is why everything else works
today with no payment configured. Build it against the template shape in the
plan doc; it will simply fail to send until both gates clear.

**3. Retention + cleanup cron.** `WhatsAppEvent` stores full message bodies —
customer names, phone numbers — and nothing ever deletes them. `WhatsAppSession`
rows accumulate the same way (they expire logically, but are never removed). A
job that purges event bodies after ~90 days and clears expired sessions.
`JobRunnerService.runOnce` is the pattern; the existing 5-minute sweep in
`whatsapp-bot.scheduler.ts` is the template.

**4. Webhook throttle exemption.** The global limit is 300 requests/60s per IP,
and all of Meta's traffic arrives from their range. A burst can get throttled;
Meta retries so nothing is lost, but it stalls delivery for no reason. Give the
webhook route its own limit or `@SkipThrottle()`.

### Frontend (assigned separately)

- **WhatsApp settings page** — request a link code, list bound numbers, revoke
  one. All three endpoints exist (§4); nothing else is needed from the backend.
  Until this ships, linking a number requires an API call by hand.
- **Compliance grid** — `GET /reporting/compliance?days=7` already returns
  exactly what a store × day heatmap needs: per-store `entries[]` with
  `{date, submitted, source, submittedBy, reportId}`, plus `missingToday`. The
  notification bell already carries a `dsr_missing` item.
- **`source` badge** on reporting rows, so HO can see which reports came in over
  WhatsApp.

## 10. Gotchas that will bite you

- **24-hour window**: the bot can free-text a user only within 24h of *their*
  last message. Replies to an active conversation are always fine; anything
  bot-initiated later needs an approved template.
- **The console "Generate token" token expires in ~24h.** Use a System User
  token (Business Settings → System Users) or sends silently start failing.
- **Rotating the app secret** invalidates every signed request instantly —
  update `.env` and restart in the same breath.
- **ngrok free tier**: one reserved domain per account; the URL in Meta's
  webhook config must match whatever the tunnel is actually serving.
- **`Prisma.DbNull`** (not JS `null`) to clear the session `draft` Json column.
- **Never reply to unknown numbers** except to a valid link code. This is a
  deliberate anti-enumeration rule, not an oversight.
- Store-scope checks belong to `StoreScopeService` — if you find yourself
  writing an authorization check inside the bot, stop; that's the wrong layer.
