# CaratOS — Universal Multi-Tenant Platform Architecture Report

> **Architecture-first. Nothing here has been implemented.** No application code, schema, migration or config was modified to produce this report. The only file written is this document.
>
> **Method.** 12 parallel read-only repository audits → 12 target-architecture designs grounded in those audits → 2 adversarial critics (completeness + anti-fabrication) which verified 40+ claims against the code and corrected 14 of them. Contradictions between design lanes are **resolved here** (Appendix B), not reproduced.
>
> **Status vocabulary.** Every proposal is marked **EXISTS · PARTIAL · MISSING · REQUIRES REFACTOR · FUTURE**. *FUTURE* additionally means "requires provider documentation at implementation time" wherever a third party is involved.
>
> **No fabrication.** No provider endpoint, scope, API version, permission name, rate limit or app-review requirement is asserted anywhere. Appendix C lists provider assumptions that must be verified *before* they drive a schema decision.

---

## §0. THE FINDING THAT OUTRANKS EVERYTHING ELSE

**The entire CaratOS tenancy layer is untracked in git.**

```
git show HEAD:backend/prisma/schema.prisma | grep -c organisationId   →  0
git status --short → M backend/prisma/schema.prisma
                     ?? backend/prisma/migrations/2026081919…_caratos_organisation_tenancy/  (+6 more)
                     ?? backend/src/integration/   ?? backend/src/whatsapp-bot/
                     ?? 11 test specs (7 org-isolation + import-engine, jewelry-inference-live,
                                       qa-validation, whatsapp-bot)
```

HEAD is `9589ac5`. 57 migration directories exist on disk; **49 are committed**.

1. **Production runs the pre-Organisation, single-tenant build.** Every guarantee in `CARATOS_STEP1_AUDIT.md` and `CARATOS_STEP2_REPORT.md` exists only in this working tree.
2. **Committing and deploying are the same action.** `backend/railway.json` sets `preDeployCommand: prisma migrate deploy && node prisma/seed-user-phones.mjs`. "Commit the tenancy work" therefore means "apply a 448-line NOT NULL + FK rewrite across 47 tables to production" — with **no staging environment, no pre-migration snapshot, and no CI running tests** (`.github/workflows/ci.yml` is itself git-ignored and runs only `tsc --noEmit` + `build`; `git ls-files .github/` returns `CODEOWNERS` only).
3. **Everything in this report is downstream of that commit.**

This is an operational risk, not a design gap. See §24 Phase 0 and §25 R1.

---

## §1. CURRENT ARCHITECTURE

### 1.1 Shape

Four apps in one folder, no workspace tooling (no root `package.json`, no workspaces/turbo/nx, no `docker-compose.yml`):

| App | Stack | Deploy |
|---|---|---|
| `backend/` | NestJS + Prisma 6.2 + PostgreSQL, ~40 modules, 38 controllers | Railway (Docker, root_dir=backend); migrations in `preDeployCommand` |
| `frontend/` | Next.js 16 + React/TS + react-query, 32 pages | Vercel; browser traffic proxied same-origin via a `/_api` rewrite |
| `inference/` | FastAPI, DINOv2 + SigLIP 2, weights baked into the image | Railway (**has** `healthcheckPath`, unlike the backend) |
| `synceclatcaratsense/` | Windows Python on-prem agent, per client site | Manual install + Task Scheduler |

Storage: Cloudflare R2. Config: one flat `ConfigModule.forRoot({isGlobal:true})` namespace with **no tenant dimension**.

### 1.2 Verified schema census

**78 models · 41 enums.** `organisationId` on **51** (48 NOT NULL + 3 deliberately nullable: `ScheduledJobRun`, `WhatsAppEvent`, `WhatsAppSession`). **26 models carry no org column** — 24 true transitive children reachable through a required parent FK, plus **`DocSequence`** and **`LoginOtp`**, which have no parent at all. 50 `@@index([organisationId])`; 24 `@@unique([organisationId, …])` of which 16 are `legacyId`. Nine `ref` columns remain globally `@unique`.

Zero RLS artefacts, zero composite FKs, zero CHECK constraints:

```
grep -rilE "row level security|create policy|current_setting|set_config" backend/prisma backend/src → none
grep -rn 'FOREIGN KEY ("[A-Za-z]*", "' backend/prisma/migrations/ | wc -l                          → 0
```

### 1.3 What is genuinely well-built — preserve

- **Tenant resolution.** `JwtAuthGuard` re-reads `role`, `isActive`, `organisationId` **from the DB user row on every request** — never from the token payload, header, body or query. Repo-wide: **zero** hits for `body.organisationId | dto.organisationId | x-org`. This is the hardest half of a tenant boundary and it is right.
- **`StoreScopeService`.** Org-bounded scope, fail-closed on missing org, and `storeFilter` never returns an unbounded `{}` even for `head_office`.
- **Webhook signature verification.** HMAC-SHA256 over captured `rawBody` with length-guarded `timingSafeEqual`; fail-closed in production (WhatsApp), always-closed (Razorpay).
- **Two durable-job primitives, no broker.** `JobRunnerService.runOnce(org, job, scope, runKey)` claims by INSERT and treats P2002 as "another replica owns it"; `WhatsAppEvent.wamid @unique` + a conditional-update claim gives exactly-once inbound processing.
- **On-prem agent posture.** Outbound-only HTTPS, no listening socket, four-layer read-only guarantee (DENY-listed SQL login, `ApplicationIntent=ReadOnly`, SELECT-only code, mandatory `--dry-run`).
- **`tz.util.ts`** — 322 lines, pure, DST-correct two-pass offset resolution anchored on `Store.timezone`. The most reusable asset in the codebase.
- **HRMS** — the most industry-neutral module; zero jewellery vocabulary in `backend/src/hrms/**`.
- **Honest AI degradation** — `NO_CLOSE_MATCH` / `SEARCH_ERROR` / `NOT_INDEXED`; embeddings and similarity search are correctly org-scoped.

### 1.4 What is missing or wrong (detail in §3)

- **No control plane.** `prisma.organisation` is read in exactly **two call sites in one file** (`stores.service.ts` `directory()`). `Organisation.isActive` is therefore **dead** — a suspended tenant's users still authenticate. `organisation.create` appears only in test fixtures: there is **no provisioning path at all**. Organisation #1 exists only because a migration INSERTs `org_eclat`.
- **No tenant context outside HTTP.** Tenant identity travels only as a hand-passed `AuthUser`. A query that omits the predicate is a silent success with no compile-time, runtime or DB signal — exactly how `GET /scheduler/runs` (which injects **no** `@CurrentUser` at all) survived a dedicated isolation-hardening pass.
- **No integration framework.** No Integration/Provider/Credential/Webhook/Channel model among 78. Every provider credential is a process-global env var; **~36 of the ~47 env names read are effectively tenant-level**, including `SYNC_DEFAULT_STORE_ID` — a literal tenant store id in platform config.
- **No queue.** No bull/bullmq/ioredis/redis/kafkajs/amqplib. Three `@Cron` decorators and two `void this.…()` escapes inside the web process.
- **No CRM — this is a lead desk.** `Lead.partyId`, `CheckIn.partyId`, `Quote.partyId` are declared and written by **nothing** outside `sync.service.ts`, so every app-created lead, walk-in and quote is an orphaned free-text string. No Opportunity, Conversation, Message, ActivityEvent, Segment or ProductInteraction model exists.
- **No attribution.** Campaign→AdSet→Ad→Lead→…→Revenue is broken at nine of ten hops; `MarketingCampaign` is a planner container with no lead, party or sale relation.
- **No marketing ingress.** Zero Meta Ads / Lead Ads / Instagram / SMS / telephony / push code, env vars or models. The front half of the target journey has no entry point.
- **No configuration layer.** `Organisation` has no industry, plan, settings or domain field. Industry behaviour lives in **12 closed Postgres enums** surfaced through **46 `@IsEnum` validators across 17 files**.
- **Frontend is single-tenant.** Zero `org`/`tenant` hits in `frontend/src`; no `middleware.ts`; nav is role-filtered only.
- **Observability.** **1 of 78** logger calls carries `organisationId`. No `APP_INTERCEPTOR` registered anywhere. No correlation id.

---

## §2. TARGET ARCHITECTURE

One application, two planes, one Prisma schema, one database (pooled) with a documented escape hatch to a silo.

```
                         CONTROL PLANE  (/platform/*, own guard + own JWT secret)
   PlatformUser · Plan · Entitlement · TenantProvisioning · IndustryPack
   UsageDaily · PlatformAuditLog · ImpersonationGrant · BillingSubscription
                                    │  resolved, cached  ▼
                          Organisation (tenant root: status, industryPack, plan,
                                        isolationMode, country/currency/timezone)
                                    │
   ┌────────────────────────────────┼────────────────────────────────┐
   │                                │                                │
 APPLICATION PLANE              INTEGRATION PLANE               DATA PLANE
 CRM · HRM · Catalogue          Integration · Credential        Postgres (pooled)
 Inventory · Sales · AI         Asset · Webhook · Job           organisationId + RLS
                                Connector runtime               R2 (org-prefixed keys)
   │                                │
   └── TenantContext (AsyncLocalStorage) established at EVERY boundary:
       HTTP request · webhook · scheduled job · queue consumer · on-prem push · impersonation
```

**Invariants.** (1) The application plane never reads a control-plane table — control state reaches it only as a resolved `AuthUser.org` object. (2) Domain code writes `organisationId` predicates identically in pooled and silo mode. (3) No default/first/only-org resolution on any authenticated path.

**What survives unchanged:** `StoreScopeService`, `JwtAuthGuard`'s DB-authoritative org resolution, `tz.util.ts`, HRMS, the Gati extraction in `sync/`, the agent's outbound-only posture, `runOnce`, `wamid` idempotency, signature verification, honest AI degradation.

**What is replaced:** 12 industry enums → taxonomy rows; `config-seed.ts` → industry-pack provisioning; process-env tenant credentials → `Integration` + `IntegrationCredential`; `void this.…()` → a Postgres-backed job queue; the lead desk → a CRM with an identity spine.

---

## §3. GAP ANALYSIS

