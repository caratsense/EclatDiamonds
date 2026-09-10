# Meta / WhatsApp staging test — operator checklist

For the first live test against a Meta **test** number, on **staging**. Nothing
here touches production or a real customer.

Contains no passwords, tokens or app secrets. Where a value is needed, it says
where to read it — never what it is.

---

## Before you start

| You need | Where it comes from |
|---|---|
| Meta Business portfolio admin | already done |
| Meta app (Business type) | already done |
| WhatsApp Business Account + test number | already done |
| A phone that can receive WhatsApp | yours |
| Access to the Railway dashboard | ask Shrey |

Business verification is **not** needed for this. The test number works without
it, and doing verification the same day risks a bot-behaviour flag.

---

## A. Where things live in Meta

| What | Path in the Meta dashboard |
|---|---|
| App ID / App secret | developers.facebook.com → your app → **Settings → Basic** |
| WhatsApp test number, Phone Number ID, WABA ID | your app → **WhatsApp → API Setup** |
| Recipient allowlist (up to 5 numbers) | **WhatsApp → API Setup → "To"** → Manage phone number list |
| Webhook callback | **WhatsApp → Configuration → Webhook** |
| Lead Ads webhook | **Webhooks → Page** (separate from WhatsApp) |
| Message templates | **WhatsApp Manager → Message templates** |

---

## B. Callback URLs

Staging backend: `https://backend-staging-e5cd.up.railway.app`

| Webhook | Callback URL | Verify token |
|---|---|---|
| WhatsApp Cloud | `https://backend-staging-e5cd.up.railway.app/integrations/whatsapp/webhook` | value of `WHATSAPP_WEBHOOK_VERIFY_TOKEN` |
| Meta Lead Ads | `https://backend-staging-e5cd.up.railway.app/integrations/meta/webhook` | value of `META_WEBHOOK_VERIFY_TOKEN` |

Read both values in **Railway → Eclat Diamonds → staging → backend → Variables**.
Copy them; do not retype them, and do not paste them into chat, a document or a
screenshot.

**The two tokens are different on purpose.** Using one for both webhooks would
let either Meta app authenticate as the other. If a handshake fails, check you
took the token from the matching row above before changing anything else.

## C. Fields to subscribe

| Webhook | Subscribe to |
|---|---|
| WhatsApp | `messages` (covers inbound messages *and* delivery statuses) |
| Lead Ads | `leadgen` |

---

## D. Assets to register in CaratOS

Open **Settings → Integrations → Meta assets** on the staging frontend and add:

| Kind | Value to paste | Where to find it |
|---|---|---|
| Phone number | Phone Number **ID** (not the visible number) | WhatsApp → API Setup |
| Page | Page ID | Business Settings → Accounts → Pages |
| Form | Lead form ID | Meta Forms Library |
| Ad account | numeric ad-account id, **no** `act_` prefix | Ads Manager |

Each row will show **Claimed only** until a health check confirms the token can
actually read it, then **Confirmed**. Claimed-only is not a failure; it means
nobody has proved ownership yet.

---

## E. Allowlist your phone — twice

1. **In Meta:** WhatsApp → API Setup → "To" → add your number. A test number can
   only message numbers on this list.
2. **In staging:** set `MESSAGING_RECIPIENT_ALLOWLIST` in Railway to your number
   in country-code form, e.g. `919812345678`. Several numbers go in
   comma-separated.

It currently holds a placeholder that matches nobody, so **staging can message
no one until you do step 2**. That is deliberate — an empty or unmatched list
means "nobody", never "everybody".

### E.1 Setting it from the CLI

The dashboard is the authoritative path and the one to use if you are unsure.
These commands do the same thing without a browser.

**Point the CLI at staging, and prove it.** `railway variables --set` writes to
whatever service and environment the CLI is currently linked to, and it does not
ask twice. Run the gate in §E.2 before the `--set` line, every time.

```bash
# 1. Link. Choose the Eclat Diamonds project, the STAGING environment, backend.
railway link

# 2. Show what is linked. Read the environment name out loud before continuing.
railway status

# 3. Set the allowlist. Your own number, in country-code form.
railway variables --set "MESSAGING_RECIPIENT_ALLOWLIST=+919812345678"

# 4. Read the names back. `--kv` prints values too — do not use it in a shared
#    terminal, a recording or a screen share.
railway variables
```

Several numbers go in comma-separated:
`"MESSAGING_RECIPIENT_ALLOWLIST=+919812345678,+919812345679"`.

`+`, spaces and brackets are all fine — the service normalises to digits before
matching, so `+91 98123 45678` and `919812345678` are the same entry. What is
NOT fine is a number that is not also on Meta's own "To" list from step 1: the
two lists are independent, and a number missing from either one is refused.

Changing a variable triggers a redeploy. Wait for it to finish before testing —
the old container keeps serving until it does, still holding the old allowlist.

### E.2 The gate — three checks before you change anything

Run all three. Any one of them failing means you are not where you think you
are, and you stop.

```bash
# 1. The URL answers, and it is the staging host.
curl -s -o /dev/null -w "%{http_code}\n" https://backend-staging-e5cd.up.railway.app/health
# expect: 200

# 2. It is NOT production. Production credentials must not work here — the
#    staging database is separate and starts empty.
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  -H 'Content-Type: application/json' \
  -d '{"email":"head.office@caratsense.in","password":"password123"}' \
  https://backend-staging-e5cd.up.railway.app/auth/login
# expect: 401. A 200 here means you are pointed at a database with real users.
#         STOP.

# 3. The webhook door is shut to a wrong token.
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://backend-staging-e5cd.up.railway.app/integrations/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=deliberately-wrong&hub.challenge=1"
# expect: 403
```

