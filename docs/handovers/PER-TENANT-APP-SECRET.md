# Per-tenant app secret — implementation handover

> **Why:** each client will own their own Meta app, so each has their own app
> secret. Webhook signature verification currently reads one deployment-wide
> secret. Decision recorded in `DECISIONS.md` (2026-09-18); model described in
> `META-INTEGRATION-ARCHITECTURE.md` §5.1.
>
> **No schema migration required.** Written 2026-09-18 against
> `phase-6-meta-integrations`.

---

## The problem in one paragraph

Meta refuses to give a *partner* send rights on a client's WABA unless the
partner is the billing party — confirmed twice, greyed out in both the partner
share dialog and the system-user assignment dialog: *"This permission can only
be assigned to the partner who's responsible for billing."* Taking billing means
Meta charges CaratSense for **every** conversation on that number, the client's
own marketing included, since billing attaches per-WABA. Rejected.

The workaround — the client mints a token against **our** app — is blocked by
Meta's new-business lock: *"Businesses new to Facebook Products can share this
asset by assigning a partner from another business after several weeks."* Every
newly created client portfolio hits this.

So: **the client owns the app.** They pay Meta directly, and their app's webhook
points at us. Which means one app secret per tenant.

---

## Current state

```
integrations.controller.ts:151   @Post('whatsapp/webhook')
                          :157     this.whatsapp.verifySignature(req.rawBody, signature)

whatsapp.service.ts:53           private get appSecret()  → config WHATSAPP_APP_SECRET
                    :332         verifySignature(rawBody, signature)
                    :344         HMAC-SHA256 over rawBody against that one secret

integrations.controller.ts:184   @Post('meta/webhook')
                          :190     this.metaWebhook.verifyLeadAdsSignature(...)
meta-webhook.service.ts:42         config META_APP_SECRET
```

Both secrets are single-valued per deployment.

---

## Why no migration is needed

`IntegrationCredential` already models this:

```prisma
/// 'api_key' | 'access_token' | 'refresh_token' | 'password' | 'shared_secret'
kind String
@@unique([integrationId, kind])
```

- The app secret is stored as `kind: 'shared_secret'` on the tenant's WhatsApp
  `Integration`, encrypted with the same AES-256-GCM path as the access token.
- The **app ID** and **phone number ID** are non-secret and belong in
  `Integration.config`, per that field's own doc comment.

One credential row per integration per kind is already enforced.

---

## The design problem, and the resolution

**Signature verification runs before the tenant is known, and an unverified body
must not be parsed to discover it.** Looking up `metadata.phone_number_id` inside
the payload to choose a secret means trusting unauthenticated input to select the
key that authenticates it.

**Resolution: the tenant is named in the URL.**

```
POST /integrations/whatsapp/webhook/:integrationId
```

Each client's Meta app is configured with its own callback URL. The path
identifies the integration, its `shared_secret` is fetched, and the signature is
verified before the body is touched. No trust is placed in the payload.

The existing unsuffixed route stays, verifying against the env secret, so the
platform path and the test WABA keep working unchanged.

---

## Changes

### 1 · `WhatsAppCredentialsService` — resolve the secret

Add alongside the existing token resolution:

```ts
/**
 * The app secret that signs this tenant's inbound webhooks.
 *
 * Per-tenant because each client owns their own Meta app (DECISIONS 2026-09-18).
 * Null when the integration has no shared_secret — the caller decides whether
 * to fall back to the platform secret or refuse.
 */
async resolveAppSecret(integrationId: string): Promise<string | null>
```

Same decrypt path as the access token. Touch `lastUsedAt` as the token resolution
does, so an unused credential remains spottable.

### 2 · `WhatsAppService.verifySignature` — take an explicit secret

```ts
verifySignature(
  rawBody: Buffer | undefined,
  signature?: string,
  secret?: string,          // NEW — when absent, falls back to WHATSAPP_APP_SECRET
): boolean
```

Keep the existing production guard exactly as it is: **no secret in production →
refuse**, never skip. The development-only warning path is unchanged.

Extracting the HMAC comparison into a small private helper keeps one
implementation for both callers.

### 3 · `IntegrationsController` — the tenant-scoped route

```ts
@Public()
@Post('whatsapp/webhook/:integrationId')
async whatsappWebhookForTenant(
  @Param('integrationId') integrationId: string,
  @Req() req: RawBodyRequest<Request>,
  @Headers('x-hub-signature-256') signature?: string,
) {
  const secret = await this.credentials.resolveAppSecret(integrationId);
  if (!secret) throw new ForbiddenException('unknown integration');
  if (!this.whatsapp.verifySignature(req.rawBody, signature, secret)) {
    throw new ForbiddenException('invalid signature');
  }
  // …existing intake path, with the integration already resolved
}
```

Return **403 with the same body shape** as the existing route for both an unknown
integration and a bad signature. Do not distinguish them in the response — a
different error for an unknown id turns the endpoint into an integration-id
oracle.

### 4 · Same treatment for `meta/webhook` — later, not now

Lead Ads stays on CaratSense's app, so `META_APP_SECRET` remains correct today.
Worth the same shape when a client eventually runs their own Lead Ads app; not
required for Éclat.

---

## Backwards compatibility

| Route | Secret | Still works |
|---|---|---|
| `POST /integrations/whatsapp/webhook` | `WHATSAPP_APP_SECRET` | ✅ unchanged — platform path, test WABA |
| `POST /integrations/whatsapp/webhook/:integrationId` | tenant `shared_secret` | new |
| `POST /integrations/meta/webhook` | `META_APP_SECRET` | ✅ unchanged |

Nothing in the existing deployment changes behaviour. The staging test WABA keeps
working while the tenant path is built.

---

## Tests worth having

1. Correct signature on the tenant route with the tenant's secret → **200**
2. Signature computed with the **platform** secret on the tenant route → **403**
   (proves the secrets are genuinely separate, not falling through)
3. Unknown `integrationId` → **403**, and the body is identical to the bad-signature 403
4. Two tenants, two secrets: each verifies its own and rejects the other's
5. Existing unsuffixed route still passes with the env secret
6. Production with no secret resolved → refuse, never skip
7. Replay of the same signed payload is deduplicated as today — the intake
   boundary is unchanged, worth asserting it still holds on the new route

---

## What the client supplies

Once this ships, onboarding a WhatsApp tenant is four values:

| Value | Where it goes |
|---|---|
| App ID | `Integration.config` |
| **App Secret** | `IntegrationCredential` · `kind: 'shared_secret'` |
| **Access token** (system user, Never expiry) | `IntegrationCredential` · `kind: 'access_token'` |
| Phone number ID | `Integration.config` / `IntegrationAsset` |

And they point their app's webhook at
`/integrations/whatsapp/webhook/<their integrationId>`, subscribed to `messages`.

---

## Why it is worth doing now rather than waiting

The alternative is waiting several weeks for Meta's new-business lock to lift on
CaratSense's portfolio, then having Éclat mint a token against our app.

That works, costs nothing, and **repeats for every client** — each new client
portfolio is new to Facebook Products, so each waits again. This change removes
the wait permanently and keeps every client's Meta spend on their own account.