| # | Capability | Status | Gap |
|---|---|---|---|
| G1 | Tenancy schema (org column, org-scoped uniques) | **PARTIAL** | Complete in the working tree, **absent from HEAD and production** (§0) |
| G2 | Tenant context beyond HTTP | **MISSING** | No ALS, no envelope; jobs/webhooks/agent rely on convention |
| G3 | DB-level isolation (RLS) | **MISSING** | 0 policies; app-level only |
| G4 | Control plane | **MISSING** | No PlatformUser, plan, entitlement, provisioning, metering |
| G5 | Organisation lifecycle | **MISSING** | `isActive` unenforced; no status machine |
| G6 | Integration framework | **MISSING** | No models; credentials in process env |
| G7 | Meta / Instagram / Lead Ads | **MISSING** | No code, no models — entire ad→lead ingress absent |
| G8 | WhatsApp multi-tenancy | **REQUIRES REFACTOR** | Works, but one WABA/number/token for the whole platform |
| G9 | CRM identity spine | **MISSING** | `partyId` never written by app paths |
| G10 | Conversation / Message | **MISSING** | No channel-agnostic thread model |
| G11 | Unified activity timeline | **MISSING** | No `ActivityEvent` |
| G12 | Opportunity / pipeline config | **MISSING** | `LeadStage` is a closed enum |
| G13 | ProductInteraction | **MISSING** | "products viewed" has no persistence |
| G14 | Attribution | **MISSING** | 9 of 10 hops broken |
| G15 | Industry configuration | **MISSING** | 12 enums, 46 `@IsEnum` sites, no pack mechanism |
| G16 | Custom fields | **MISSING** | No attribute registry, no JSONB bag |
| G17 | Connector runtime | **MISSING** | Contracts complete, **zero implementations** |
| G18 | Import provenance | **MISSING** | CSV rows carry no `legacyId` → **`purgeDemo` deletes them** |
| G19 | Queue / worker | **MISSING** | In-process only |
| G20 | Object-access authorization | **MISSING** | Public bucket, guessable keys, unauthenticated `/uploads` |
| G21 | Backup / DR | **MISSING** | No owned backup, no restore test, no RPO/RTO |
| G22 | Tenant-tagged observability | **MISSING** | 1/78 log calls carry org; no interceptor |
| G23 | Onboarding | **MISSING** | Existing module is a *user welcome tour* |
| G24 | Platform/admin UI | **MISSING** | Settings has only audit/rates/stores/targets/team |
| G25 | Billing / usage | **MISSING** | No metering of any kind |
| G26 | Frontend tenancy | **MISSING** | No org concept, no middleware |
| G27 | CI running tests | **MISSING** | ci.yml git-ignored; 34 e2e specs never run in CI |

### Live defects (present in the working tree today)

| ID | Defect | Severity |
|---|---|---|
| **D-1** | `purgeDemo` deletes every CSV-imported row (`legacyId: null` predicate; importers write no provenance) | **P0 data loss** |
| **D-2** | `GET /scheduler/runs` — cross-tenant read; injects no `@CurrentUser`, has no org predicate | **P0 isolation** |
| **D-3** | `Organisation.isActive` unenforced at auth — suspended tenant still logs in | **P1** |
| **D-4** | `Payment.reference` has no unique index; `findFirst`-then-`create` is a race on the money path | **P1** |
| **D-5** | `ScheduledJobRun @@unique([job, scope, runKey])` omits org → silent cross-tenant job suppression | **P1** |
| **D-6** | `SyncService.UNASSIGNED_STORE_ID = 'unassigned'` — hardcoded global store PK, resolved org-less | **P1** |
| **D-7** | `staff-${legacyId}@imported.invalid` collides across tenants | **P1** |
| **D-8** | `Store.id = slugify(code)` with an org-less clash check | **P1 blocks tenant #2** |
| **D-9** | `seed-user-phones.mjs` writes demo phone numbers to production on **every deploy**, matching by global email with no org predicate | **P1** |
| **D-10** | `config-seed.ts` — dead code whose docblock claims `main.ts` runs it; hardcodes `org_eclat` + `store.findFirst({})` | **P2** |
| **D-11** | Unauthenticated `/uploads` static route + public guessable object keys | **P1** |
| **D-12** | Backend has no `healthcheckPath` in `railway.json` (inference does) | **P2** |

---

## §4. DOMAIN MODEL CHANGES

Single reconciled model set (duplicate proposals resolved — Appendix A).

### 4.1 CRM core — **MISSING**

| Model | Purpose |
|---|---|
| **`ContactPoint`** | Identity records: `{organisationId, partyId, kind(phone/email/whatsapp/provider_id/external_id), value, valueNormalised, providerKey?, isPrimary, verifiedAt?, confidence, source, firstSeenAt, lastSeenAt}` — `@@unique([organisationId, kind, valueNormalised])` |
| **`PartyMergeCandidate` / `PartyMerge`** | Explicit, reviewable, reversible dedupe. **Never a silent merge.** |
| **`Opportunity`** (+ `OpportunityLine`) | The missing pipeline object between Lead and Sale |
| **`Conversation`** + **`Message`** | Channel-agnostic thread; see Appendix B/C3 for the resolved key |
| **`ActivityEvent`** | Append-only chronological timeline — the spine of Customer 360 |
| **`ProductInteraction`** | viewed / shown / shortlisted / tried / quoted / rejected — `productId` / `stockItemId` / `sku` only, **no industry fields** |
| **`Segment`** + `SegmentMember` | Static and dynamic; `definition Json` evaluated server-side against an allowlisted field set, never raw SQL |
| **`Pipeline` / `PipelineStage` / `LookupValue`** | Configurable lifecycle replacing six enums |
| **`FollowUpPolicy`** | Replaces hardcoded `FU1_DAYS`/`FU2_DAYS` |

### 4.2 Evolutions — **REQUIRES REFACTOR**

- **`Party` → universal Customer.** Add `ownerId`, `lifecycleStage`, `preferredChannel`, `preferredLanguage`, `countryCode`, `marketingConsent`/`consentSource`/`consentAt`, `dnd`, `anonymisedAt`, `attributes Json`. Reinterpret `storeId` as `originStoreId` and **remove `storeFilter` from the customer read path** — a customer belongs to the tenant; a branch is provenance. Branch visibility becomes a filter over `ActivityEvent.storeId`.
- **`Lead`.** `storeId` → nullable (+ `assignedStoreId`, `routingStatus`, `routedAt`, `routedById`, `assignedBy`); `ref` → `@@unique([organisationId, ref])`; `stage`/`source`/`lostReason` → FKs to org-scoped `LookupValue`; add `campaignId?`, `attributionStatus`. **Must ship atomically with the unrouted-leads queue** (§25 R4).
- **`CheckIn` → Visit.** `storeId` nullable, `visitType`, `partyId` actually written, `leadId?`, `conversationId?`, `purposeId` (LookupValue), persist `partySize` (validated then **discarded** today), `saleId?`/`quoteId?` required when outcome claims a conversion.
- **`Task`.** `assignee String?` (free-text name) → `assigneeId` FK + polymorphic `subjectType`/`subjectId`.
- **`AuditLog`.** `actorId` → nullable **with `actorKind` + `actorLabel` in the same migration** (Appendix B/C4). Add `@@index([organisationId, createdAt])`.
- **`DocSequence`.** Add `organisationId`; PK → `@@id([organisationId, scope])`; re-scope the nine global `ref` uniques. Existing refs keep their values — partition the counter, never renumber live documents.
- **`Store`.** `id` → `cuid()`; `code` carries human identity under the existing `@@unique([organisationId, code])`; add `isHolding` to replace the `'unassigned'` PK. Existing rows keep their slug ids (a `@default` affects only new rows).
- **`Notification`, `LeadFollowUp`, `LeadNote`** + the other 21 transitive children → add denormalised `organisationId` (RLS prerequisite).
- **`Payment`.** Add `@@unique([organisationId, reference])`.
- **`Product.metal`** → nullable, **only after** `FieldPolicy` rows are seeded and enforced (§25 R5).

### 4.3 Control plane — **MISSING**

`PlatformUser` · `PlatformRole` · `OrganisationStatus` · `Plan` · `OrganisationEntitlement` · `TenantProvisioning` · `OrganisationOnboarding` + `OnboardingStep` · `IndustryPack` · `UsageEvent` + `UsageDaily` · `PlatformAuditLog` · `ImpersonationGrant` · `BillingSubscription` · `OrgInvite` · `DeclaredSystem`.

### 4.4 Integration plane — **MISSING**

`IntegrationProvider` (the **only** platform-level, org-less table here) · `Integration` · `IntegrationCredential` · `IntegrationCapability` · `IntegrationAsset` (self-referencing provider object tree) · `WebhookEndpoint` · `WebhookDelivery` · `IntegrationLog` · `SourceLink` · `ImportProfile` · `ConnectorEnrolment` · `FieldOwnershipOverride` · `Job` · `ImportIssue` · `StorageObject`.

### 4.5 Configuration plane — **MISSING**

`TaxonomyTerm` · `AttributeDefinition` · `WorkflowDefinition` + `WorkflowStage` · `FieldPolicy` · `PromptTemplate` · `RoutingRule` · `RoutingDecision`.

### 4.6 Attribution — **MISSING**

`AdSet` · `Ad` · `AdSpendDaily` · `AttributionTouch` (immutable observed-contact ledger) · `AttributionResult` (versioned, recomputable credit allocation) · `LeadQualification` · `AdAccountConnection`. `MarketingCampaign` is **extended, not replaced**.

---

## §5. DATABASE CHANGES

**Ordered.** Each step is independently shippable and reversible.

1. **Commit + apply the existing tenancy migrations** (§0) — behind a snapshot gate.
2. **Denormalise `organisationId` onto the 24 transitive children** (+ decide `DocSequence` and `LoginOtp` separately — they have no parent). Idempotent pattern from `20260822130000`: `ADD COLUMN` → `UPDATE … FROM parent WHERE organisationId IS NULL` → `SET NOT NULL` → FK → `@@index`. **Backfill all 24 first, verify, then enable any policy** (Appendix B/S3).
3. **Org-scope the remaining global keys** — `DocSequence` PK, the nine `ref` uniques, `ScheduledJobRun`, `Payment.reference`, `Store.id`, and (once host resolution exists) `User.email`.
4. **Composite tenancy FKs** on high-value parents — `@@unique([organisationId, id])` on Store/Sale/Quote/StockItem/StockTransfer/Lead/Party/Ticket/CustomOrder, children re-pointed at `references: [organisationId, id]`. **RLS does not close this hole — FK checks are not subject to RLS.**
5. **Control-plane + integration + config + CRM tables** (§4), each with `organisationId` NOT NULL from its creation migration.
6. **Enum → TEXT widening** (`ALTER COLUMN … TYPE TEXT USING …::text`, then `DROP TYPE`), paired with the taxonomy registry and the `@IsTaxonomyTerm` validator. Value-preserving.
7. **RLS** (§7) — last.

