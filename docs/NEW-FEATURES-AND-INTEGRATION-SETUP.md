# CaratOS MVP — New Features and External System Setup

**Created:** 2026-09-07  
**Purpose:** Single implementation and setup checklist for the competitor-CRM enhancements, attendance refinement, and AI catalogue refinement.  
**Related:** `COMPETITOR-CRM-ENHANCEMENT-REVIEW.md`, `CARATOS_ARCHITECTURE.md`, `DECISIONS.md`, `modules/06-hrms.md`.

## 1. Scope and status definitions

This document targets **functional workflow parity**, not copying another company's private code, branding, or interface.

Status meanings:

- **Existing:** working code is already present in CaratOS.
- **Internal:** the CaratOS logic/UI exists, but a live external provider is not connected.
- **Build:** product code is still required.
- **Connect:** provider account, credentials, webhook or production infrastructure is required.
- **Later:** outside the immediate MVP delivery boundary.

## 2. Exact new feature list

### 2.1 Meta, CTWA and lead ingestion

| Feature | Current state | Required work | MVP priority |
|---|---|---|---:|
| Click-to-WhatsApp lead capture | WhatsApp messages can become CRM conversations | Parse CTWA referral/click data, identify the ad, resolve/create customer and lead, and record measured attribution | P0 |
| Meta Lead Ads ingestion | Import/custom-field foundations exist | Add signed/idempotent `leadgen` webhook processing and fetch submitted form data by lead ID | P0 |
| Meta form-field mapping | Custom lead/party attributes exist | Admin mapping from Meta question IDs/names to CaratOS fields; preserve unknown answers in raw payload | P0 |
| Campaign/ad-set/ad identity | Attribution columns exist | Persist external campaign, ad-set, ad, form and click IDs from Meta | P0 |
| Meta ad metadata lookup | Provider is registered as unavailable | Connect Marketing API and resolve ad → ad set → campaign without hardcoded names | P0 |
| Meta spend ingestion | ROAS calculation exists | Periodically import spend by campaign/ad set/date from Ads Insights | P1 |
| Webhook replay protection | Generic webhook/idempotency foundations exist | Apply provider event/lead/message IDs to every Meta ingestion route and add replay tests | P0 |

### 2.2 Lead routing and AI control

| Feature | Current state | Required work | MVP priority |
|---|---|---|---:|
| Ad-set routing rules | **Internal implementation exists** | Connect actual Meta metadata to the normalized routing context | P0 |
| Store/organisation queue routing | **Internal implementation exists** | Show matched rule and route in the inbox; verify with live payload | P0 |
| Named user assignment | Backend support exists | Add optional assignee selection to admin UI and validate store membership | P0 |
| Per-rule `AI first`/`Human only` | **Internal implementation exists** | Enforce in the automatic-reply path and verify human-only campaigns never call AI | P0 |
| Rule priority | **Existing in new engine** | Add conflict preview/test in UI | P1 |
| Safe unmatched queue | **Existing in new engine** | Add an admin inbox filter for unmatched/unassigned traffic | P0 |
| Round-robin/workload assignment | Missing | Add only after store routing works; use active, eligible store users and auditable assignment | P1 |

### 2.3 CRM AI conversation and qualification

| Feature | Current state | Required work | MVP priority |
|---|---|---|---:|
| Explainable intent score | Existing | Trigger automatically after sufficient inbound evidence when the matched rule allows AI | P0 |
| Suggested next action | Existing | Display consistently in lead and inbox detail | P0 |
| Requirement extraction | Existing foundation | Extract only stated budget, product, occasion, timeline and visit intent into tenant fields | P0 |
| Suggested reply | Missing | Generate a draft separately from delivery; human can approve/edit | P0 |
| Automatic AI reply | Missing | Controlled feature flag, WhatsApp policy checks, opt-out handling, escalation and honest delivery status | P1 |
| Human handoff | Existing foundation | Automate on complaints, opt-outs, model/provider errors, configured signals and score threshold | P0 |
| AI conversation audit | Messages distinguish AI/human | Record model, prompt/policy version, reason, delivery result and takeover | P0 |
| Customer segmentation | Missing | Tenant-defined VIP/loyal/one-time/dormant rules with explainable membership | P1 |
| Lead-aging dashboard | Follow-up timestamps exist | Add untouched/overdue/returning-lead cohorts and store filters | P1 |

