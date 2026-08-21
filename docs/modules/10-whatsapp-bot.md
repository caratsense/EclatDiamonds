# WhatsApp Reporting Bot — how it works

> Internal bot for **store → head office** communication. Not customer-facing.
> Code lives in `backend/src/whatsapp-bot/`. Branch: `feat/whatsapp-bot` (PR #2).

## Why this exists

Store managers currently type their end-of-day numbers into a WhatsApp group by
hand. Head office reads them there. Nothing is captured in a system, nothing rolls
up, and a message asking HO for something is lost in the same scroll.

The bot replaces that group with a business number. Two jobs, confirmed with the
TL:

1. **Daily report** — a store files its end-of-day figures; they land in
   `DailyReport` and HO gets a notification.
2. **Store → HO message** — a store sends free text; it appears in HO's dashboard
   notification area.

**One-way by design.** HO reads everything in the dashboard; they do not reply
through the bot. Replying would mean reply routing, WhatsApp's 24-hour window,
and message threading — none of which has been asked for.

## Status

| Piece | State |
|---|---|
| Identity / number linking | ✅ done, verified on a real handset |
| Inbound ingestion + retry safety | ✅ done, survived a real outage |
| Guided daily report | ✅ done, verified end to end |
| Store → HO message | ✅ done, verified end to end |
| Frontend (any UI at all) | ❌ **not built** — link codes are issued via API only |
| Compliance grid (who hasn't reported) | ❌ not built |
| Evening nudges / reminders | ❌ not built (needs an approved Meta template) |

---

## How a message flows

```
Store manager's phone
      │  (WhatsApp)
      ▼
Meta Cloud API
      │  POST, HMAC-signed, retried for up to 7 days if we don't 200 fast
      ▼
POST /integrations/whatsapp/webhook          integrations.controller.ts
      │  1. verify signature
      │  2. store every message  -> WhatsAppEvent   (unique on Meta's `wamid`)
      │  3. return 200 immediately  (~350ms)
      │  4. kick off processing in the background (not awaited)
      ▼
WhatsAppBotService.processPending()          whatsapp-bot.service.ts
      │  claims each event with a conditional update, then routes it
      ▼
      ├── sender not linked?  -> only a code-shaped message is treated as a
      │                          link attempt; anything else is ignored
      │                          (WhatsAppIdentityService.completeLinking)
      │
      └── sender linked?      -> WhatsAppConversationService.handle()
                                 whatsapp-conversation.service.ts
                                      │
                                      ├── daily report (10 questions)
                                      │     -> DailyReport upsert + HO notification
                                      └── message to HO
                                            -> high-priority notification
```

A `@Cron` every 5 minutes (`whatsapp-bot.scheduler.ts`) re-sweeps anything the
immediate pass missed — a crash between storing and handling, or a transient
failure. It is a safety net, **not** the normal path; processing starts the moment
a message lands, because a bot that answers "how many walk-ins?" thirty seconds
later is not usable.

---

## The files

| File | What it does |
|---|---|
| `whatsapp-bot.module.ts` | Wires it together. Imports `SchedulerModule` for the sweep |
| `whatsapp-bot.service.ts` | Webhook entry (`ingest`), the store-then-process pipeline, and `route()` — the decision of what a message means |
| `whatsapp-identity.service.ts` | Link codes, binding a number to a user, resolving an inbound sender, revoking |
| `whatsapp-conversation.service.ts` | The state machine: menu, the 10-question report, the message-to-HO flow, writing `DailyReport` |
| `dsr-flow.ts` | **Pure functions.** Question list + number parsing. No DB, no WhatsApp — testable on its own |
| `whatsapp-bot.controller.ts` | Three REST endpoints (below) |
| `whatsapp-bot.scheduler.ts` | The 5-minute safety-net sweep |

Touched outside the module:
- `integrations/whatsapp.service.ts` — transport (send, HMAC verify). Pre-existing; we made `verifySignature` fail closed in production.
- `integrations/integrations.controller.ts` — the webhook now delegates to the bot.
- `users/users.service.ts` — `deactivate()` revokes WhatsApp bindings.

### REST endpoints

| Method | Path | Who | Purpose |
|---|---|---|---|
| POST | `/whatsapp/link/start` | any signed-in user | returns a one-time code to send to the bot |
| GET | `/whatsapp/identities` | store_manager+ | bound numbers inside your store scope |
| POST | `/whatsapp/identities/:id/revoke` | store_manager+ | unbind a number |

---

## Data model

```
WhatsAppLinkCode   userId, codeHash (bcrypt), expiresAt (10 min), consumedAt
WhatsAppIdentity   userId, phoneE164 (UNIQUE), status active|revoked, verifiedAt, lastSeenAt
WhatsAppEvent      wamid (UNIQUE), phoneE164, body, payload, status, attempts, processedAt
WhatsAppSession    phoneE164 (UNIQUE), userId, flow, step, draft (JSON), storeId, expiresAt (30 min)
```

Plus two changes to the existing `DailyReport`:
- `source` — `"web"` or `"whatsapp"`
- **`@@unique([storeId, reportDate])`** — one report per store per day

`phoneE164` is digits only, no `+` (e.g. `919881711034`) — this matches what Meta
sends as `from`.

---

## Decisions you need to understand before changing anything

**Numbers must prove themselves.** The bot's only credential is the phone number a
message arrives from. So a number is bound to a user only after that user enters a
one-time code issued in-app. Do not "simplify" this by trusting the `from` field —
a wrong match files one store's revenue under another store's name.

**`User.phone` is deliberately untouched.** It is not unique and OTP login matches
it with a scan over all active users. That is tolerable for OTP because the user
also needs a code; it is not tolerable when the number *is* the credential. Hence a
separate `WhatsAppIdentity` table with a real unique constraint.

**Messages are stored before they are handled.** Meta wants a 200 within seconds
and retries for up to 7 days otherwise. Handling inline means a slow reply becomes
a redelivery, and a redelivered daily report would be a second row that silently
doubles every roll-up reading it. This was validated for real: the backend went
down mid-test, Meta retried, and every message was processed with nothing lost.

**`DailyReport` upserts on `(storeId, reportDate)`.** A manager who fixes a number
and resubmits updates today's row rather than adding a second one. The unique index
is what makes that safe.

**Guided questions, not parsing a pasted block.** A misread number lands in a
revenue column and surfaces at monthly close, not in testing. Every value answers a
known question, unreadable input re-asks instead of storing a guess, and the whole
report is played back for confirmation before anything is written.

**Amounts parse the way people actually type them** — `4.5L`, `1,20,000`,
`₹75,000`, `50k`. Indian digit grouping makes comma-stripping mandatory rather than
cosmetic: `4,50,000` does not parse as a float. See `parseAmount` in `dsr-flow.ts`.

**Authorization is not reimplemented.** Store scope goes through
`StoreScopeService.assertStoreAllowed` exactly as the REST API does. The bot has no
separate permission path, and it must stay that way.

---

## Running it locally

You need four things alive at once. If any one is missing, messages silently go
nowhere.

**1. Environment** — in `backend/.env` (gitignored; ask the team lead for values):

```
WHATSAPP_PHONE_NUMBER_ID=        # the sender's numeric id from Meta
WHATSAPP_BUSINESS_ACCOUNT_ID=    # WABA id
WHATSAPP_ACCESS_TOKEN=           # permanent System User token
WHATSAPP_WEBHOOK_VERIFY_TOKEN=   # any string; must match Meta's webhook config
WHATSAPP_APP_SECRET=             # Meta app secret — verifies inbound signatures
```

Without `WHATSAPP_ACCESS_TOKEN` the bot runs in **dry-run**: it logs replies
instead of sending them. Everything looks like it works except nothing arrives.

**2. Backend**

```bash
cd backend
npx prisma migrate deploy && npx prisma generate
npm run start:dev            # localhost:4000
```

**3. A public HTTPS tunnel.** Meta cannot reach `localhost`.

```bash
ngrok http 4000
```

Production does **not** use a tunnel — the Railway deployment has a permanent URL
and Meta points straight at it. A tunnel is a development crutch only.

**4. Meta webhook config** (developers.facebook.com → the app → WhatsApp):
- Callback URL: `<your-tunnel>/integrations/whatsapp/webhook`
- Verify token: same string as `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
- Subscribe to the **`messages`** field

---

## Testing

**Without a phone** (fastest, and how most of this was built) — POST a signed
payload straight at the backend. The signature must be an HMAC-SHA256 of the exact
raw body using `WHATSAPP_APP_SECRET`:

```js
const sig = 'sha256=' + createHmac('sha256', APP_SECRET).update(body).digest('hex');
// POST to /integrations/whatsapp/webhook with header x-hub-signature-256: sig
```

Unsigned requests are rejected — that is correct behaviour, not a bug.

**With a phone:** get a link code, send it to the business number, then `hi` →
`1` → answer the ten questions → `yes`.

Worth exercising: garbage input mid-flow (must re-ask, not advance), `cancel`,
`skip` on the optional old-gold fields, resubmitting the same day (must update, not
duplicate), and messaging from an unlinked number (must be ignored silently).

---

## Gotchas that will cost you an afternoon

**The app must be Published for real messages to arrive.** While unpublished, Meta
delivers only test webhooks from the dashboard — not even from an admin's own
phone. We lost time to this.

**The WABA must be subscribed to the app.** Separate from the webhook config, and
easy to miss because the test number does it automatically. Check with:

```
GET /v21.0/{WABA_ID}/subscribed_apps
```

An empty `data: []` means Meta accepts messages and forwards them nowhere. Fix with
a `POST` to the same endpoint.

**The free ngrok URL changes on restart** unless a static domain is reserved. When
it changes, Meta's callback must be updated or everything 404s.

**Replies only work inside WhatsApp's 24-hour window**, which opens when the user
messages first. Bot-initiated messages outside it need a pre-approved template —
this is why nudges are not built yet.

**Dry-run is silent.** No token means no sends, no errors, and logs that look fine.

---

## What's next

1. **Frontend** — the real gap. There is no UI, so nobody but a developer can link
   a number; codes have to be issued through the API. Needs a settings page over
   the three existing endpoints, plus a `source` badge on reporting rows.
2. **Compliance grid** — store × 7-day view of who has and hasn't reported.
   Knowing who is missing is more useful to HO than reading who submitted.
3. **Evening nudges** — the scheduler already exists, so this is small, but the
   Meta template needs submitting first (1–3 day approval).
