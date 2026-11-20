# Connected accounts — operations runbook

**What this is:** the procedures for running the messaging and advertising
integrations in a staging or production environment, written for whoever is on
call rather than for whoever built it.

**What this is not:** a claim that any of it has been run against a live Meta
app. Everything below has been exercised against fixtures and a disposable local
database. Sections that require credentials nobody has yet are marked
**EXTERNALLY BLOCKED** and say exactly what is missing. A runbook that quietly
implies a rehearsal happened is worse than no runbook, because it stops people
asking.

Last verified locally: 2026-09-09.

---

## 1. What can go wrong, and where you will see it

| Symptom a person reports | Where to look first | Usual cause |
|---|---|---|
| "Leads stopped arriving" | Integrations → Lead capture failures | Dead fetch jobs: expired token, or no ad-set routing rule and more than one store |
| "We can't message customers any more" | Integrations → Message templates | Every approval older than 24h, or Meta paused a template |
| "It says sent but the customer got nothing" | Integrations → Outbound messages | Message is `queued`, not `sent`. No messaging connection for that channel |
| "The ROAS number disappeared" | Integrations → Spend and return | Partial coverage, or spend and revenue in different currencies |
| "Connected, but nothing happens" | Integrations → Connection health | Token stored but no asset registered, or asset registered but unverified |

The distinction that matters throughout: **stored is not verified, and queued is
not sent.** Every screen above is built to keep those apart, so trust what it
says over what someone remembers configuring.

---

## 2. Environment configuration

Set on the backend. None of these are per tenant.

| Variable | Purpose | If unset |
|---|---|---|
| `META_GRAPH_API_VERSION` | Explicit Graph version, e.g. `v21.0` | Every Graph call fails closed with "not configured with an explicit version" |
| `META_APP_SECRET` | Verifies inbound webhook HMAC | Every webhook is rejected |
| `META_WEBHOOK_VERIFY_TOKEN` | Answers Meta's subscription challenge | The webhook cannot be subscribed |
| `CREDENTIAL_ENCRYPTION_KEY` | AES-256-GCM key for tenant tokens | Saving any tenant credential is refused |
| `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS` | The key being rotated out | Rotation cannot read old rows |
| `CREDENTIAL_ENCRYPTION_KEY_VERSION` | Monotonic integer | Rewrap cannot tell current from stale |
| `CRM_QR_SECRET` | Signs public QR lead-capture tokens | **Falls back to `JWT_SECRET`.** Do not allow this in staging or production — set it explicitly |

Per-tenant values live in the database, not in the environment:

* the access token, encrypted in `IntegrationCredential`;
* the WhatsApp Business Account id, in `Integration.config` (non-secret);
* Pages, lead forms and ad accounts, in `IntegrationAsset`.

**Never** put a tenant's Meta token in an environment variable. One deployment
serves many tenants; an env-var token means tenant B transmits through tenant A's
account, and nothing in the request would reveal it.

---

## 3. Connecting a tenant (staging)

1. **Integrations → Meta connection.** Create the connection and name it.
2. Paste the long-lived access token. It is encrypted immediately; the API never
   returns it and no screen can render it back. To change it, paste a new one.
3. **Registered assets.** Add the Page, lead form and ad account ids. Registering
   an id is a *claim*, not proof.
4. **Connection health → Check now.** This is the step that makes "connected"
   mean something: it reads each asset back from the provider by id. An asset
   that answers with a different id is treated as unverified, because a redirect
   is not ownership.
5. For WhatsApp: record the **WhatsApp Business Account id**, then
   **Message templates → Synchronise now**.

Expected end state: connection `connected`, every asset `Confirmed`, at least one
template `Can be sent: yes`.

**EXTERNALLY BLOCKED:** steps 2–5 need a reviewed Meta app with
`leads_retrieval`, `ads_read` and `whatsapp_business_messaging`, plus a tenant
who has authorised it. None of that exists yet, so no run of this procedure
against real Meta has happened.

---

## 4. Credential rotation drill

Two different rotations. Do not confuse them.

### 4a. Rotating a tenant's provider token

Routine; no downtime.

1. Issue a new long-lived token in the tenant's Meta app.
2. **Meta connection → Replace.** The old ciphertext is overwritten in place.
3. **Connection health → Check now.** Confirm `connected` before walking away.
4. Revoke the old token at Meta.

If step 3 reports `failed`, the new token is wrong or lacks a permission. The old
one is already gone from our side — reissue rather than trying to recover it.

### 4b. Rotating the platform encryption key

This re-wraps every tenant credential. Order matters.

1. Set `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS` to the current key.
2. Set `CREDENTIAL_ENCRYPTION_KEY` to the new key and bump
   `CREDENTIAL_ENCRYPTION_KEY_VERSION`.
3. Deploy. Reads keep working: any row still on the old key is decrypted with
   `_PREVIOUS` and lazily re-wrapped on use.
4. For each tenant, `POST /integrations-registry/credentials/rewrap`. It returns
   `{scanned, current, rewrapped, concurrent, failed, complete}` and writes an
   audit row.
5. Only when every tenant reports `complete: true` and `failed: 0`, remove
   `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS`.

Removing `_PREVIOUS` before step 5 makes every un-rewrapped credential
permanently unreadable. There is no recovery — the plaintext exists nowhere else,
by design.

Drill status: the rewrap path has unit coverage including a key change without a
version bump and a repaired tenant id
(`test/provider-registry.e2e-spec.ts`). **A staging rotation with real
credentials has not been performed.**

---

## 5. Dead jobs and alerting

`JobTask` is the durable queue. Statuses: `pending`, `running`, `succeeded`,
`failed`, `dead`.