The AI must not invent product availability, price, purity, certification, discount, delivery date, offer or policy. Automatic replies remain **off by default** until a tenant explicitly enables them.

### 2.4 Omnichannel marketing and customer engagement

| Feature | Current state | Required work | MVP priority |
|---|---|---|---:|
| Campaign planning | Existing | Preserve current workflow | P0 |
| WhatsApp template send | Individual integration exists | Add reusable template library, audience preview, consent checks, job queue, retries and delivery report | P1 |
| Email campaigns | SMTP supports individual reports | Add bulk campaign orchestration and delivery/failure report | P1 |
| SMS campaigns | Missing | Select Indian provider and complete DLT/template setup | Later |
| RCS campaigns | Missing | Select an approved RCS provider and implement provider adapter | Later |
| Human calling tasks | Task system exists | Generate store/user call tasks from a campaign audience | P1 |
| Feedback/star ratings | Missing | Add feedback request, response model and customer timeline entry | P1 |
| Google Reviews aggregation | Missing | Connect approved Google Business Profile access and location mapping | Later |

### 2.5 Customer 360, showroom and mobile PWA

| Feature | Current state | Required work | MVP priority |
|---|---|---|---:|
| Phone/WhatsApp customer recognition | Existing | Verify normalized identity across Meta, WhatsApp, check-in and sale | P0 |
| Online-to-store history | Customer timeline exists | Surface originating campaign/ad and prior conversations on showroom lookup | P0 |
| Manual/Bluetooth barcode input | Existing | Preserve and test on showroom hardware | P0 |
| Camera barcode/QR scanning | Missing | Add browser camera scanner with permission/error/manual fallback | P1 |
| Product-interest journey | Existing foundation | Show viewed/shown/tried/shortlisted/quoted/rejected/purchased sequence in Customer 360 | P0 |
| Installable showroom app | PWA exists | Verify manifest, service worker, offline shell and phone/tablet layouts | P0 |
| Native iOS/Android app | Missing | Not required for MVP unless separately approved | Later |

### 2.6 ROAS and attribution

| Feature | Current state | Required work | MVP priority |
|---|---|---|---:|
| Measured vs declared attribution | Existing | Preserve strict separation | P0 |
| Website conversion attribution | Partial | Connect website customer/click/order identifiers | P1 |
| Showroom walk-in attribution | Partial | Define attribution window and connect check-in/customer/ad history | P1 |
| Store-sale attribution | Existing foundation | Credit eligible preceding measured touch using stated first/last-touch model | P1 |
| Campaign ROAS | Calculation exists | Connect real Meta spend and measured revenue; never blend declared revenue into measured ROAS | P1 |
| Return/cancellation adjustment | Missing | Define whether net revenue excludes returns/cancellations and implement consistently | P1 |

### 2.7 Loyalty and reviews

| Feature | Current state | Required work | MVP priority |
|---|---|---|---:|
| Savings plans/members/installments | Existing | Regression test only | P0 |
| Referral codes/wallet/payouts | Existing | Regression test only | P0 |
| Digital points ledger | Partial | Add earn/redeem/expire transaction rules if points are approved as a separate programme | P1 |
| Website reward redemption | Missing | Authenticated customer redemption API and website connection | P1 |
| Feedback-to-review journey | Missing | Ask for private feedback first; link eligible customers to the correct public business location | Later |

## 3. Attendance-system refinement

Attendance does **not require an AI model** for the MVP. It should remain a deterministic, auditable rules system.

### Required product changes

- Server timestamp is authoritative; device timestamp is supporting evidence.
- Capture latitude, longitude, reported GPS accuracy, store, distance and verification status only during punch actions.
- Idempotent check-in/out to protect against mobile retries and double taps.
- Reject two open sessions, checkout without check-in, and impossible sequences.
- Correct overnight shifts, timezone boundaries, grace periods, week-offs, holidays, approved leave and missed checkout.
- Offline punch must be labelled pending until server-confirmed.
- Manager regularization requires reason, original values, changed values, manager and timestamp.
- Salespeople cannot approve their own regularization.
- Reports: present, late, absent, leave, week-off, duration, missing checkout and unverified/off-site punches.
- Do not continuously track employees and do not claim spoof-proof attendance.

### Systems required