The second check is the one that matters. The first and third would pass against
production too.

Measured on 2026-09-11 against staging: **200 / 401 / 403**, as above.

### E.3 The telephony webhook, once it is deployed there

The inbound-call door authenticates per tenant with a token, not a signature, so
its gate is one line:

```bash
curl -s -o /dev/null -w "%{http_code}
" -X POST   -H 'Content-Type: application/json'   -H 'x-caratos-telephony-token: deliberately-wrong'   -d '{"fromNumber":"919000000001","toNumber":"919000000002","callId":"gate-check"}'   https://backend-staging-e5cd.up.railway.app/integrations/telephony/webhook
# expect: 403 once this branch is deployed to staging.
# A 404 means it is not deployed there yet, which is where staging stands today
# (measured 2026-09-11). A 200 would mean an unauthenticated write was accepted
# and is the one result that must never appear.
```

Issue the real token from **Settings → Integrations → Telephony / IVR
(inbound) → Issue webhook token**. It is shown once and only its hash is stored,
so there is nothing to read back out of the database or paste into this file.

---

## F. One inbound message

1. From your phone, WhatsApp the test number. Any text.
2. Open **Conversations** on staging.

Expected: a new thread appears within a few seconds, with your message and a
timestamp. If it does not, go to §J.

---

## G. One test lead

1. Meta Forms Library → your form → **Preview** → submit it with test data.
2. Open **CRM → Leads** on staging.

Expected: a lead appears with source **Meta Ads**, carrying whatever the form
collected. `Settings → Integrations → Lead capture failures` should stay empty.

---

## H. Where each result shows up

| You did | Look here | You should see |
|---|---|---|
| Sent an inbound WhatsApp | Conversations | the thread, with your text |
| Submitted a test lead | CRM → Leads | a lead sourced *Meta Ads* |
| Registered assets | Settings → Integrations → Meta health | per-asset Confirmed / Needs attention |
| Synchronised templates | Settings → Integrations → Templates | each template with Meta's own status |
| Replied to a customer | Settings → Integrations → Outbound messages | queued → sent → delivered |
| Anything failed | Settings → Integrations → Lead capture failures | the dead job and its reason |

## I. What the timestamps should look like

- **Inbound message**: arrives within about 5 seconds.
- **Outbound**: `queued` immediately, `sent` within about a minute (a scheduled
  job delivers it — it is not sent on the button press), `delivered` when the
  handset acknowledges.
- **Template sync**: `Last checked` within the last hour.
- A verdict older than **24 hours** blocks sending, on purpose. Press
  **Refresh from Meta** and it clears.

> `sent` means Meta accepted it. `delivered` means the phone got it. They are
> different, and the screen never shows one as the other.

---

## J. If something fails, capture this

Please capture **all four** — a screenshot alone rarely says why:

1. The screen, full window, including the error text.
2. **Settings → Integrations → Meta health** at that moment.
3. **Settings → Integrations → Lead capture failures** — the failed row expanded.
4. Railway → staging → backend → **Deploy logs**, the last ~50 lines.

Never screenshot the Variables page, and never include a verify token, an access
token or an app secret in what you send. If one appears in a log line, say so
instead of pasting it — it then needs rotating (§M).

---

## K. Test the opt-out

From your phone, WhatsApp **STOP** to the test number.

Expected:
- **CRM → Consent** shows that number as revoked, with the time.
- Trying to message it from CaratOS is refused, with a reason naming the opt-out.
- The refusal happens even with an approved template. Opting out beats everything.

## L. Confirm nothing answers after STOP

This is the part worth being careful about — an assistant that replies to someone
who just opted out is the failure that gets a number banned.

1. After sending STOP, send one more message from the same phone.
2. Watch **Conversations**: the thread updates with your message.
3. Expected: **no reply is drafted and none is sent.** No AI draft appears, and
   the outbox gains no row for that number.
4. Confirm in **Settings → Integrations → Outbound messages**: filter by the
   number; there is nothing queued after the STOP timestamp.

If anything *is* queued, stop testing and report it. That is a P0.

---

## M. Rotate the verify tokens when testing is done

Test tokens have been in a browser, a dashboard and possibly a screenshot.

1. Railway → staging → backend → Variables → set a new
   `WHATSAPP_WEBHOOK_VERIFY_TOKEN` and a new `META_WEBHOOK_VERIFY_TOKEN`
   (32+ random characters, different from each other).
2. Wait for the service to redeploy.
3. In Meta, update both webhook configurations with the new values and let each
   handshake re-verify.
4. Confirm each webhook still shows as verified in Meta.

Do the same for `CREDENTIAL_ENCRYPTION_KEY` **only** by the procedure in
`docs/INTEGRATION-OPERATIONS-RUNBOOK.md` — it is not a plain swap, and doing it
wrong makes every stored token unreadable.

---

## Known limits of this staging environment

- **No live provider has ever answered.** Everything in the product was built and
  tested against fixtures. This checklist is the first real contact.
- Outbound is blocked to everyone except `MESSAGING_RECIPIENT_ALLOWLIST`.
- The staging database starts empty. Production credentials will not log you in;
  that is the intended proof that the two are separate.
- Dead-job alerting logs but does not page anyone until `OPS_ALERT_WEBHOOK_URL`
  is set.
