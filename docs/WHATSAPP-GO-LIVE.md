# WhatsApp go-live checklist (OTP login · DSR · referral wallet)

> Everything is code-complete and runs in **dry-run mode** today (messages are
> logged server-side instead of sent; OTP codes appear in the Railway deploy
> logs as `[OTP dry-run] phone=... code=...`). The day the client provides the
> three items below, set three env vars and all WhatsApp features go live at
> once. No code changes needed.

## What the client must provide (one-time)
1. **A dedicated phone number** (new SIM in the business name). This number
   becomes API-only — it can NOT be used in the WhatsApp phone app afterwards.
   Do not use the owner's personal number.
2. **Meta Business Manager verification** — business.facebook.com account +
   GST certificate / business documents. Verification takes ~2–5 working days.
3. **A Facebook page** for the business (helps verification).

## Setup steps (whoever operates it)
1. In Meta Business Manager → WhatsApp → add the dedicated number to the
   **WhatsApp Business Platform (Cloud API)**.
2. Create and submit these message templates for approval (~1–2 days):
   - `eclat_otp` (category **Authentication**): "Your Eclat sign-in code is
     {{1}}. It expires in 5 minutes. Do not share it."
   - `eclat_dsr` (category **Utility**): the daily store-close report body.
   - `eclat_wallet` (category **Utility**, document): referral wallet statement.
3. From Meta's API setup screen copy: **Phone number ID**, **WABA ID**, and a
   **permanent access token** (System User token, `whatsapp_business_messaging`
   scope).

## Switch it on (Railway → backend service → Variables)
```
WHATSAPP_ACCESS_TOKEN=<permanent access token>
WHATSAPP_PHONE_NUMBER_ID=<phone number id>
```
`WhatsAppService` goes live the moment BOTH are set (until then it dry-runs).
Optional: `WHATSAPP_APP_SECRET` (webhook signature verification),
`WHATSAPP_API_VERSION` (default v21.0). Redeploy after setting.

## What lights up, immediately
| Feature | Where | Behaviour once live |
|---|---|---|
| **OTP login** | Login page → "WhatsApp OTP" tab | 6-digit code delivered on WhatsApp; 5-min expiry, 3 attempts, 60s resend cooldown, 5/hour cap |
| **DSR delivery** | Reporting → Daily Report → Send | Store-close report sent to the owner's / area manager's numbers (individual numbers — the API cannot post to groups) |
| **Referral wallet** | Loyalty → wallet dialog → Share | Wallet statement sent from the official business number |

## Running costs (India, approximate)
- Authentication message ≈ ₹0.115 · Utility message ≈ ₹0.125
- Expected: OTP ~₹100/month (30 staff daily) + DSR ~₹30–50/month + referral
  negligible → **~₹150–250/month total**.

## Until then (already working today)
- OTP login works in **test mode**: request a code → an administrator reads it
  from the Railway deploy logs (`[OTP dry-run]`).
- Password login remains available; managers can reset any in-scope user's
  password from Store Setup.
- DSR and wallet sends return `{sent:false, disabled:true, preview}` — the UI
  shows the preview and offers copy-to-clipboard for manual WhatsApp sending.