**Indexes to add now:** `@@index([organisationId, createdAt])` on `AuditLog`; `@@index([organisationId, phone])` and `([organisationId, lastSeenAt])` on `Party`; GIN `jsonb_path_ops` on every `attributes` column.

---

## §6. MULTI-TENANCY STRATEGY

### 6.1 TenantContext — **MISSING**

```ts
TenantContext = {
  organisationId, slug, status, isolationMode: 'pooled'|'silo', datasourceKey: string|null,
  actor: {kind:'user',userId,role}
       | {kind:'service',serviceAccountId}     // on-prem agent
       | {kind:'system',job}                   // scheduler / queue
       | {kind:'webhook',provider,eventId}
       | {kind:'platform_admin',adminId,impersonationGrantId}
}
```

### 6.2 Propagation — **REQUIRES REFACTOR**

**Keep explicit `AuthUser` parameters as the authorization contract in every service signature.** Do *not* migrate services to read org from ambient storage. **Add** `TenantContextService` over `AsyncLocalStorage` with `runAsTenant(ctx, fn)`, `runAsPlatform(reason, fn)`, `current()` (throws when unset). The ALS value has exactly three consumers: the Prisma extension, the logger, and the correlation id.

Boundaries where context must be established: **HTTP** (`JwtAuthGuard`, extending its single existing `user.findUnique` with a nested `organisation` select — zero extra round trips) · **webhook** (two-phase, §9.4) · **scheduled job** (enumerate inside `runAsPlatform`, execute each unit inside `runAsTenant`) · **queue consumer** (org id in the envelope, re-resolved and re-validated, never a trusted serialised context) · **on-prem push** (service-account actor) · **impersonation**.

### 6.3 Enforcement — **MISSING**

One Prisma `$extends` query extension, one owner (`PrismaService`), composed in a fixed order: **(a)** open the interactive transaction, **(b)** `set_config('app.current_org', …, true)` for RLS, **(c)** inject `organisationId` into `where` for read/updateMany/deleteMany and assert it on create. Derive the model list from DMMF at boot — `sync.service.ts` `orgScopedWhere` is the existing precedent; reuse its shape. Injection does **not** make RLS redundant (Appendix B/C9).

### 6.4 Isolation tiers

| Tier | When | Mechanism |
|---|---|---|
| **Pooled** (default) | Every tenant | Shared DB, `organisationId` + RLS |
| **Bridge** (schema-per-tenant) | **Do not build** | Adds a migration matrix without closing a real risk |
| **Silo** | Contractual data residency, regulated vertical, scale outlier, mandated dedicated encryption | **A deployment concern** — second service, own `DATABASE_URL`, own R2 prefix, own backup schedule, seeded from the per-tenant export |

**Resolved:** the silo is a deployment parameter, **not** a per-request connection registry (Appendix B/C2). Record `isolationMode` + `datasourceKey` now; build no registry until an enterprise tenant contracts for one.

**Pooled → silo runbook (no domain-code change):** status `exporting` (tenant read-only) → provision silo DB and run the *same* `prisma migrate deploy` → copy rows in FK order with a per-table `WHERE organisationId = …` → verify per-table counts → repoint the tenant → keep the pooled rows read-only for a cooling period, then delete.

### 6.5 No-fallback invariants (each under a test)

**I-1** org never from request input on an authenticated path. **I-2** missing/empty org = deny; `organisationId` is a non-empty branded string (kills `?? ''`). **I-3** no "the only org" resolution on any authenticated path. **I-4** no first/alphabetical/default store attribution. **I-5** every cross-tenant query is inside an explicit `runAsPlatform(reason)`. **I-6** an org-less query against an org-bearing model throws.

---

## §7. RLS STRATEGY — **MISSING**

**RLS is a second boundary. App-level scoping remains mandatory.** "RLS handles it" is a rejected code-review justification.

- **GUC + accessor.** `app.current_org()` — a STABLE SQL function returning `current_setting('app.current_org', true)` that **raises** on NULL/empty. Policies reference only the function, never inline `current_setting`.
- **Carrier.** Transaction-local `set_config(..., true)` inside an explicit interactive transaction — correct under PgBouncer session/transaction/statement pooling. Never a bare `SET`; never rely on connection stickiness. Railway's pooler mode is **unverified** — assume transaction pooling.
- **Nested-transaction collision.** Expose `orgTx(user, fn)` on `PrismaService` and migrate the ~20 existing `$transaction` sites to it; the extension then wraps only operations arriving outside a transaction. **This and §6.3 are one workstream** (Appendix B/S2).
- **Roles.** `caratos_app` (non-owner, `NOBYPASSRLS`, DML grants only) becomes the runtime `DATABASE_URL`; the schema owner moves to `directUrl = env("MIGRATE_DATABASE_URL")`. `caratos_platform` (targeted by no policy) backs `PlatformPrismaService`. **Grant BYPASSRLS to no application role** — the on-prem agent needs no exemption.
- **`ENABLE` + `FORCE ROW LEVEL SECURITY`** on every enforced table (owner-bypass silently disables policies otherwise).
- **Policy classes.** **A** — the 51 org-bearing tables: `USING ("organisationId" = app.current_org()) WITH CHECK (…)`; `WITH CHECK` is not optional. **A-nullable** — the 3 nullable-org tables extend the predicate with `OR "organisationId" IS NULL`, read only through the platform client. **B** — the 24 transitive children get a denormalised column, **not** a subquery policy. **C** — `LoginOtp` and `_prisma_migrations` stay RLS-free, documented in the migration. *(`DocSequence` leaves class C once it gains an org column — Appendix B/C11.)*
- **Rollout.** Per table: a pre-flight audit proving `organisationId IS NOT NULL` (and child-equals-parent for class B), then `ENABLE + FORCE + policy`. Tranches: T1 leaf/append-only → T2 CRM/ops → T3 money/stock → T4 integration/jobs → **T5 identity last** (`User`, `Store`, `Region`, `UserStore`), after the platform client is proven.
- **Rollback.** Every enable ships with its exact inverse `DISABLE ROW LEVEL SECURITY` recorded in the PR (Prisma has no down-migrations). Keep policies in place when disabling. Platform kill switch: `ALTER ROLE caratos_app BYPASSRLS`.
- **Testing.** **One** DMMF-driven spec, not 75 hand-written: enumerate enforced models, assert `SELECT count(*)` over org B's rows is 0 under org A's GUC, assert an INSERT with org B's id fails `WITH CHECK`, and assert an unset GUC raises.
- **Cost.** Every request now holds a connection for its full duration. Raise `DB_POOL_SIZE` before T1 and measure; set an explicit interactive-transaction timeout well above Prisma's 5s default (`sync.service.ts` already passes 120s where needed).

---

## §8. CONTROL PLANE / APPLICATION PLANE — **MISSING**

One repo, one Prisma schema, **two bootstraps**. `backend/src/platform/` mounted at `/platform/*` with its own guard chain and its own `JwtModule`. Extract to a second entrypoint (`main.platform.ts`, separate Railway service, own hostname) at the first external tenant.

- **`PlatformUser` + `PlatformRole`** — a separate table, never a fifth `Role`. The tenant `Role` enum stays at four values permanently.
- **Separate signing secret + `aud` claim.** Platform tokens use `PLATFORM_JWT_SECRET` with `aud: 'platform'` and ≤8h expiry (≤60min for impersonation); tenant tokens gain `aud: 'tenant'`. **Fail boot if the two secrets are equal.**
- **`PlatformAuthGuard` must not honour `@Public()`** — write it without reading `IS_PUBLIC_KEY` at all, so no `/platform/*` route can opt out.
- **`OrganisationStatus`** replaces the dead `isActive`, enforced in `JwtAuthGuard` before `resolveScope` runs. Resolved value set (Appendix B/C5): `provisioning | onboarding | active | past_due | suspended | exporting | closed`. Keep `isActive` as a derived read for one release.
- **`Plan` + `OrganisationEntitlement`**, resolved once per request from a `TenantContextService` cache keyed on `Organisation.configVersion` (bumped by every control-plane write, so changes propagate within one request rather than one TTL). `EntitlementGuard` is **annotate-to-gate**, not deny-by-default.
- **Impersonation.** `POST /platform/organisations/:id/impersonate` takes an explicit `impersonatedUserId`, a mandatory reason, and returns a **tenant-audience** token with `imp` = grant id. **Read-only by default**, enforced by a method-based guard (rejects non-GET) so no route can be forgotten; `read_write` requires a second platform approver — reuse the existing `assertNotSelfApproval`. Impersonated actions write **both** trails: the tenant `AuditLog` (actor = the impersonated user, which is accurate) with `metadata.impersonatedBy`, and `PlatformAuditLog` for grant/start/end **on a path that throws if it cannot record**.
- **`PlatformAuditLog` is a separate table.** Do **not** relax the tenant `AuditLog` FKs to accommodate operators (Appendix B/C4).
- **Move `GET /scheduler/runs`** to `/platform/jobs/runs`; keep a tenant-facing version that injects `@CurrentUser()` and filters by org (D-2).
- **Delete `config-seed.ts`** — industry defaults become a step of `TenantProvisioning`, parameterised by `Organisation.industryPackCode`, always with an explicit org and store.

---

## §9. INTEGRATION ARCHITECTURE — **MISSING**

### 9.1 Spine

`IntegrationProvider` (platform catalogue, the only org-less table) → `Integration` (tenant install: org NOT NULL, providerKey, status, config, health fields) → `IntegrationCredential` · `IntegrationCapability` · `IntegrationAsset` · `WebhookEndpoint` · `WebhookDelivery` · `IntegrationLog`.

**Naming resolved** (Appendix B/C6): **`Integration`** + **`IntegrationCredential`**. `OrganisationIntegration`, `IntegrationConnection`, `ConnectorConnection` and `OrganisationSecret` were four names for this one pair.