| System | Required? | Setup |
|---|---:|---|
| Browser/PWA geolocation | Yes | Served over HTTPS; users grant location permission |
| Store coordinates/geofence | Yes | Configure accurate latitude, longitude and allowed radius for every active store |
| PostgreSQL | Existing | Store punch, evidence, shift and audit data |
| Background jobs | Existing | Reminders/missing-checkout processing if enabled |
| Google Maps API | No | Optional only for map/address display; distance calculation does not require it |
| Face recognition/biometrics | No | Explicitly excluded from MVP unless legal/privacy scope is separately approved |

## 4. AI catalogue refinement

### Required product changes

- Photo/import → validated image → catalogue draft → AI suggestions → human review → approved product → embedding job → visual search.
- AI suggestions are drafts, never authoritative facts.
- Add/confirm `draft`, `needs_review`, `approved`, `rejected` states.
- Record model/provider/version, preprocessing version, confidence, reviewer and corrections.
- Validate file content/MIME, size, dimensions and corruption; do not trust extension alone.
- Keep image storage tenant-isolated.
- Embedding jobs are idempotent on image hash + model/preprocessing version.
- Failed re-index must never destroy the last working embedding.
- UI distinguishes matches, no close match, model unavailable, search failure and embedding pending.
- Preserve relevance feedback for calibration.

### Models required

| Purpose | Model | Setup decision |
|---|---|---|
| Shape/geometry similarity | `facebook/dinov2-base` | **Use for MVP:** ungated and Apache-2.0 |
| Semantic/style similarity | `google/siglip2-base-patch16-224` | Use for MVP; ungated and Apache-2.0 |
| Optional upgrade | `facebook/dinov3-vitb16-pretrain-lvd1689m` | Do not make MVP-dependent; requires gated Hugging Face access, `HF_TOKEN`, licence review and full re-index |
| Catalogue metadata suggestions | Anthropic Claude | Use the same Anthropic account; make the model configurable and require human approval |

Correct inference configuration:

```env
DINO_MODEL_ID=facebook/dinov2-base
SIGLIP_MODEL_ID=google/siglip2-base-patch16-224
MODEL_CACHE_DIR=/models
INFERENCE_API_KEY=<long-random-secret>
```

Backend connection:

```env
ML_INFERENCE_URL=https://<inference-service-domain>
ML_INFERENCE_KEY=<same-value-as-INFERENCE_API_KEY>
```

Inference hosting needs a persistent model cache volume. CPU is acceptable for an MVP; allow enough memory for both models and runtime overhead. Start with one worker and measure before scaling.

## 5. Accounts, systems and connections to set up

### 5.1 Meta Business Platform

Owner must create/provide:

- Verified Meta Business Portfolio.
- Meta Developer account and business app.
- WhatsApp Business Account ID.
- Dedicated WhatsApp business phone number and Phone Number ID.
- Facebook Page and Page ID.
- Ad Account ID (`act_...`).
- Permanent system-user access token assigned only to required assets.
- Meta App ID and App Secret.
- Approved webhook callback domain over HTTPS.
- Approved WhatsApp message templates.
- Sanitized real CTWA and Lead Ads webhook payloads for tests.

WhatsApp permissions:

```text
whatsapp_business_management
whatsapp_business_messaging
business_management            # only where business-asset access requires it
```

Lead Ads/Marketing permissions to confirm during App Review:

```text
leads_retrieval
pages_show_list
pages_read_engagement
pages_manage_ads
ads_read
business_management
ads_management                 # only if required by the chosen lead/asset flow
```

Request the minimum permissions actually used. SaaS access to client-owned assets may require Business Verification, Advanced Access, App Review evidence, privacy-policy URL, data-deletion instructions and a reviewer screencast.

Backend environment:

```env
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_BUSINESS_ACCOUNT_ID=
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_WEBHOOK_VERIFY_TOKEN=
WHATSAPP_APP_SECRET=
WHATSAPP_BOT_NUMBER=
WHATSAPP_PLATFORM_ORGANISATION_ID=
```

Current WhatsApp callback:

```text
GET/POST https://<api-domain>/integrations/whatsapp/webhook
```

The Lead Ads callback may use a separate provider-specific route. Claude Code must not overload the WhatsApp route with a different signature/payload contract.

### 5.2 Anthropic CRM/catalogue AI

Create an Anthropic API account, enable billing and create a server-side API key.

Current CRM configuration:

```env
CRM_AI_API_KEY=
CRM_AI_PROVIDER=anthropic
CRM_AI_MODEL=claude-sonnet-5
```

Current optional image metadata enrichment uses:

```env
ANTHROPIC_API_KEY=
```

Recommended architecture:

- Sonnet: customer-facing reply draft and complex conversation handling.
- Smaller/cheaper active model: high-volume structured signal extraction after evaluation.
- Vision embeddings remain DINO/SigLIP; do not use an LLM to replace visual nearest-neighbour search.
- Keep model IDs configurable because providers retire models.

Never expose either API key to the browser.

### 5.3 Image/object storage

Recommended existing path: Cloudflare R2.

```env
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=eclat-jewellery-images
R2_PUBLIC_BASE_URL=https://images.<domain>
```

Required setup:

- Private write credentials for backend only.
- Read/CDN policy appropriate for product images.
- CORS limited to approved frontend domains.
- Tenant-aware object keys.
- Upload size/type limits.
- Retention and backup decision.

### 5.4 Credential encryption

Required before tenant credentials are stored:

```env
CREDENTIAL_ENCRYPTION_KEY=<32-byte-key-as-base64>
CREDENTIAL_ENCRYPTION_KEY_VERSION=1
CREDENTIAL_ENCRYPTION_KEY_PREVIOUS=
```

Store the key only in the deployment secret manager. Never commit it, paste it into documentation, or send it through chat.

`CREDENTIAL_ENCRYPTION_KEY_VERSION` must be a positive integer. For rotation,
keep the former active key temporarily in `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS`,
install a new active key, increment the version, and deploy both values together.
Then call `POST /integrations-registry/credentials/rewrap` as a head-office user
for every tenant that stores credentials. A successful response must report
`complete: true` and `failed: 0`. Remove the previous key only after every tenant
has completed and all application instances have the new configuration. Keep a
recoverable secret-manager version until the rollback window closes. The API
never returns plaintext credentials.

### 5.5 Database and vector search

| Component | MVP decision |
|---|---|
| PostgreSQL | Existing primary database; deploy all additive migrations before application rollout |
| Postgres job queue | Existing; continue for imports/embedding/provider jobs |
| pgvector | Optional for small MVP catalogue; required before catalogue size makes in-process scanning slow |
| Backups | Required before production migration; configure and drill restore |
| RLS | Policies exist but must not be considered active protection until runtime-role tests prove enforcement |

### 5.6 Public hosting and domains

Required connections:

- Frontend domain over HTTPS.
- Backend/API domain over HTTPS.
- Inference-service domain protected by bearer key.
- Image/CDN domain.
- Meta webhook points to the backend domain.
- CORS allow-list contains only the deployed frontend domains.
- Health checks for backend, database and inference service.
- Logs must redact tokens, phone numbers where appropriate, message contents where unnecessary, and credential payloads.

### 5.7 Email

Existing email integration requires:

```env
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
```

Before bulk email, additionally define unsubscribe, consent, bounce handling, sender-domain SPF/DKIM/DMARC and delivery reporting.

### 5.8 Payments and gold rate

Not part of the competitor CRM enhancement, but existing workflows need these to go live:

```env
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=

GOLD_RATE_API_URL=
GOLD_RATE_API_KEY=
```

Payment webhook signature verification and idempotency are mandatory. The business owner must approve the gold-rate source of truth.

### 5.9 IVR/call recording — later integration

Choose one provider, for example Exotel or Tata Tele. Before coding, obtain:

- API key/token and account/subdomain identifiers.
- Outbound call API documentation.
- Call-status and recording webhooks.
- Test numbers and production caller IDs.
- Recording availability/expiry behavior.
- Consent wording and jurisdictional legal approval.
- Retention, access and deletion policy.

Do not store call recordings until consent, access control and retention are decided.

### 5.10 SMS/RCS — later integration

For India, choose provider and arrange:

- DLT entity/header/template registration where applicable.
- API credentials.
- Approved templates.
- Delivery receipts/webhooks.
- Opt-out and consent policy.
- RCS agent/brand approval if RCS is selected.

### 5.11 Google Reviews — later integration

Required before implementation:

- Google Cloud project.
- OAuth consent configuration.
- Approved Google Business Profile access.
- Verified business-location IDs mapped to CaratOS stores.
- OAuth token storage/rotation.
- Product decision on private feedback versus public-review redirection.

## 6. Information the owner/client must provide

### Routing sheet

Provide one approved row per rule:

| Rule name | Match field | Match value | Destination store | Assignee or queue | Handling | Priority |
|---|---|---|---|---|---|---:|
| Hyderabad retail | Ad-set name | Hyderabad Retail | Hyderabad | Store queue | AI first | 100 |
| Franchise | Tag/ad-set name | Franchise | Head Office | Business owner | Human only | 200 |