* `failed` will retry itself. It is noise until it recurs.
* **`dead` has given up.** It will never move without a person.

Where to see it:

* `GET /jobs/summary` → `needsAttention` is the count of dead jobs for the tenant.
* Integrations → Lead capture failures, for `meta.lead_ads.fetch` specifically.
* Integrations page shows a banner when `needsAttention > 0`.

The kinds worth alerting on:

| Kind | What a dead job means |
|---|---|
| `meta.lead_ads.fetch` | A person filled in a lead form and was never filed. Customer lost. |
| `omnichannel.deliver` | A message a salesperson believes was sent |
| `omnichannel.templates.sync` | Approvals will go stale within 24h and sending will stop |
| `meta_ads.insights.pull` | Spend figures silently stop advancing; coverage shows the gap |

**Suggested alert:** page when `needsAttention > 0` for `meta.lead_ads.fetch`;
ticket for the rest. **NOT CONFIGURED** — no alerting integration exists in this
repository. `GET /jobs/summary` is the endpoint to poll; wiring it to a pager is
an infrastructure task nobody has done.

Recovery: fix the cause first, then re-queue from the screen (or
`POST /jobs/:id/retry`). Re-queueing without fixing the cause just repeats the
failure and consumes the retry budget again.

---

## 6. Restore drill

See `docs/OPERATIONS.md` for the database backup and restore procedure, which is
unchanged. Two additions this work introduces:

* `AdSpendDaily` and `AdSpendCoverage` are now part of the backup surface. They
  are reconstructible — re-run the provider pull for the window — but a restore
  that loses them shows a ROAS gap rather than a wrong number, which is the
  intended failure direction.
* `IntegrationCredential` rows are useless without the encryption key. **A
  database backup alone does not restore a working integration.** The key must be
  in the same recovery plan, stored separately from the dump. If the key is lost,
  every tenant re-pastes its token; the data is intact but nothing can transmit.

Local rehearsal status: an empty-database migration run and a populated-clone
rehearsal were both performed for this release (see the final delivery report).
**A production-shaped staging restore has not been performed.**

---

## 7. Intern workbook — five things to understand before touching this

1. **Stored is not verified.** `IntegrationAsset.providerOwnershipVerified` is
   true only after a live Graph call read that exact id back. A form submission
   sets it to nothing. If you add a new asset kind, add its probe to
   `ASSET_PROBE` in `meta-health.service.ts` — an unknown kind is reported as
   unverifiable rather than passed by omission, and that is deliberate.

2. **Queued is not sent.** `Message.status = 'queued'` means nobody has
   transmitted it. `ConversationsService.queueOutbound` documents why: reporting
   a message as sent when no provider was contacted is a lie the UI then shows to
   a salesperson who repeats it to a customer.

3. **Approval belongs to the provider.** `metadata.approvalStatus` is what a
   person typed; `metadata.providerStatus` plus `lastVerifiedAt` is what Meta
   said and when. Only the second authorises a send, and only for 24 hours. If
   you find yourself reading the first to decide whether to send, stop.

4. **Currency is a unit, not a label.** Revenue is in the tenant's currency;
   spend is in the ad account's. When they differ there is no ratio — the report
   returns `measuredRoas: null` with `currencyMismatch: true` and shows both
   figures labelled. Do not add a conversion. A rate nobody supplied is a number
   we invented.

5. **A merge must not launder a blacklist.** `mergeRiskCarry` in
   `advanced-crm.service.ts` is the one place that decides what happens to
   `isBlacklisted` and `creditLimit` when two customer records are merged. Either
   side blacklisted keeps the survivor blacklisted; two different credit limits
   are refused rather than reconciled. It is used by both the plan a human
   approves and the write that executes it, so they cannot drift.

### Where the code is

| Concern | File |
|---|---|
| Inbound webhook verification | `backend/src/integrations/meta-webhook.service.ts` |
| Lead → CRM records | `backend/src/integrations/meta-lead.adapter.ts` |
| Which tenant owns a Page | `backend/src/integrations/meta-asset-ownership.service.ts` |
| Connection health | `backend/src/integrations/meta-health.service.ts` |
| Template approval sync | `backend/src/omnichannel/template-sync.service.ts` |
| Consent, outbox, delivery | `backend/src/omnichannel/omnichannel.service.ts` |
| Send/no-send rules (pure) | `backend/src/omnichannel/omnichannel-policy.ts` |
| Spend ingestion and ROAS | `backend/src/attribution/meta-ads-insights.service.ts` |
| Merge, SLA, assignment | `backend/src/crm/advanced-crm.service.ts` |

### Running the tests

```bash
cd backend
npm run test:e2e:isolated                       # everything, on a disposable database
SEED=0 TEST_PATTERN='meta-health' npm run test:e2e:isolated
```

`TEST_PATTERN` narrows to one suite; `SEED=0` skips the demo seed for suites that
create their own tenants; `KEEP_TEST_DB=1` leaves the database behind for
inspection after a failure.

---

## 8. What is still externally blocked

| Item | Blocked on |
|---|---|
| Any live Graph call | A reviewed Meta app with `leads_retrieval`, `ads_read`, `whatsapp_business_messaging` |
| Real template approval | A WhatsApp Business Account with submitted templates |
| Real spend figures | A tenant-authorised ad account |
| Webhook subscription | A publicly reachable HTTPS callback and Meta app configuration |
| Dead-job alerting | An alerting integration; none exists in this repository |
| Production restore drill | A production-shaped staging environment |

Everything above this line has been exercised against fixtures and a real local
PostgreSQL. Nothing in this document should be read as evidence that a live
provider has ever answered.