### 9.2 Four narrow ports — **PARTIAL**

Keep `IntegrationConnector` (discover→sync) **unchanged** as the bulk-data port; add `MessageChannel`, `LeadSourceChannel`, `AdInsightsSource` as siblings. Add `mode: 'cloud_pull' | 'agent_push' | 'file_upload'` and make `inspect`/`extract`/`transform` optional.

### 9.3 Credentials — **MISSING**

`secretRef` is a discriminated string: `env:WHATSAPP_ACCESS_TOKEN` (the legacy path, so Organisation #1 keeps working bit-identically) → `enc:v1` (AES-256-GCM envelope, per-row DEK wrapped by a platform master key, `keyVersion` for rotation) → later `kms:…`/`sm:…` **with no schema change**. Platform values (`DATABASE_URL`, `JWT_SECRET`, `CORS_ORIGINS`, the master key) stay in env — that split is the point. Do not build a vault abstraction with one implementation.

### 9.4 Webhooks — **PARTIAL**

Order: **verify signature with the platform app secret → parse → resolve tenant from the verified payload → process.** Two routing mechanisms: payload-keyed for the Meta family (one app-level callback), path-keyed opaque `endpointKey` for everyone else.

**Resolved (Appendix B/C8): persist, never drop.** An event that resolves to no tenant is stored as a `WebhookDelivery` with `organisationId` NULL and `status='unresolved'`, alerted and retained — **after** signature verification, so it is not an unauthenticated write amplifier. Dropping is silent data loss on a customer/money path.

Keep the store-then-200-then-process shape and the conditional-update claim; **partition the sweep per organisation** so one tenant's inbound volume cannot starve another's. Exempt webhook routes from the per-IP throttle and bound abuse per integration instead.

---

## §10. META ARCHITECTURE — **FUTURE**

**One company-owned Meta Developer App**; tenant admins authorize into it. CaratOS never requests or stores a customer's Facebook/Instagram password.

Flow: admin clicks *Connect Meta* → redirect with `state` = a signed single-use nonce bound to `{organisationId, userId, expiresAt}` → callback exchanges the code → enumerate the asset graph → **an explicit picker** so the admin chooses which assets to connect → persist `IntegrationAsset` rows + `IntegrationCredential`.

Asset graph as **one self-referencing `IntegrationAsset` tree**, not five tables: `business → {ad_account, page, waba}`, `page → ig_account`, `waba → phone_number`. `@@unique([integrationId, assetType, externalId])` + `@@index([externalId])` for webhook resolution.

Token lifecycle: store `expiresAt` + `scopesGranted`; a per-org `meta.token-refresh` job via `runOnce`; on refresh failure or a deauthorize callback set `status='needs_attention'|'revoked'`, stop that integration's jobs, surface a re-auth prompt.

**Not designed here, and required before build (all FUTURE):** app review scope and timeline for one app serving N tenants · business verification (per tenant vs per app) · WABA/phone-number provisioning as an *operational* surface (who buys the number, who approves templates, who owns messaging quota) · rate limits under a shared app secret · BSP vs direct integration · per-conversation cost attribution back to a tenant. A "Meta architecture" that omits the operational surface is a schema, not an architecture.

---

## §11. WHATSAPP ARCHITECTURE — **REQUIRES REFACTOR**

Today: one WABA, one phone number, one token, one app secret for the entire platform (`WHATSAPP_*` env). Inbound is genuinely good — signature verification, `wamid` idempotency, a conditional-update claim, a 5-minute sweep. Outbound is fire-and-forget with **no delivery record** (`WhatsAppEvent.direction` exists and nothing ever writes `'outbound'`).

**Migration by seeding a row, not by branching code:**
1. Give every send an `organisationId` first parameter — 8 verified call sites (`auth.service.ts:396`, `quotes.service.ts:136`, `reporting.service.ts:494` & `:761`, `integrations.controller.ts:62/64`, `whatsapp-bot.service.ts` ×4).
2. Seed one `Integration` row for Organisation #1 with `secretRef='env:…'` → behaviour is bit-identical.
3. Resolve credentials per org through `SecretsService`.
4. New tenants get `enc:v1` credentials and their own WABA.

Also fix: `WhatsAppIdentity.phoneE164` / `WhatsAppSession.phoneE164` / `WhatsAppEvent.wamid` are **globally** unique — coherent only while one number serves everyone. `completeLinking` bcrypt-compares against **every** unconsumed link code on the platform (cap the candidate set; the code itself is the tenant proof). Phone normalisation hardcodes `+91` in two duplicated places. `dsr-flow.ts` embeds jewellery fields (`oldGoldWtG`) in the messaging core. **Missing:** 24h session-window tracking and a template catalogue, yet OTP/quotes/reports all send free-form text.

---

## §12. INSTAGRAM ARCHITECTURE — **MISSING / FUTURE**

**Honest statement: there is no material for a design here.** Total existing surface: `instagram` as a `LeadSource` enum value and `instagram_dm` as a proposed `Conversation.channel` literal. `grep -rn instagram backend/src` returns only enum/label text.

Architecturally, Instagram DM is **one more channel in the unified `Conversation`/`Message` model** — not a separate CRM path — reached through the same Meta app, asset tree, webhook route and normalisation step as WhatsApp. Everything specific to it is FUTURE and requires provider documentation: IG Business ↔ Page linkage, the messaging permission model, comment-vs-DM ingestion, Story mentions, media handling, and **the identity-scoping question in Appendix C1 — which determines a uniqueness key and must be settled before `ContactPoint`/`Conversation` are migrated, not after.**

---

## §13. AI ARCHITECTURE

**Visual search — EXISTS, and is the healthiest subsystem.** DINOv2 + SigLIP dual embeddings, org-scoped `ProductEmbedding` and `SimilaritySearchFeedback`, in-app cosine ranking, honest degraded states. Category is a **soft, opaque-string boost — never a hard filter** — so ranking already works on non-jewellery images. Coupling is cosmetic (`jewelry-*` file/class names, the `/products/jewelry/similarity-*` path) plus calibration constants tuned on jewellery-on-white.

**To generalise — PARTIAL:** move the calibration anchor curve and thresholds to a per-org/per-industry profile (the feedback table already versions `rankingVersion` + `modelVersions` for exactly this); make preprocessing (segmentation on/off, pad colour) a per-industry setting; retire the **zombie** single-embedding system (`ai-image-search.service.ts` — its `reindex` is unreachable, `Product.embedding` is never populated by any reachable path, and its Claude-vision prompt is hardcoded to "an Indian jewellery retailer"), relocating the two shared pure helpers first.

**AI qualification — MISSING.** No LLM qualification exists; `assistant.service.ts` is a deterministic keyword intent router whose own docblock names itself as the correct seam to put a model *in front of*. Design: `AiQualificationConfig` (per org/campaign/adset, versioned prompt + policy, `isEnabled` default false), `QualificationQuestionSet` (`mapsTo` is the only coupling to the universal core), `LeadRequirement`, `LeadSignal` (append-only, `kind` is a string not an enum), `LeadScoringPolicy` + `LeadScore`.

**Scoring must be configurable and explainable.** Replace `computeTemperature` (hardcoded 7d/30d/3d/14d thresholds, computed at read time, never persisted). `LeadScore.contributions` stores `[{signalKind, observedValue, weight, points, ruleIndex}]` — **the arithmetic is the explanation**; an LLM-written justification for a deterministic sum is a new failure mode, not a feature. Bands are tenant-named, not three hardcoded English words.

**Handoff** is a `Conversation.status` transition plus a `RoutingDecision`, not a new model. Triggers: band crossed, confidence below floor, `maxTurns` reached, explicit customer ask, or **any AI error — fail toward a human, never toward silence.**

**Guardrails:** never route money or approval answers through a model; never let a generated summary feed the score.

---

## §14. CONNECTOR ARCHITECTURE — **MISSING (contracts EXIST)**

`backend/src/integration/contracts/` is 672 lines of well-shaped, **entirely unconsumed** types: **zero** classes implement `IntegrationConnector`, `ImportProfile` has no table, and `SyncState` has zero code references.

- **`ConnectorRuntimeService`** — one orchestrator owning the lifecycle. It does not parse, query or map; it sequences and **persists**: opens the batch, writes `SourceLink` per record, captures `RecordIssue`s, advances the watermark, closes the batch.
- **`GatiConnector`** — a **sink adapter over the untouched `SyncService`**, not a rewrite. New code is three methods (`discover`, `reconcile`, `sync`); `mode: 'agent_push'`.
- **`FileUploadConnector`** — wraps the working CSV/XLSX engine; zero new parsing code.
- **Generic SQL belongs in the agent**, not the cloud (`sql_source.py` driven by a per-install profile). **Do not add a SQL client to the backend.** REST is legitimate cloud-pull only because the customer deliberately exposes the endpoint. This audit originally left Shopify, Tally and BUSY blocked. BUSY customer masters were subsequently verified against the Ashish Textile installation and implemented as a narrow outbound-agent adapter; every other BUSY entity and direct Tally remain blocked rather than guessed.
- **`SourceLink`** — polymorphic multi-source provenance, `@@unique([organisationId, entityType, sourceSystem, externalId])`, written by **every** ingestion path.
- **Field ownership** — implement `SourceOwnershipPolicy` by moving the existing stock-transfer protection out of `sync.service.ts` **verbatim** as the first static rule, plus a sparse `FieldOwnershipOverride` table.
- **Collapse duplication:** three parallel mapping vocabularies (`FieldMapping` / `FieldMappingInput` / `MappingSuggestion`) → one; two entity vocabularies (`EntityKind` / `ImportEntity`) → one.
- **Field dictionary becomes a per-industry pack** — jewellery aliases (`designcode`, `stylecode`, `tagno`, `touch`, `fineness`, metal/karat/weight) move out of the shared core.
- **D-1 fix, two steps.** (1) **Ship today, one line:** refuse `purgeDemo` when the org has any `ImportBatch` with `imported > 0`. (2) **Real fix:** change the predicate from "has no Gati id" to "has no provenance of any kind" via `SourceLink` — and change **both** the count-plan and the `deleteMany` to the same predicate, or the dry-run stops matching the execution (Appendix B/D4).

---

## §15. CARATOS CONNECT ARCHITECTURE

**Outbound-only posture — EXISTS, preserve unchanged.** No listening socket; all traffic agent→cloud HTTPS; the four-layer read-only guarantee in `SAFETY.md` is the template every future source connector inherits. The cloud never dials into a customer network.

**Changes — REQUIRES REFACTOR:**
- **Agent identity is a machine credential, not a `head_office` human.** `AgentAuthGuard` accepting `Authorization: Agent <token>`, resolving `(organisationId, connectionId)` from `ConnectorConnection.agentTokenHash` (bcrypt — the pattern already proven in `whatsapp-identity.service.ts`). The agent principal is **not** a `User`, carries no `Role`, and therefore **cannot satisfy `@Roles('head_office')`** — which today also grants it `purge-demo`, `reset`, `prune-stores` and `reset-users`.
- **Enrolment + rotation** reuse the `WhatsAppLinkCode` mechanism wholesale (single-use, bcrypt-hashed, TTL, `consumedAt`).
- **Per-org config replaces three platform env vars** (`SYNC_DEFAULT_STORE_ID`, `SYNC_BRANCH_COLUMNS`, `SYNC_UNATTRIBUTED`) — **preserving the fail-closed behaviour verbatim**: an unset default store must still throw. *There is no main store; never fall back to a branch.*
- **Offline queue** — files, not a broker: 3 attempts with exponential backoff + jitter on 5xx/timeout, 4xx non-retryable; gzip failed chunks to `spool/`, drain `spool/` **first** on the next run, move to `spool/dead/` after N cycles and surface in the heartbeat.
- **Heartbeat + staleness alerting** riding the existing hourly scheduler via `runOnce`.
- **Media keys become org-prefixed** and the agent **stops holding R2 credentials** — it requests a short-lived presigned PUT instead.
- **Collapse three divergent agent copies** (`HANDOVER/EclatSync/`, the tracked-but-deleted `data_sync/EclatSync/`) — `synceclatcaratsense/` is the only lineage. Add `AGENT_VERSION` on every heartbeat; reject ingests below a minimum version.
- **Server-side watermark:** wire `SyncState` (already correctly org-scoped, currently dead) so the platform knows each tenant's freshness. Keep the agent's local file as the extraction cursor.

---

## §16. CUSTOMER 360 ARCHITECTURE — **MISSING**

**The single highest-value fix in the entire report: every write path must resolve identity.** Before any lead / walk-in / quote / sale / custom-order create, call `IdentityService.resolveOrCreate(org, {name, phone, email})` and stamp `partyId`. Keep `customerName`/`phone` as the captured-at-the-time snapshot (legitimate provenance) but make `partyId` the join. **An org-scoped phone-then-name resolver already exists** at `integration/import/entity-importers.ts:52-66` and is unreachable from any app path — lift it into a shared service rather than writing a second one.

**Identity resolution.** `ContactPoint` is the alias layer. Normalisation must become country-aware: `normalizeIndianMobile` rejects any non-Indian number, so the identity layer is India-only today — a hard tenancy blocker. Replace with `normalizePhone(raw, defaultCountryCode)` returning E.164, defaulting from the organisation; **keep the strict character discipline** (letters/symbols rejected, never salvaged) and demote only the "10 digits starting 6-9" gate to a country rule.

**Never silently merge.** `PartyMergeCandidate` (score + `matchedOn[]` + status) → human review → `PartyMerge` (survivor, merged, actor, reason, **reversible**).

**`ActivityEvent` is the timeline** — append-only, org-scoped, with `kind` from a dotted registry, `subjectType`/`subjectId`, and optional `partyId`/`leadId`/`opportunityId`/`conversationId`/`visitId`/`storeId`.

**`ActivityEvent` and `AuditLog` stay separate, correlated by id.** `AuditLog` answers *which employee changed what* (actor must be a User, governance retention); `ActivityEvent` answers *what happened with this customer* (actor may be a customer, webhook or scheduler, business retention). Where an action is both, write both.

**Reject a standalone `Interaction` table** — it is a filtered projection of `ActivityEvent`. Only concepts with independent lifecycle state get their own row (a `Message` has delivery status, a `Task` completion, a `Visit` a check-out).

**Customer 360 is a read API over the write models** — do not build a materialised projection until it is measurably slow.

**Consent is a first-class column set** (`marketingConsent`, `consentSource`, `consentAt`, `dnd`, `anonymisedAt`) — none exists today, and touch data is PII. Erasure anonymises rather than deletes where financial immutability applies.

---

## §17. ATTRIBUTION ARCHITECTURE — **MISSING**

`MarketingCampaign` is **extended, not replaced**: add `provider?`, `externalId?`, `objective?`, `currency?`, `spendSource(manual|provider|mixed)`, and relations to `AdSet`/`Ad`/`AttributionTouch`. `AdSet` and `Ad` are **optional rungs** — a touch may reference a campaign with no ads.

- **`AdSpendDaily`** replaces the scalar `spend` column as the reporting source, `@@unique([organisationId, provider, date, campaignId, adSetId, adId])` so a re-sync upserts rather than double-counts. Store provider currency + amount verbatim plus an optional base amount **with the `fxRate` and its date** — never a converted-only figure.
- **`AttributionTouch`** — the immutable observed-contact ledger, storing `identityKeyHash` rather than raw phone/email.
- **`AttributionResult`** — versioned, recomputable credit allocation stamping the `windowDays` it was computed under, so a later config change cannot silently reinterpret old results. Windows are **per-organisation configuration** (a jewellery 90-day window is nonsense for a pharmacy refill).
- **`LeadQualification`** — qualification as an explicit, evidenced event. The read-time `computeTemperature` heuristic must **not** be the qualified-lead metric.
- **Honesty rules.** `AttributionStatus` is a NOT NULL enum on Lead/Qualification/Visit/Sale: `attributed`, `no_touch_recorded`, `no_identity_match`, `outside_window`, `source_data_unavailable`, `provider_not_connected`, `declared_only`. **(a)** NULL never means unknown — unknown is a stored value. **(b)** No `direct`/`other` catch-all that reads as a channel. **(c)** Never fall back to the org's only campaign or the most recent one.
- **`Lead.source` is a *declared* source** and must never populate an attributed report. "Leads by declared source" and "leads by attributed campaign" are two separate, never-summed surfaces, each labelled with its basis.
- **Reporting.** Every derived metric (CAC, ROAS, conversion rate, lead-to-sale) is `number | null` — **null when the denominator is zero or unknown, never 0 and never Infinity** — and every row carries a `coverage` share.
- **Compounding gap to note:** manual sales write **no `SaleLine` at all** (`sync.service.ts` is the only `saleLine` writer), so a keyed-in sale has zero product attribution.

**Resolved (Appendix B/C7):** `AttributionTouch` is the fact; `AttributionResult` is the credit; `Lead` carries only `attributionStatus` + a denormalised `campaignId?`. Attribution-as-columns-on-Lead is rejected. A touch emits both an `AttributionTouch` (fact) and an `ActivityEvent` (timeline projection).

---

## §18. CONFIGURATION ARCHITECTURE — **MISSING**

- **`Organisation.industryPackCode` + `settings Json`.** **Not** an `industry` Postgres enum — that reproduces the exact closed-enum trap being escaped. `settings` holds only small non-queryable scalars; anything filtered or joined gets a real column.
- **`IndustryPack` = versioned data**, authored as a checked-in JSON manifest, applied by one **idempotent** `PackProvisionerService.apply(organisationId, packCode, version)` that writes only rows and **never overwrites a value the tenant has edited** (`tenantEdited` flag).
- **`TaxonomyTerm`** replaces the 12 closed enums — `@@unique([organisationId, taxonomy, code])`. Migration is a **value-preserving** `ALTER COLUMN … TYPE TEXT USING …::text` + `DROP TYPE`; the Prisma field becomes `String`. **Do not** convert to an FK on `TaxonomyTerm.id`.
- **`@IsEnum` → `@IsTaxonomyTerm`** across the **46 sites in 17 files** (corrected from an inflated 47/24), backed by a per-org cache. The 12 *non-taxonomy* enums (`Role`, `ApprovalStatus`, `LeaveStatus`, …) stay as enums — they are platform semantics, not industry vocabulary.
- **`AttributeDefinition` + JSONB `attributes`, not EAV.** One column, no join per read, GIN-indexable. The key mechanism: **`storage: 'column' | 'attributes'`**. Organisation #1's jewellery pack ships `karat` as `storage:'column', columnName:'karat'` pointing at the real column, while a pharmacy pack ships `dosage` as `storage:'attributes'`. A single `AttributeService` resolves the indirection, so **Eclat backward compatibility is free** — the UI, importer, search and validation only ever see the definition.
- **`WorkflowDefinition`/`WorkflowStage`** replace the `order-stages.ts` const maps — **keeping the exported function names and signatures** (`nextStages`, `assertTransitionAllowed`, `assertStageRoleAllowed`) and changing only their source.
- **`FieldPolicy`** (required/recommended/optional/hidden) enforced once in a validation service, not by adding decorators per DTO.
- **`GET /config/bootstrap`** — one endpoint returning taxonomies, attribute definitions, field policies, workflows, labels and settings, cached in react-query. This is what de-hardcodes the frontend.
- **Config cache** keyed on `Organisation.configVersion`. **No Redis.**
- **Worked examples.** *Jewellery* (generate the manifest **from the existing enum members** so every code is byte-identical): `product_material` = gold_24k…gold_9k, rose_gold_18k, platinum, silver, gold_unspecified; attributes karat/grossWeight/stoneWeight as `storage:'column'`. *Pharmacy*: `product_category` = tablet/capsule/syrup/injection/ointment/device/otc; attributes manufacturer, composition, strength, dosageForm, packSize, hsnCode, scheduleClass — all `storage:'attributes'`; `Product.metal` hidden by FieldPolicy. *Textile*: fabric_type, colour, size_scale; attributes fabric, gsm, colour, width, lengthMetres, pattern.
- **Jewellery-only models stay in place**, gated by pack capability: `MetalRate`, `DiamondRate`, `ProductionBag`, `ManufacturingOrder(Item)`, and the gold-savings triad. Gate the **modules**, not the tables.
- **Behaviour-parity golden test for Organisation #1** — after applying the jewellery pack: every historical enum value round-trips unchanged; `nextStages()`/`assertTransitionAllowed()` return identical results for all stage pairs; `POST /products` without `metal` is still rejected for `org_eclat`; the GOLD_METALS-driven KPIs still compute. **Wire it into CI in the same PR.**

---

## §19. STORAGE ARCHITECTURE — **PARTIAL**

`StorageService` is one class, one method, three branches, with a **real** tenant key prefix `org/<organisationId>/…` and a fail-closed `if (!organisationId) throw` enforced at all 5 call sites — but it is **uncommitted**, so production R2 still holds flat keys.

- **Commit the prefix as-is**; do not rewrite historical keys (old rows keep their flat URLs; only new writes get the prefix).
- **Non-guessable keys** — append a random suffix (one line; `node:crypto` is already imported).
- **Authorization on every access.** Persist the storage **key**, not an absolute URL. Serve through an authenticated `GET /media/:ownerType/:ownerId` that loads the owning row org-scoped, mints a ~5-minute presigned GET, and 302s. Then make the bucket **private** and drop `R2_PUBLIC_BASE_URL` from the required set. Add query-string SigV4 to the existing `sigv4.ts`.
- **Remove the unauthenticated `/uploads` static route in production** (D-11) — but **remove the local-disk fallback first**, or those rows turn from insecure-but-working into hard 404s (Appendix B/D5). In production an R2 failure becomes a 503, never a silent disk write whose URL is persisted forever.
- **One class, widened** to `save / signedGetUrl / delete / exists` with per-provider private objects selected once in the constructor — **not** an interface + factory for three providers. Retire the Cloudinary branch (it hardcodes an `eclat/` prefix — a single-tenant artefact).
- **`StorageObject`** written at `save()` (buffer length and key are both already in hand) — it doubles as the deletion/erasure index the service lacks. Do **not** size usage by listing the bucket.
- **Provider independence:** R2 today, S3 later, as two drivers behind the same class.

---

## §20. BACKUP / DR ARCHITECTURE — **MISSING**

Verified: zero `RPO|RTO|PITR|point-in-time` matches across `docs/*.md`; no restore-test record anywhere.

- **Own the backup.** A scheduled `pg_dump -Fc`, encrypted (age/gpg with a key held only by the operator), uploaded to **a different cloud account from both the database and the media bucket**. Daily full, 30-day retention, plus a retained monthly. Keep the platform's own automated backups as a second, independent copy.
- **PITR** — confirm whether the managed plan offers it and to what window; record that window as the pooled RPO, or explicitly accept the dump-interval RPO. **Do not leave it unstated.**
- **Proposed targets** (to be ratified, then tested): pooled **RPO ≤ 24h** (tightening to ≤5min if PITR is confirmed), **RTO ≤ 4h**; silo **RPO ≤ 15min**, **RTO ≤ 1h**.
- **Restore testing is the only thing that makes a backup real.** A quarterly scripted drill: restore into a throwaway database, assert per-organisation row counts on anchor models (Sale, Payment, StockItem, User, AuditLog), record wall-clock restore time against the stated RTO, and log the result in `docs/DECISIONS.md`.
- **Pre-migration snapshot gate** — take a snapshot immediately before `prisma migrate deploy`, or gate the tenancy migration behind a manual run with a hand-taken snapshot. **Do not let the 448-line NOT NULL/FK rewrite reach production from an automatic deploy** (§0).
- **Remove `seed-user-phones.mjs` from `preDeployCommand`** — in the **same commit** as the tenancy migrations, not a phase later (D-9, Appendix B/S8).
- **Object versioning** + a non-current-version lifecycle rule (Cloudflare capability = FUTURE, verify against provider docs). Independently, random key suffixes mean a replaced image writes a **new** key, so the old object simply ages out.
- **Per-tenant export** — one endpoint producing an NDJSON bundle + media manifest, built by **reusing the DMMF-driven `orgScopedWhere` walk already written** in `sync.service.ts`. It is the silo-migration and data-subject-export vehicle. **It is not a point-in-time restore** and must never be described as one.
- **Region/AZ failover:** either design it or record "single region, accepted" as an explicit decision.

---

## §21. SECURITY ARCHITECTURE

**Preserve unchanged:** DB-authoritative org resolution, `StoreScopeService` fail-closed scoping, HMAC webhook verification with `timingSafeEqual`, `ValidationPipe` (`whitelist` + `forbidNonWhitelisted` + `transform`), security headers, `JWT_SECRET` length/placeholder checks at boot, `trust proxy 1`.

**Add / fix:**

| Area | Status | Action |
|---|---|---|
| Tenant isolation | PARTIAL | §6 + §7; app-level stays mandatory |
| `Organisation` status at auth | MISSING | One join on a query that already runs (D-3) |
| Session revocation | MISSING | `User.sessionsValidFrom` / `Organisation.sessionsValidFrom` compared to token `iat` — cuts a compromised session or suspended tenant **without rotating the platform secret** |
| Per-tenant secrets | MISSING | Envelope encryption + `keyVersion`; never plaintext columns, never env for tenant values |
| Secret rotation | MISSING | Write ciphertext at `keyVersion+1`, re-wrap in a background pass; readers accept any version |
| Webhook idempotency (money) | PARTIAL | `@@unique([organisationId, reference])` on `Payment`; replace check-then-insert with insert-catch-P2002 (D-4) |
| Rate limiting | PARTIAL | Subclass `ThrottlerGuard`, `getTracker` → `user?.organisationId ?? req.ip` (~10 lines). Keep the in-memory store until replica 2; move lockout to DB/Redis **at** that moment, not before |
| Non-production signature bypass | REQUIRES REFACTOR | Remove it — an unsigned body must never be accepted anywhere |
| Agent privilege | REQUIRES REFACTOR | Machine credential scoped to `/sync/*` only — today it holds `head_office` and therefore the four destructive ops (§15) |
| File upload | PARTIAL | Validate type/MIME/signature/size; generated keys; never user filenames as paths |
| PII / retention / erasure | MISSING | One retention cron (WhatsAppEvent payloads, WhatsAppSession, WhatsAppLinkCode, LoginOtp, ScheduledJobRun); subject export/erasure reuses the org-walk, anonymising where financial immutability applies |
| Platform API exposure | MISSING | `/platform/*` unreachable from tenant tokens (`aud` claim + separate secret + guard that ignores `@Public()`) |
| Error leakage | EXISTS | Filter already avoids stack traces; add the correlation id to the client body |

---

## §22. QUEUE / EVENT ARCHITECTURE — **MISSING**

**One `Job` table generalising the two claim patterns already proven in production.** No Redis, no BullMQ, no broker.

- **Claim loop is one query:** `UPDATE "Job" SET status='running', attempts=attempts+1 … WHERE id IN (SELECT id FROM "Job" WHERE status='pending' AND "runAfter" <= now() ORDER BY "runAfter" LIMIT $n FOR UPDATE SKIP LOCKED) RETURNING *`. A reaper re-queues rows stuck in `running` past a visibility timeout.
- **Port:** `abstract class JobQueue { enqueue; enqueueMany }` + a handler registry keyed by `type`. Copy the shape **and the justifying docblock** from the existing `notification-bus.ts` — that abstract-class-plus-in-memory-impl pattern is already the house style. Nothing else imports the adapter.
- **Tenant context in the envelope** — `organisationId` mandatory, nullable only on allowlisted platform-plane types. The worker **re-resolves and re-validates** the org; it never trusts a serialised context object.
- **Idempotency** — `@@unique([queue, idempotencyKey])`; enqueue swallows P2002 as "already queued", exactly as `runOnce` swallows it as "already claimed".
- **Retry** — exponential backoff + jitter (base 30s, cap 1h, max 5). Provider 429/5xx retries; a 4xx validation failure goes straight to `dead` without burning attempts.
- **Dead letter** — a terminal `dead` status that something actually reads: `GET /jobs?status=dead` (org-filtered, manager+), `POST /jobs/:id/retry`, and an alert on first dead-letter per type per window.
- **Ordering** — `partitionKey` used in exactly two places: WhatsApp inbound keyed on `phoneE164` (a conversation state machine) and sync transforms keyed on `<org>:<entity>`. Everything else runs unordered.
- **Fairness** — cap in-flight jobs per organisation in the claim query. **Do not** build weighted fair queuing or priority lanes.
- **Worker** — same image, second Railway service, `WORKER=true` skips `app.listen()`; the API sets `SCHEDULER_ENABLED=false` (that kill switch already exists).
- **What moves to jobs:** webhook continuation, outbound messaging (with a delivery record — **except the login OTP, which stays synchronous because a user is waiting**), CSV import runs, embedding reindex (per chunk), payment reconcile, retention sweeps, attribution recompute.
- **What stays:** the two `@Cron` schedules — the hourly tick + per-store local-hour check + per-store `runOnce` claim is already correct and multi-timezone-safe. Only the process changes.
- **Notifications stay unqueued** — the row is persisted before publish and the REST feed is the durability guarantee. Add `organisationId` to `Notification` (it is the only major model in this domain without one) and implement `RedisNotificationBus` **at the moment a second replica exists** — this is a hard dependency of the worker split (Appendix B/S6).

---

## §23. AWS MIGRATION RECOMMENDATION — **FUTURE**

**Stage 0 — hold. Do not begin any AWS migration.** Ship multi-tenancy, the config layer and the queue on the current stack. The provider is not the bottleneck; the application's tenancy model is.

**Stage 1 — the one move worth making early: credential resolution.** Introduce a `CredentialResolver(organisationId, provider)` port with a process-env adapter first (zero infrastructure). Whether the backing store is Secrets Manager, Railway variables or an encrypted table is a later, independent choice **behind that port**. This unblocks per-tenant integrations regardless of hosting.

**Stage 2 — move compute and database together, only when a forcing function fires.** Target: CloudFront → ALB → ECS/Fargate (API + worker from the same image) → RDS/Aurora PostgreSQL → Secrets Manager → CloudWatch. **Move compute and DB in one step** — splitting them puts every query across a provider boundary.

**Forcing functions (none of which have fired):** contractual data residency · a regulated vertical · VPC/private networking for an enterprise tenant · backup/DR guarantees the current plan cannot meet · sustained scale the shared pool cannot absorb · an enterprise silo.

**Prerequisites — all provider-independent and worth doing anyway:** a real healthcheck wired in config (D-12), boot-time env validation (only `JWT_SECRET` is validated today), the queue + worker split, structured tenant-tagged logs, and an owned backup with a tested restore.

**Stage 3 — SQS behind the unchanged port.** Visibility timeout replaces the reaper, redrive replaces `dead`, `MessageGroupId` replaces `partitionKey`. Adopt EventBridge **only** when one event genuinely needs multiple independent consumers.

**Deliberately not adopted:** Step Functions (job chains here are two steps), Kinesis/MSK (there is no stream), EKS (two containers), DynamoDB (a second datastore doubles the tenancy surface), Lambda for the API.

**Not yet designed and required before any cutover (FUTURE):** cost comparison against current spend, task/instance sizing, the cutover mechanism (DNS, data migration, dual-write vs downtime window), rollback plan, and **what happens to the on-prem agent's endpoint during cutover**.

---

## §24. MIGRATION PHASES

Each phase is independently shippable, reversible, and leaves Eclat working.

### Phase 0 — Unblock (days). No new models. Every item closes a live defect.
Commit the tenancy surface **behind a snapshot gate and a staging rehearsal** · one-line `purgeDemo` `ImportBatch` guard (**D-1, ship first**) · org predicate + `@CurrentUser` on `GET /scheduler/runs` (D-2) · enforce `Organisation` status at auth (D-3) · `@@unique([organisationId, reference])` on `Payment` (D-4) · org-scope `ScheduledJobRun` (D-5) · remove the `'unassigned'` global store PK (D-6) · org-scope the synthetic staff email (D-7) · `Store.id` → cuid with an org-scoped clash check (D-8) · drop `seed-user-phones.mjs` from `preDeployCommand` (D-9) · delete `config-seed.ts` (D-10) · `healthcheckPath` (D-12) · **make CI actually run the 34 e2e specs** (un-ignore `.github/`, provision a hermetic test DB).

### Phase 1 — Tenant context + platform plane
`TenantContext` + ALS + `runAsPlatform` around the four verified cross-tenant queries · the Prisma tenant-guard extension + `orgTx` migration of the ~20 `$transaction` sites · `PlatformUser` + `PlatformAuthGuard` + `/platform` + `PlatformAuditLog` + `TenantProvisioning` · `AuditLog.actorId` nullable **with `actorKind`+`actorLabel`** · org column on the 24 transitive children · `DocSequence` + the nine `ref` uniques.

### Phase 2 — Configuration + industry packs
`Organisation.industryPackCode`/`settings`/country/currency/timezone · `IndustryPack` + idempotent applier (jewellery generated from the existing enums) · `TaxonomyTerm` + `FieldPolicy` + `AttributeDefinition` + `attributes` JSONB · enum→TEXT widening + `@IsTaxonomyTerm` · `GET /config/bootstrap` · **the Organisation-#1 behaviour-parity golden test, in the same PR.**

### Phase 3 — Integration spine + per-tenant credentials
`IntegrationProvider`/`Integration`/`IntegrationCredential`/`Asset`/`WebhookDelivery`/`Log` · the four ports · org-scoped connector registry · **WhatsApp env→Integration seed cutover** (Organisation #1 bit-identical via `secretRef='env:…'`) · `SecretsService` + envelope encryption · webhook throttle exemption.

### Phase 4 — CRM identity spine  *(the highest business value per unit of work)*
`ContactPoint` + `IdentityService` + country-aware phone normalisation · **write `partyId` on every create path** · merge candidates + reversible merge · `ActivityEvent` · `Task` assignee FK · `Lead.storeId` nullable **atomically with the unrouted queue** · `Conversation` + `Message`.

### Phase 5 — Queue + worker
`Job` + `PostgresJobQueue` + worker service · move webhook continuation, outbound messaging, imports and reindex onto it · dead-letter surface + retention sweeps · `RedisNotificationBus` **at replica 2**.

### Phase 6 — Connector runtime
`ConnectorRuntimeService` · `GatiConnector` (adapter, not rewrite) · `FileUploadConnector` · `SourceLink` + field ownership · persisted `ImportProfile` · agent machine credential + enrolment + offline spool + heartbeat.

### Phase 7 — Onboarding + admin UI + metering
`OrganisationOnboarding`/`OnboardingStep` · invite-code tenant context · `DeclaredSystem` · platform console screens · `UsageEvent`/`UsageDaily` + the single global interceptor (api_calls + request id + org-tagged logs) · `Plan`/`Entitlement` **advisory first**.

### Phase 8 — RLS
Roles + `directUrl` split → carrier proven in staging → five tranches, identity last → the DMMF-driven spec.

### Phase 9 — Attribution + AI qualification
`AdSet`/`Ad`/`AdSpendDaily`/`AttributionTouch`/`AttributionResult` · `AiQualificationConfig`/`LeadScore`/`RoutingRule`/`RoutingDecision`.

### Phase 10 — Meta / Instagram / Lead Ads  *(gated on Appendix C)*
Only after the provider questions in Appendix C are answered against real documentation.

---

## §25. RISKS

| ID | Risk | Sev | Mitigation |
|---|---|---|---|
| **R1** | Committing the tenancy layer = deploying a 448-line NOT NULL/FK rewrite to production, with no staging, snapshot or CI | **CRITICAL** | Staging from a production-shaped restore + manual snapshot + rehearsal **before** the commit; decouple commit from deploy for this one change |
| **R2** | `purgeDemo` destroys CSV-imported customer data on a **documented go-live operation** | **CRITICAL** | The one-line `ImportBatch` guard, shipped before anything else; then the `SourceLink` predicate — changing **both** the plan and the delete |
| **R3** | Provider assumptions (Appendix C) drive uniqueness keys the design itself calls "hard to unwind" | **HIGH** | Verify against provider docs **before** migrating `ContactPoint`/`Conversation`; keep the narrower `integrationId`-scoped key, which is safe under either answer |
| **R4** | `Lead.storeId` → nullable ships ahead of the unrouted queue → `storeFilter` excludes NULL, so inbound leads become **invisible with no error and no log** | **HIGH** | One atomic change including the org-level queue endpoint and a test asserting an unrouted lead is reachable |
| **R5** | `Product.metal` → nullable lands out of step with the `@IsEnum`→`@IsTaxonomyTerm` swap → Eclat either breaks product creation or silently accepts metal-less products | **HIGH** | Explicit order: seed and enforce `FieldPolicy` → **then** make the column nullable |
| **R6** | Eleven schema changes are each claimed by 2–5 design areas under different names | **HIGH** | Appendix A assigns exactly one owner and one name per change |
| **R7** | RLS enabled before the 24-child backfill is verified → a column rollback rolls back a live policy | **HIGH** | Backfill all 24, verify, **then** enable policies. Never interleave |
| **R8** | Two competing `$extends` designs on the same hook | **MEDIUM** | One extension, one owner, fixed composition order (§6.3) |
| **R9** | Per-request transactions for RLS exhaust the connection pool | **MEDIUM** | Raise `DB_POOL_SIZE` and measure before T1; explicit transaction timeouts |
| **R10** | Removing the static `/uploads` route before removing the local-disk fallback turns insecure-but-working rows into hard 404s | **MEDIUM** | Fallback first, route second, same phase |
| **R11** | Railway persistent-volume behaviour is **unverified** — the repo contains contradictory evidence | **MEDIUM** | Verify in the dashboard; the production fail-loud change makes it moot |
| **R12** | Worker split assumes an SSE-capable notification bus that does not exist | **MEDIUM** | `RedisNotificationBus` is a named prerequisite of Phase 5 |
| **R13** | `User.email` moving to org-scoped breaks login if host resolution is not live | **MEDIUM** | Order: host resolution → then org-scoped handles; interim = org-suffixed generated handles |
| **R14** | Enum→TEXT widening is hard to reverse once written | **MEDIUM** | Value-preserving migration + the Organisation-#1 golden test in the same PR |
| **R15** | Persisting unresolvable webhook events grows unbounded | **LOW** | Retention sweep + staleness alert; store only post-signature-verification |

---

## §26. DEPENDENCIES

**Hard ordering (each strictly precedes the next):**
`Commit + apply tenancy` → `TenantContext + platform plane` → `org column on 24 children` → `RLS`.
`Config layer` → `enum widening` → `industry packs`.
`Integration spine + SecretsService` → `per-tenant WhatsApp` → `Meta` → `Lead Ads / Instagram`.
`ContactPoint + IdentityService` → `Conversation` → `AI qualification` → `attribution`.
`Job queue` → `worker split` → (`RedisNotificationBus` **required at replica 2**).
`SourceLink` → `purgeDemo` real fix → `spreadsheet onboarding`.

**External / non-engineering dependencies:** Meta Developer App ownership, business verification and app review · a WhatsApp BSP-vs-direct decision · a Railway plan supporting PITR (or a decision to accept the dump-interval RPO) · a second cloud account for off-platform backups · provider documentation for every named integration · a staging environment.

**Cross-cutting prerequisites that four or more phases depend on:** CI that actually runs tests · a staging database from a production-shaped restore · the pre-migration snapshot gate.

---

## §27. EXACT IMPLEMENTATION ORDER

The completeness critic's finding stands: this is the artefact the whole report exists to produce, and no single design lane could produce it. Ordered, with the one owner per item from Appendix A.

| # | Item | Owner area | Gate |
|---|---|---|---|
| 1 | `purgeDemo` `ImportBatch` guard | Connector | — |
| 2 | Staging DB from a production restore; CI runs `test:e2e` | Platform ops | — |
| 3 | Commit tenancy surface + apply behind a snapshot | Tenancy | 1, 2 |
| 4 | Drop `seed-user-phones.mjs`; delete `config-seed.ts` | Control plane | 3 *(same commit as 3)* |
| 5 | `/scheduler/runs` org predicate; `ScheduledJobRun` org key | Control plane | 3 |
| 6 | `Organisation.status` enforced at auth | Control plane | 3 |
| 7 | `Payment` org+reference unique | Security | 3 |
| 8 | `Store.id` → cuid; remove `'unassigned'`; org-scope staff email | Connector | 3 |
| 9 | `healthcheckPath`; boot-time env validation | Platform ops | — |
| 10 | `TenantContext` + ALS + `runAsPlatform` on the 4 cross-tenant queries | Tenancy | 3 |
| 11 | Prisma tenant-guard extension + `orgTx` (**one workstream with 22**) | Tenancy | 10 |
| 12 | `AuditLog.actorId` nullable + `actorKind` + `actorLabel` (one migration) | Tenancy | 3 |
| 13 | `PlatformUser` + `PlatformAuthGuard` + `/platform` + `PlatformAuditLog` | Control plane | 10 |
| 14 | `TenantProvisioning` + `OrganisationOnboarding` | Onboarding | 13 |
| 15 | org column on the 24 transitive children (backfill all, verify) | RLS | 3 |
| 16 | `DocSequence` org + nine `ref` uniques | CRM | 3 |
| 17 | Config: `IndustryPack`, `TaxonomyTerm`, `AttributeDefinition`, `FieldPolicy` | Config | 3 |
| 18 | enum→TEXT + `@IsTaxonomyTerm` + **golden parity test** | Config | 17 |
| 19 | `Product.metal` nullable | Config | 18 |
| 20 | Integration spine + `SecretsService` | Integration | 13 |
| 21 | WhatsApp env→Integration seed cutover | Integration | 20 |
| 22 | RLS: roles + `directUrl` + carrier proven in staging | RLS | 11, 15 |
| 23 | RLS tranches T1→T5 (identity last) | RLS | 22 |
| 24 | `ContactPoint` + `IdentityService` + country-aware phone | CRM | 3 |
| 25 | Write `partyId` on every create path | CRM | 24 |
| 26 | `ActivityEvent`; `Task.assigneeId` | CRM | 24 |
| 27 | `Lead.storeId` nullable **+ unrouted queue (atomic)** | CRM | 25 |
| 28 | `Conversation` + `Message` | CRM | 24, **C1 verified** |
| 29 | `Job` + `PostgresJobQueue` + worker service | Queue | 5 |
| 30 | `RedisNotificationBus` | Queue | 29 *(at replica 2)* |
| 31 | `SourceLink` + field ownership + `purgeDemo` real fix | Connector | 20 |
| 32 | Connector runtime + `GatiConnector` + `FileUploadConnector` | Connector | 31 |
| 33 | Agent machine credential + enrolment + spool + heartbeat | Connect | 32 |
| 34 | Storage: authorized `/media`, private bucket, remove fallback **then** route | Storage | 3 |
| 35 | Owned encrypted backups + **restore drill** + RPO/RTO ratified | Backup | 2 |
| 36 | Global interceptor: request id + org-tagged logs + `api_calls` | Observability | 10 |
| 37 | `UsageEvent`/`UsageDaily`; `Plan`/`Entitlement` (advisory) | Billing | 36 |
| 38 | Attribution tables + reporting with null-safe denominators | Attribution | 25, 27 |
| 39 | AI qualification + routing + `RoutingDecision` | AI | 28 |
| 40 | Meta / Lead Ads / Instagram | Integration | **Appendix C answered** |

---

## APPENDIX A — CROSS-AREA OWNERSHIP (the missing artefact)

Eleven changes were each claimed by 2–5 design lanes under different names, field sets and phases. One owner, one name, one phase:

| Change | Claimed by | **Owner** | Canonical name |
|---|---|---|---|
| `Payment.reference` unique | 4 lanes | **Security** | `@@unique([organisationId, reference])` |
| `ScheduledJobRun` org key | 5 lanes | **Control plane** | `@@unique([organisationId, job, scope, runKey])` |
| `Store.id` → cuid | 2 lanes | **Connector** | + `isHolding` replaces `'unassigned'` |
| `DocSequence` org | 3 lanes | **CRM** | `@@id([organisationId, scope])` |
| `Lead.storeId` nullable | 3 lanes | **CRM** | + `assignedStoreId`, `routingStatus`, `routedAt`, `routedById`, `assignedBy` |
| `AuditLog.actorId` | 3 lanes | **Tenancy** | nullable **+ `actorKind` + `actorLabel`**, one migration |
| `Organisation.status` | 3 lanes | **Control plane** | `provisioning\|onboarding\|active\|past_due\|suspended\|exporting\|closed` |
| Per-org credential table | 4 names | **Integration** | `Integration` + `IntegrationCredential` |
| Platform operator table | 3 names | **Control plane** | `PlatformUser` + `ImpersonationGrant` |
| `Conversation`/`Message` | 3 lanes | **CRM** | `Conversation` + `Message`; identity = `ContactPoint` |
| `ProductInteraction` | 3 lanes | **CRM** | one `kind` vocabulary via `LookupValue` |
| Identity resolution | 2 lanes | **CRM** | `IdentityService`; attribution **depends**, never duplicates |

---

## APPENDIX B — CONTRADICTIONS RESOLVED

| # | Conflict | Resolution |
|---|---|---|
| **C1** | Railway volume: does the local-disk fallback survive a deploy? | **Unprovable from the repo** — `.env.example` even documents a `railway-volume` provider that matches no code branch. Verify in the dashboard; making production fail loud removes the dependency |
| **C2** | Silo = connection registry vs deployment concern | **Deployment concern.** Record `isolationMode`/`datasourceKey` now; build no registry until an enterprise tenant contracts |
| **C3** | Three incompatible `Conversation`/`Message` models | **One:** `Conversation` + `Message`, key `@@unique([integrationId, channel, externalThreadId])` (narrower than org-scoped, therefore safe under either answer to C1-provider), status `open\|pending\|snoozed\|resolved` + a separate `isBotHandled` flag; identity table `ContactPoint` |
| **C4** | `AuditLog.actorId` nullable vs NOT NULL | **Nullable + `actorKind` NOT NULL + `actorLabel`, in one migration.** Non-user actors genuinely exist (scheduled work writes no audit at all today). Operator trustworthiness is preserved by a **separate** `PlatformAuditLog` |
| **C5** | Three `Organisation.status` enums | **One:** `provisioning\|onboarding\|active\|past_due\|suspended\|exporting\|closed`; `isActive` derived for one release |
| **C6** | Four names for per-org credentials | **`Integration` + `IntegrationCredential`** |
| **C7** | Three attribution storage models | **`AttributionTouch`** = fact, **`AttributionResult`** = credit, `Lead` carries only `attributionStatus` + denormalised `campaignId?`. A touch emits both a touch row and an `ActivityEvent` |
| **C8** | Unresolvable webhook events: drop vs persist | **Persist** (post-verification) with NULL org + `status='unresolved'` + alert + retention. Dropping is silent data loss on a money path |
| **C9** | Two `$extends` designs on one hook | **One extension**, order: open tx → `set_config` → inject/assert. Injection does not make RLS redundant |
| **C10** | Three platform-plane mechanisms | **They are one workstream:** `runAsPlatform()` (ALS) + `PlatformPrismaService` (`caratos_platform` role) + `/platform` module |
| **C11** | `DocSequence` RLS exemption evaporates once it gains an org column | Correct — it **leaves class C** and gets a class-A policy |
| **C12** | `Lead.storeId` shipped three times | One owner (CRM), one column set, atomic with the queue |
| **C13** | `ProductInteraction` defined three times | One owner (CRM), `LookupValue` vocabulary |
| **S3** | RLS interleaved with the child backfill | **Backfill all 24 → verify → then policies** |
| **S7** | "Commit as Phase 0" silently means "deploy to production" | Snapshot gate + staging rehearsal **precede** the commit |
| **S8** | `seed-user-phones.mjs` removal scheduled a phase late | Remove in the **same commit** as the tenancy migrations |
| **S9** | "Add a test step to CI" | Really "add CI" — the file is git-ignored and untracked; it is a phase of its own that four plans depend on |
| **D4** | `purgeDemo` fix specified only for the delete | Change **both** the count-plan and the `deleteMany`, or the dry-run stops matching execution |
| **D5** | Removing the static route before the fallback | Fallback first, route second |

**Corrected repo facts** (design lanes had these wrong): **46** `@IsEnum` in **17** files (not 47/24) · **34** e2e specs (not 35) · **24** transitive children + `DocSequence` + `LoginOtp` = 26 without org (two lanes omitted `LoginOtp`; one duplicated `ReturnPhoto`) · **49** committed migrations of 57 on disk · **11** untracked specs · `.env.example` documents 30 uncommented names (34 including commented).

---

## APPENDIX C — PROVIDER ASSUMPTIONS TO VERIFY BEFORE THEY DRIVE A SCHEMA DECISION

Each of these was asserted somewhere in the design material as settled fact. **None is verifiable from this repository.** All are **FUTURE — requires provider documentation at implementation time.**

| # | Assumption | What it would decide | Risk if wrong |
|---|---|---|---|
| **C1** | Instagram/Messenger user ids are **page-scoped** (the same person has a different id per Page) | Whether `ContactPoint`/`Conversation`/`ContactIdentity` key on `integrationId` or `organisationId` | The design itself calls this "a data-integrity bug that is very hard to unwind". **Mitigated:** the resolved key is the narrower `integrationId`, which is correct under either answer |
| **C2** | A company-owned app subscribes webhooks **per app, not per tenant**, so payload-keyed routing is the only correct model | The entire webhook-routing architecture | A per-tenant callback URL would be simpler; the payload-keyed design still works either way |
| **C3** | Undelivered webhooks are retried for ~7 days, from a narrow IP range | Throttle-exemption and retention decisions | Only affects tuning, not structure |
| **C4** | Per-tenant app review / business verification is a commercial non-starter | The one-app decision | Would change the tenant onboarding flow materially |
| **C5** | Razorpay retries aggressively | Justification for payment idempotency | **The fix stands on repo evidence alone** — `Payment.reference` has no unique index and the code is check-then-insert. Keep the fix, drop the justification |
| **C6** | Prisma does not support nested interactive transactions | Drives the `orgTx` migration across ~20 sites | Verify against the installed version (`^6.2.1` is confirmed in `package.json`; the GA-version claim is not) |
| **C7** | Cloudflare R2 versioning semantics | Backup/immutability design | Affects the object-retention plan only |
| **C8** | Railway pooler mode (session vs transaction) | RLS carrier correctness | **Mitigated:** transaction-local `set_config` is correct under all three pooling modes |
| **C9** | Anthropic model id / structured-output parameter currency | Whether the dead vision-tagger call is stale | Irrelevant to the recommendation — that system is being retired regardless |

---

*End of report. No code, schema, migration or configuration was changed. No commit, push or deployment occurred.*