### Business decisions

- Which campaigns allow AI?
- Does AI send automatically or produce drafts for approval during MVP?
- Exact qualification questions and handoff triggers.
- Store opening hours and overnight behavior.
- Consent and opt-out wording.
- ROAS attribution window and first/last-touch reporting model.
- Treatment of returns/cancellations in revenue.
- Customer segments and exact thresholds.
- Attendance geofence radius per store.
- Shift, grace-period, overtime, holiday and regularization policies.
- Catalogue approval roles and mandatory product fields.
- Approved image retention and visibility policy.

### Test data

- Sanitized CTWA inbound webhook.
- Sanitized Meta Lead Ads `leadgen` webhook and retrieved lead response.
- Campaign/ad-set/ad/form identifiers from a test campaign.
- At least 20 positive, negative, ambiguous and opt-out conversations.
- At least 100 labelled jewellery image pairs for search calibration.
- Attendance cases including overnight shifts, missed checkout, leave, week-off and weak GPS accuracy.

## 7. Recommended setup order

1. Create verified Meta Business assets and developer app.
2. Deploy backend on a stable HTTPS domain.
3. Configure WhatsApp number, token, signature secret and webhook.
4. Verify inbound/outbound WhatsApp using test templates.
5. Connect Facebook Page, Lead Ads and Marketing API permissions.
6. Capture real sanitized CTWA/leadgen payloads.
7. Configure the first routing sheet in CaratOS.
8. Create Anthropic API key and enable CRM qualification/reply-draft testing.
9. Create R2 bucket and connect product-image storage.
10. Deploy inference service with DINOv2 + SigLIP 2 and persistent cache.
11. Index a labelled test catalogue and calibrate similarity thresholds.
12. Configure every store's coordinates, radius, timezone, shifts and week-offs.
13. Rehearse current migrations on an isolated database.
14. Run tenant-isolation, webhook-replay, attendance and catalogue regression tests.
15. Enable automatic behavior one tenant/ad-set at a time; retain a kill switch.

## 8. Connection acceptance checklist

### Meta/WhatsApp

- [ ] Webhook verification succeeds.
- [ ] Invalid signature is rejected.
- [ ] Duplicate message/lead is processed once.
- [ ] Tenant is derived server-side.
- [ ] CTWA ad identity is retained.
- [ ] Lead form answers are mapped without losing unknown fields.
- [ ] Human-only campaign never calls AI.
- [ ] Unknown traffic remains visible and unassigned.
- [ ] Outbound state distinguishes queued, sent, delivered, read and failed.

### CRM AI

- [ ] Provider/model shown in audit metadata.
- [ ] Every score has evidence and policy version.
- [ ] Negative and opt-out text does not receive unjustified high intent.
- [ ] Provider failure hands off safely.
- [ ] AI cannot invent price/stock/policy.
- [ ] Automatic replies are disabled by default.

### Attendance

- [ ] HTTPS geolocation works on target phones.
- [ ] Store coordinates/radius are configured.
- [ ] Double taps/retries do not duplicate punches.
- [ ] Overnight and timezone tests pass.
- [ ] Offline punch is not shown as confirmed prematurely.
- [ ] Regularization preserves before/after audit evidence.

### Catalogue AI

- [ ] Image storage is tenant-isolated.
- [ ] Invalid/corrupt images are rejected.
- [ ] Both embedding models pass health checks.
- [ ] Re-index is idempotent.
- [ ] Failed re-index preserves last working vector.
- [ ] No-match and provider-error states are distinct.
- [ ] Human approves AI-generated metadata.
- [ ] Search quality is measured against labelled examples.

## 9. What is not needed for the first MVP release

- Face-recognition attendance.
- Continuous employee location tracking.
- Native mobile applications if the PWA passes device verification.
- DINOv3 before licence review and measured benefit.
- IVR recordings before consent/retention approval.
- RCS before WhatsApp/email campaign execution is reliable.
- Google Reviews aggregation before Customer 360 and feedback capture are stable.
- An autonomous AI agent enabled for every campaign.

## 10. Secrets-handling rule

Never place real tokens, app secrets, database URLs or encryption keys in this document, Git, screenshots, meeting transcripts or AI prompts. Add them directly to the approved deployment secret manager and use only placeholder names in code and documentation.
