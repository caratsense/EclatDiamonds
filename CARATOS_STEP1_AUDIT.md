# CaratOS Universalization — Step 1 Audit (READ-ONLY)

> **Status:** Audit only. Nothing in the repository was modified, committed, migrated, or deployed to produce this document. Every finding is a read-only observation with a file path and a *recommended direction only* — no solution is implemented.
>
> **Method:** Six parallel read-only audit lanes (schema, backend business logic, integration/sync, multi-tenant/RBAC security, frontend/product, AI catalogue) plus direct verification by the author of the keystone files (`schema.prisma`, `store-scope.service.ts`, `config-seed.ts`, the `integration/` layer, `docs/CARATOS_ARCHITECTURE.md`).
>
> **Verified checks run:** `git status` (176 files uncommitted — all CaratOS work is local/untracked), `backend/ npx tsc --noEmit` → **exit 0 (clean)**, branch `main` @ `9589ac5`. Extensive grep/search (recorded inline). No frontend build or test suite was executed in this pass; the last verified state from the prior session was backend build 0 / frontend build 0 / E2E 264 pass. An existing `backend/test/org-isolation.e2e-spec.ts` covers tenancy regression.

---

## ⚠️ Reconciling the code with `docs/CARATOS_ARCHITECTURE.md`

The repo already contains a `docs/CARATOS_ARCHITECTURE.md` describing a phased plan. **That document is partly stale and must not be read as current state.** Verified divergences (code is the source of truth):

| ARCHITECTURE.md claims | Actual verified state |
|---|---|
| "No `Organisation` node — the one structural gap" / Phase 7 tenancy "DEFERRED" | **DONE.** `Organisation` model exists; `organisationId` is **NOT NULL** on 47 business models (migration `20260822130000_caratos_org_not_null`); `StoreScopeService` is org-resolved + fail-closed; JWT guard re-reads org from DB. |
| Connector/import/canonical = "contracts only, not wired" | **Partly wired.** `IntegrationModule` **is** registered in `app.module.ts:94`; a **real, working CSV/XLSX import engine** ships (`integration/import/*` with controllers). The *connector runtime* is still contracts-only (0 implementations). |

So the true current state is: **the tenancy keystone has largely landed** (with real leak gaps, §L), while **the universal connector layer is a designed-but-mostly-unimplemented seam** (§G). This audit reports the verified code, not the doc.

---

## A. Current architecture

| Layer | Reality (verified) |
|---|---|
| **Backend** | NestJS + Prisma 6 + PostgreSQL. ~40 domain modules under `backend/src/` (auth, users, stores, parties, leads, quotes, products, stock, stock-transfers, sales, finance, payments, loyalty, discounts, returns, hrms, checkins, marketing, new-store, reporting, dashboard, special-requests, ticketing, targets, timelines, notifications, audit, assistant, search, scheduler, storage, onboarding, sync, integration, integrations, whatsapp-bot, health). |
| **Frontend** | Next.js (App Router) + React/TS + react-query. ~30 routes under `frontend/src/app/(app)/`. Role-aware nav from `lib/navigation.ts`; a `useT`/`DICT` i18n indirection exists (`lib/i18n.ts`). PWA manifest. Single SPA shell. |
| **Schema** | `backend/prisma/schema.prisma` — 78 models, ~44 enums, 2880 lines. Hierarchy `Organisation → Region? → Store → User/UserStore`. 47 models carry NOT-NULL `organisationId`; ~28 children inherit tenancy transitively via a required FK. |
| **Identity / isolation** | JWT → `JwtAuthGuard` re-reads `role`/`isActive`/`organisationId` from the DB each request (never trusts the token/body). `StoreScopeService` resolves an **org-bounded** store set; `head_office` sees its own org's stores only; empty org = empty scope (fail-closed). Isolation is **application-level only — no Postgres RLS**. |
| **RBAC** | Rank-monotonic `Role` enum `salesperson < store_manager < area_manager(collapsed) < head_office`; `RolesGuard` checks rank only, never org. No platform-super-admin tier above tenants. |
| **Provenance / sync** | Live path: on-site Python agent (`synceclatcaratsense/*.py`) reads APRS-SJEP SQL Server → per-entity `/sync/*` routes with hardcoded Gati mappings (`backend/src/sync/`). Canonical models carry a neutral `legacyId`/`legacyUpdatedAt`. `ImportBatch`, `LegacyRow`, `SyncState`, `DocSequence` provenance models exist. |
| **Integration abstraction** | `backend/src/integration/` — source-agnostic `contracts/*` (connector/canonical/provenance/import-profile/sync-result/embedding-provider), a static `connectors/` registry, and a working generic `import/` (CSV/XLSX) engine. Wired into `app.module.ts`. |
| **Outbound integrations** | `backend/src/integrations/` — WhatsApp, Razorpay, Email, gold-rate feed; each config/env-gated with a safe dry-run. Credentials are single process-global env sets (one identity for all tenants). |
| **AI catalogue** | `inference/` FastAPI microservice (DINOv2 + SigLIP 2, dual vectors, domain-neutral) + backend `products/jewelry-similarity` + `jewelry-ranking` + `ml-inference` writing `ProductEmbedding` (org-scoped). Honest degraded states. A **zombie** older single-embedding system (`ai-image-search.service.ts`) is still wired. |
| **Storage / infra** | Cloudflare R2 (signed). Backend on Railway (root_dir=backend, `prisma migrate deploy` preDeploy), frontend on Vercel (`/_api` proxy). |

**Overall shape:** a well-factored single-tenant jewellery app with a *substantially-completed* org-tenancy retrofit and an *early, partly-wired* universal-connector seam. Decoupling remaining = (1) close tenant-isolation leaks, (2) de-jewellery the data model + UI via config/extensions, (3) build the connector runtime.

---

## B. Core modules already reusable (industry-independent)

Verified industry-neutral — reuse as-is (minor copy/config tweaks only):

| Area | Files | Note |
|---|---|---|
| **Store-scoping core** | `common/store-scope.service.ts`, `common/auth-user.ts`, `auth/jwt-auth.guard.ts` | Org-bounded, fail-closed, no global fallback. The model for everything. **Preserve (§P).** |
| **CRM / Leads** | `leads/`, `parties/` | Generic contact + pipeline. No jewellery logic (grep-clean). |
| **HRMS** | `hrms/` | Attendance, shifts, leave, geo-fence — fully industry-neutral. |
| **Check-ins / footfall** | `checkins/` | Core flow generic; only purpose *labels* are jewellery (→ §E). |
| **Ticketing** | `ticketing/` | Generic issue tracking (has a tenancy leak, §L, but domain-neutral). |
| **Dashboards / Reporting / DSR skeleton** | `dashboard/`, `reporting/` | KPIs generic; DSR skeleton (walk-ins/bills/sales/payment modes) core, minus gold-grams/old-gold fields. |
| **Finance / Payments / Ledger** | `finance/`, `payments/` | Generic double-entry + payments (minus gold tender modes). |
| **Marketing / New-store / Targets / Approvals** | `marketing/`, `new-store/`, `targets/`, `special-requests/` (ladder), `discounts/` (cap+escalation engine) | Approval ladders, campaign container, launch-checklist, sales targets — all generic engines with jewellery *values* layered on. |
| **Audit** | `audit/`, `common/audit.service.ts` | Generic. |
| **Generic import engine** | `integration/import/*` | Entity-agnostic CSV/XLSX pipeline (discover→preview→run→reconcile). Strong reusable foundation (has gaps, §G). |
| **AI inference + ranking core** | `inference/*`, `products/jewelry-ranking.service.ts` | Vision models are domain-neutral; ranking treats category as a soft opaque string (§H). |
| **Frontend CORE routes** | dashboards, reporting, store-comparison, crm, customers, checkins, reminders, discounts, sales-performance, stock-transfers, payments, hrms, finance, new-store, marketing, approvals, requests, ticketing, settings/{stores,team,targets,audit} | Industry-neutral UI (minus specific copy). |

---

## C. Jewellery-specific code (INDUSTRY-SPECIFIC)

For each: current behaviour → why it blocks a non-jewellery org → severity → direction.

| ID | File:line | Current behaviour | Why it blocks | Sev | Direction |
|---|---|---|---|---|---|
| C-1 | `schema.prisma:85` `MetalKind` enum; `Product.metal` **non-null** `:1161` | Closed Postgres enum of gold karats/platinum/silver; **required** on every Product; used on StockItem/MetalRate/QuoteLine | A non-jewellery product has no valid value; adding one needs a migration | **CRITICAL** | Replace enum with per-org/industry lookup table or free string + industry vocab; make metal an optional attribute |
| C-2 | `schema.prisma:101` `ProductCategory` enum | necklace/ring/earrings/… default `other` | Textile/pharmacy taxonomy unrepresentable; caps `Product`, `StockItem`, search DTO, AI tagger | **CRITICAL** | Per-org product-type taxonomy (data, not enum) |
| C-3 | `quotes/quotes.service.ts:12,65` | `GST_RATE=0.03`; taxable = weight×goldRate + making + carat×perCaratRate; QuoteLine DTO mandates karat/weight/goldRate | No generic unit-price path; a non-jeweller can't create a quote; 3% is IN jewellery GST | **CRITICAL** | Pluggable pricing strategy; `unitPrice×qty` as core default; gold/making/stone as a jewellery plugin; tax to per-org config |
| C-4 | `discounts/discounts.service.ts:36,427`; `sales/sales.service.ts:71-146` | Discount primitive **is** a diamond%/making% split; "gold is never discounted" | The core discount + sale-record path assumes the jewellery split | **CRITICAL** | Component-based discount `{type,percent\|amount}[]`; keep the (generic) cap/escalation engine |
| C-5 | `sales/sales.service.ts:138-146` | A blended discount with **no** diamond/making split is **thrown** as a validation error | Absence of jewellery data treated as an error → can't record "10% off the bill" | **HIGH** | Allow plain overall discount as core; split optional |
| C-6 | `returns/returns.service.ts:25,152,483` | Exchange/buyback = gold-wt×rate + diamond-carat×rate; `GOLD_RATE_PER_GRAM={24:7180,22:6580,18:5390}` hardcoded fallback; defaults karat 22 | Entire feature is gold/diamond; hardcoded stale money-in-code | **CRITICAL** | "Returns valuation" strategy; core = credit-note on original value; gold calc behind jewellery plugin; remove rate literal |
| C-7 | `timelines/order-stages.ts` (whole); `OrderStatus` enum `schema.prisma:164` | booked→designing→casting→stone_setting→polishing→qc→ready; per-stage SLA; labels "Gold melting/casting" | Every custom order assumed manufactured through jewellery stages | **HIGH** | Per-org configurable state machine (stages/transitions/SLA as data); keep the transition/role engine |
| C-8 | `loyalty/loyalty.service.ts:31,81,389` | `DIAMOND_DISCOUNT_PCT=5`, `COMMISSION_PCT=5`; auto-seeds "10+1 Gold Savings Scheme" for **every** org; referral reward is a *diamond* discount | Every tenant silently gets gold-scheme plans; referral framing is jewellery | **HIGH** (auto-seed MEDIUM) | Generic "referee discount"; don't auto-seed — per-org template; % to config |
| C-9 | Whole models: `MetalRate`, `DiamondRate`, `SchemePlan/Member/Installment`, `ManufacturingOrder(Item)`, `ProductionBag`, `ReferralCode/Referral/ReferralPayout` | Metal/diamond rate feeds, gold savings scheme, jeweller shop-floor, referral program | Meaningless to pharmacy/textile; every tenant carries the tables | **HIGH** | Ship as per-industry plug-in modules enabled per org, not core tables |
| C-10 | `reporting/reporting.service.ts:276,700,824` | DSR carries `oldGoldWtG/Value`, `goldGrams` per store as first-class | Meaningless KPI for other industries | **MEDIUM** | Old-gold/gold-grams become optional jewellery report fields |
| C-11 | `special-requests/request-routing.ts:19`; `special-requests.service.ts:330` | `diamond_rate` kind writes a `DiamondRate` row on approval | Jewellery workflow baked into the generic approval ladder | **MEDIUM** | Make `diamond_rate` one registered request-kind plugin |
| C-12 | `stock/stock.service.ts:35,96,355`; `products/products.service.ts:48` | `GOLD_METALS`, `CATEGORY_LABEL` duplicated; HUID uniqueness dedupe; exposes gross/net weight, hallmark, certificate | Jewellery/India-specific assay + BIS-HUID; duplicated constants (drift) | **MEDIUM** | Weight/hallmark as optional attributes; configurable category labels; generic serial fallback for HUID dedupe |
| C-13 | `products/ai-image-search.service.ts:200` | Claude-vision tagger prompt hardcoded "jewellery cataloguing assistant for an Indian jewellery retailer"; schema enums = ProductCategory/MetalKind | Single most domain-locked AI piece (and it's the zombie system, §H) | **MEDIUM** | Retire with the zombie system, or per-industry tagger prompt |

---

## D. Integration-specific code (Gati/SJEP-specific)

| ID | File:line | Current behaviour | Why it blocks | Sev | Direction |
|---|---|---|---|---|---|
| D-1 | `sync/sync.util.ts:54,69,102,146,188` | `karatFromRow` parses `-14KT-` from Gati SKU tail; `metalFromRow` off `ToneCode`; `INWARD_STATUS`, `docTypeFromTranType`, `maxWatermark` hardcode Gati column/code conventions | Mapping is code-resident, Gati-only; changing source = new TypeScript | **HIGH** | Wrap `sync/` as a `GatiConnector` behind `IntegrationConnector`; keep core off Gati structures |
| D-2 | `sync/sync.service.ts:75,93,1506,1559,1644,1747,2230` | Every `syncX` hardcodes legacy PK/field names (`PartyNo/StyleId/JewelId/TranType/…`) + Gati design-code category rules | Same — one-source-shaped | **HIGH** | Same as D-1 |
| D-3 | `synceclatcaratsense/sync_sjep.py` | Hardcoded APRS-SJEP table identities (`PartyMst/StyleMst/Inward/JewelTrans/…`); schema-defensive at column level; measured branch predicate | The on-site agent is APRS-shaped; no generic-SQL variant | **HIGH** | Generalize to config-driven extraction, or add generic-SQL/REST agents |
| D-4 | `products/products.service.ts:288` | `tagNo: r.legacyId ?? r.sku` — treats `legacyId` **as** the physical Gati tag number | Real runtime coupling: a non-Gati `legacyId` surfaces a meaningless "tag" | **MEDIUM** | Separate business "tag/serial" field from provenance `legacyId` |
| D-5 | `search/search.service.ts:74` | Comment-encoded assumption "Party synced from legacy PartyMst with storeId always set" — a query relies on it | Assumes Gati-shaped data guarantees | **LOW** | Make the query robust to null storeId |
| D-6 | `SyncState` model (`schema.prisma:2671`) | **Dead code** — no reader/writer in `backend/src`; watermarks actually live in the agent's local `sync_state.json`; unique mis-scoped `[sourceTable, storeId]` (no org) | Server has no source watermark; model misleads | **MEDIUM** | Move watermarks server-side into `SyncState` with an org-inclusive unique, or delete the dead model |

Positive: the canonical Prisma models use neutral `legacyId`/`legacyUpdatedAt`, not `JewelId`/`gatiId`. Gati leakage outside `sync/` is small (mostly comments). The raw full-mirror (`/sync/raw` → `LegacyRow`) ingests any table verbatim — a strong source-agnostic foundation.

---

## E. Configuration candidates (should become org/industry-configurable)

| ID | File:line | Currently hardcoded | Direction | Sev |
|---|---|---|---|---|
| E-1 | `schema.prisma` enums | `MetalKind`, `ProductCategory`, `OrderStatus` stages, `PaymentMode` (gold_exchange/old_gold), `CheckinPurpose`, `CampaignType.bridal`, `ReturnType.old_gold`, `SchemeStatus` | Per-org/industry **lookup tables** seeded from an industry template (data, not enum migrations) | HIGH |
| E-2 | `users/users.util.ts:5` | `HANDLE_DOMAIN='eclatdiamonds.in'` on every generated login | Per-org handle domain (config), platform fallback | HIGH |
| E-3 | `common/tz.util.ts:19`; formatting in `quotes`/`reporting`/`discounts` | `DEFAULT_TZ='Asia/Kolkata'`; INR/₹, `en-IN`; **mandatory** `IsIndianMobile` on quote/return create | Per-org currency/locale/TZ; pluggable, non-mandatory phone validation | HIGH |
| E-4 | `common/config-seed.ts:16-99` | Hardcoded `org_eclat`, `store.findFirst()`, IN holidays, demo referral | Per-org, template-driven onboarding; never `findFirst` a store | CRITICAL (also §F/§I) |
| E-5 | brand strings: `quotes:120`, `reporting:497`, `integrations/razorpay:94`, `scheduler:31` | "CaratSense" / "Eclat" in customer-facing text | Per-org brand name for WhatsApp/report/payment copy | LOW |
| E-6 | `checkins/checkins.service.ts:8`; `discounts` presets `:114`; loyalty %; SLA budgets | Jewellery purpose labels, D10/D15 presets, 5% referral, per-stage SLAs | Per-org config values | LOW–MEDIUM |
| E-7 | `role.util.ts:4` `ROLE_RANK`; `Role` enum | 4-tier hierarchy with a **dead `area_manager`** everyone codes around | Either remove `area_manager` cleanly, or model roles/ranks as data for configurable hierarchy depth | MEDIUM |

---

## F. Multi-tenant risks (data-model + provisioning)

*(Isolation-leak specifics are §L; these are structural/provisioning risks.)*

| ID | File:line | Risk | Sev | Direction |
|---|---|---|---|---|
| F-1 | `schema.prisma` — `legacyId String? @unique` on Party/Product/StockItem/Sale/… (16 models); `LegacyRow @@unique([sourceTable,rowKey])`; `ref @unique`; `Store.code`/`Region.code`/`User.email` | **Global** uniques (not org-scoped). Two tenants syncing their own ERP collide on `legacyId`; two tenants can't both have store code "MAIN" | **CRITICAL** (legacyId) / MEDIUM (code/ref) | Composite `@@unique([organisationId, …])`; move provenance to a side `SourceLink` table |
| F-2 | No Postgres RLS anywhere (grep: 0 `CREATE POLICY`/`ROW LEVEL SECURITY`) | Isolation depends on every one of hundreds of queries remembering an org predicate; this audit found 8+ misses (§L) | **HIGH** | RLS on the 47 anchored tables keyed on a per-tx `app.current_org` GUC set by Prisma middleware; keep app filters as fast path |
| F-3 | `Organisation` model `:361` | **No `industry`/`vertical`/`type` discriminator** — nothing to branch industry config/enums/pricing on | **HIGH** | Add `industryId`/`vertical` + per-industry template reference |
| F-4 | No custom-field/EAV/attributes mechanism (grep: 0 `customField\|attributes\|extraData`) | Jewellery attributes are hardwired columns on shared tables; a new industry can't add its own | **HIGH** | JSONB `attributes` on Product/StockItem/Party/*Line* governed by a per-industry field-definition catalogue |
| F-5 | `config-seed.ts` (§E-4/§I) | Never bootstraps a 2nd org; a fresh tenant starts with no discount caps (all escalate) / no rates | HIGH (provisioning) | Per-org onboarding seed from industry template |
| F-6 | `UserStore` (no org column) | Only place a User + Store from different orgs could be joined; nothing at DB level forbids it (reads degrade to invisible via `resolveScope`) | MEDIUM | Same-org check/constraint on assignment |
| F-7 | `integrations/*` credentials (WhatsApp/SMTP/Razorpay) | Single process-global env identity for all tenants | MEDIUM | Per-tenant credential store |

---

## G. Universal import / connector gaps

| ID | File:line | Current | Why it blocks | Sev | Direction |
|---|---|---|---|---|---|
| G-1 | `integration/connectors/connector-registry.ts` + `contracts/connector.ts` | `IntegrationConnector` interface is complete; **zero classes implement it**; registry returns static metadata; Gati sync is **not** wrapped | No live connector (SQL/REST) can be added without building the whole extract→transform→persist runtime; no reference impl | **HIGH** | Build a connector runtime + `GatiConnector` reference; then generic SQL/REST connectors |
| G-2 | `integration/import/entity-importers.ts:228`; `field-dictionary.ts:14` | Only **3** importers: customers, stores, products. No sales/stock/payments/orders/staff (though contracts advertise them) | Can't bulk-onboard most of a business by CSV | **HIGH** | Add importers per canonical entity; per-vertical entity packs |
| G-3 | `entity-importers.ts:142,203` | `products` importer forces `MetalKind`+`karat`; **silently drops** `category` on persist (mapped then omitted L210-216) | Textile/pharmacy catalogue squeezed through metal/karat, loses real attributes; category lost | **HIGH** | De-jewellery the products importer (config-driven attributes); fix dropped category |
| G-4 | `entity-importers.ts:206-224`; `field-dictionary.ts:51-59` | Generic products importer has **no `imageUrl` field**; sets `embedding:[]` | A CSV-onboarded org gets an **imageless** catalogue → visual search has nothing to index | **HIGH** | Add image-URL/ZIP column + generic bulk image attach |
| G-5 | `import` persist paths (`customers.persist:62`, `products.persist:221`) | CSV rows get **no `legacyId`/source provenance** — only `ImportBatch` logs the run. And `purgeDemo` deletes `legacyId IS NULL` (`sync.service.ts:842`) | **The go-live demo purge would delete every CSV-imported row** as "demo"; re-import idempotency relies on fuzzy matching | **HIGH** | Write `SourceRef`/`legacyId` + batch linkage on import rows; purge by explicit demo flag, not null-legacyId |
| G-6 | `contracts/import-profile.ts` | `ImportProfile` (saved reusable mappings) is a **contract only** — no Prisma model; each step re-uploads the file, no server state | "Map once, reuse" doesn't exist | MEDIUM | Persist `ImportProfile` + apply-engine |
| G-7 | reconciliation contracts (`contracts/sync-result.ts`) | `DiscoveryReport`/`ReconciliationReport`/`SyncCounts` are **contracts only** — nothing emits them; reconciliation = agent-side advisory checks | No source-vs-canonical diff / held-record queue for arbitrary sources | MEDIUM | Wire reconciliation reporting to runtime |

---

## H. AI catalogue gaps

The AI pipeline is **structurally generic** — this is largely good news.

| ID | File:line | Current | Sev | Direction |
|---|---|---|---|---|
| H-1 | `products/jewelry-ranking.service.ts:154,159` | Category is a **soft agreement boost, never a hard filter**; `RankCandidate.category` typed `string\|null` (opaque). Ranking runs on any-domain embeddings unchanged | LOW (logic) | Keep; only rename |
| H-2 | `jewelry-ranking.service.ts:90-109,210-228` | `calibrateCloseness` anchor curve + thresholds (veryClose 85/close 70/…) explicitly "PROVISIONAL, not validated"; tuned on jewellery-on-white cosine distribution; **global** (one curve for all orgs) | **MEDIUM** | Per-org/industry calibration profile once `SimilaritySearchFeedback` accrues (table already versions ranking+model) |
| H-3 | `schema.prisma:101` `ProductCategory` (shared w/ §C-2); AI category param `jewelry-similarity.dto.ts:33` | Category-agreement boost goes inert for non-jewellery (falls to `other`) | HIGH | Per-industry category taxonomy |
| H-4 | `inference/preprocessing.py:64`; `inference/README.md:56` | White letterbox pad, "no segmentation" — tuned to jewellery-on-white; busy backgrounds (pharmacy shelf/textile-on-model) degrade | MEDIUM | Per-industry preprocessing (segmentation on/off, pad colour) |
| H-5 | `inference/Dockerfile:27`; `main.py:27` | Single global model set (dinov2-base + siglip2-base) for all orgs; no org→model routing | MEDIUM | Optional per-industry model/fine-tune profile |
| H-6 | `products/ai-image-search.service.ts` (whole) + `image-embedding.service.ts` + `Product.embedding` + `POST /products/image-search` | **Zombie system**: `aiSearch.reindex` unreachable; `Product.embedding` never populated by any reachable path; jewellery Claude-vision tagger (§C-13). Two pure helpers (`cosineSimilarity`, `parseEmbedding`) straddle both systems | **MEDIUM** (tech debt) | Retire zombie + endpoint + column; relocate the 2 shared helpers to a neutral util |
| H-7 | endpoint `/products/jewelry/similarity-*`; `RANKING_VERSION='jewelry-rank-v1'` | Vertical leaks into public API + stored feedback rows | LOW | Rename to neutral path (client-contract change) |
| H-8 | `jewelry-similarity.service.ts:14,133` | `CANDIDATE_CAP=5000` bare `take`, no ordering → silently truncates a large catalogue; in-app O(n) cosine | LOW (recall ceiling, not leak) | pgvector upgrade (already the planned seam) |

**Multi-tenant safety of AI: correct.** `ProductEmbedding`/`SimilaritySearchFeedback` carry `organisationId`; `scopeWhere` always injects `organisationId`; reindex/feedback stamp org. Org A cannot retrieve Org B's embeddings. **Preserve (§P).**

---

## I. Onboarding gaps

| ID | File:line | Gap | Sev | Direction |
|---|---|---|---|---|
| I-1 | `common/config-seed.ts:16-99` (runs on every startup via `main.ts`) | Hardcoded `org_eclat`; `store.findFirst()`; guards on a **global** `diamondRate.count()`, so **no second org is ever bootstrapped**; seeds IN holidays + demo referral to an arbitrary store | **CRITICAL** | Replace with per-org, industry-template onboarding at org-create; never `findFirst`; never run for a live org |
| I-2 | `onboarding/` module exists (`onboarding.controller/service.ts`) | Verified present but its scope is the **user welcome-tour**, not org/industry provisioning | HIGH | Extend/replace with a tenant-provisioning + industry-pack wizard |
| I-3 | No industry template concept anywhere | Nothing seeds enums/taxonomy/pricing/modules per industry | HIGH | Industry-pack definitions (category taxonomy, attribute schema, order stages, tender modes, enabled modules, label pack) applied at onboarding |
| I-4 | `stores/stores.controller.ts:18` `GET /stores/directory` `@Public()` | Signup directory enumerates **all tenants'** branches | MEDIUM (§L-M2) | Resolve target org from signup context (subdomain/slug); scope the directory |
| I-5 | fresh-tenant runtime | No discount caps (all escalate to HO), no rates until first use, no branding | MEDIUM | Seed sane per-industry defaults at onboarding |

---

## J. Database / model concerns

Verified against `schema.prisma` + the 6 CaratOS tenancy migrations.

- **Org coverage (good):** 47 business models carry NOT-NULL `organisationId` (`20260822130000_caratos_org_not_null`), FK `ON DELETE RESTRICT`. 28 children inherit via required parent FK. Nullable-org by design: `ScheduledJobRun`, `WhatsAppEvent`, `WhatsAppSession` (documented, low risk). **This is a real strength — preserve.**
- **J-1 (CRITICAL):** global `legacyId @unique` (see §F-1) — the single most dangerous multi-source defect. `20260820130000_caratos_org_scoped_uniques` deliberately org-scoped `sku`/`code` but **left `legacyId` global** ("move with the connector phase").
- **J-2 (CRITICAL):** industry-locked **required** columns/enums (`Product.metal MetalKind` non-null, `ProductCategory`) — a non-jewellery catalogue is unrepresentable (§C-1/§C-2).
- **J-3 (HIGH):** no RLS (§F-2); no `industry` discriminator (§F-3); no custom-field mechanism (§F-4).
- **J-4 (HIGH):** ~17 CORE tables carry jewellery columns that should split into CORE + per-org extension: Product/StockItem assay block (metal/karat/all weights/diamond+stone counts/hallmark/HUID/certificate), QuoteLine/SaleLine/ReturnRecord economics (weight×rate/making/stone/exchange-buyback), Discount diamond/making split.
- **J-5 (MEDIUM):** `DocSequence` PK embeds `storeId` (no org column) — safe today because every scope contains a store; any future global-scoped doctype would share one counter across tenants.
- **J-6 (MEDIUM):** single scalar `legacyId`/`legacyUpdatedAt` can't represent N source systems ("connect to ANY software" implies multi-source) — needs a polymorphic `SourceLink(entityType, entityId, sourceSystem, externalId, …)`.
- **J-7 (LOW):** locale defaults on canonical models (`Party.pan/aadhaar/gstin`, `Store.timezone` default `Asia/Kolkata`, INR decimals) — India-single-market.
- **Provenance machinery is clean:** `ImportBatch` (run-level), `LegacyRow` (`{sourceTable,rowKey,data Json}` landing zone), `DocSequence` — good separation; the bleed is provenance *columns on canonical tables* + their global uniqueness.

**Model classification (summary):** ~48 CORE, ~10 pure JEWEL (`MetalRate`, `DiamondRate`, `SchemePlan/Member/Installment`, `ManufacturingOrder(Item)`, `ProductionBag`, `ReferralCode/Referral/ReferralPayout`), 3 INTEG (`ImportBatch`, `LegacyRow`, `SyncState`), ~17 CORE-with-jewellery-fields that should split into CORE + extension.

---

## K. Frontend / product concerns

| ID | File | Current | Sev | Direction |
|---|---|---|---|---|
| K-1 | `lib/navigation.ts` + `components/layout/sidebar.tsx` | `NAV_GROUPS` static, filtered by **role only** (never org/industry); labels/purposes say "Gold Rate", "Gem", "old-gold trade-ins", "Gold-savings schemes"; `purpose` strings bypass i18n entirely | **CRITICAL** | Nav from a per-org module manifest (enabled modules + label pack); route all labels/purposes through `useT`/`DICT` |
| K-2 | `lib/mock/catalogue.ts`, `lib/mock/timelines.ts`, `checkins/page.tsx`, `payments/page.tsx`, `lib/queries/special-requests.ts` | Hardcoded option sets compiled into the client: category/metal, order stages (Gold melting→…), checkin purposes (Bridal/Gold Coin/…), payment modes ("Old Gold"), request kind default `diamond_rate` | **CRITICAL** (taxonomy/stages) / HIGH | Serve option sets from per-org/industry config; stop compiling `lib/mock/*` constants |
| K-3 | inventory/catalogue/quotation/returns/rates pages + dialogs | User-facing labels "Purity", "Karat", "HUID (BIS Hallmark Unique ID)", "Gross/Net weight", "Making charge", "Diamond rate", "₹/gram" | **HIGH** | Per-industry label pack; numeric fields become config-driven attribute definitions |
| K-4 | `components/brand/logo.tsx`, `app/manifest.ts`, `app/page.tsx`, `app/login/page.tsx`, `app/globals.css` | All branding hardcoded Éclat/CaratSense: logo, PWA name, an entire jewellery **marketing landing page** with hardcoded store names "Surat Main · Bandra · CG Road", gold/emerald theme | **CRITICAL** (landing/logo/manifest) / LOW (theme tokens) | Tenant/theme context (logo/name/color/industry) hydrated from API; separate the Éclat storefront from the product shell |
| K-5 | `lib/format.ts` `formatPurity(karat)→"${karat}K"`; `crm/page.tsx` WhatsApp fallback "…jewellery"; welcome-tour "pieces/workshop" | Shared helpers + copy assume jewellery | MEDIUM | Config-driven formatting/copy |
| K-6 | `lib/mock/stores.ts` `MOCK_STORES` (Surat/Bandra/CG Road) | First-paint seed only; real list from `/auth/me` via `hydrate()`; `StoreSwitcher` API-driven | **LOW** | Neutral placeholder; will briefly flash "Surat — Main" pre-hydration |

**Whole-module frontend jewellery routes needing config before non-jewellery use:** catalogue (CRITICAL), inventory (CRITICAL), find-similar (HIGH), quotation (HIGH), settings/rates (HIGH), returns (HIGH), loyalty (HIGH), timelines (HIGH). **Seam that already exists:** `useT`/`DICT` indirection + role-aware nav filtering + API-driven session hydration.

---

## L. Security / RBAC concerns (tenant-isolation leaks)

**Root cause:** `head_office` is treated as a **global super-role**, not a tenant-bounded one, and `RolesGuard` checks rank only (never org). `StoreScopeService` is sound; the leaks are **callers bypassing it** via three anti-patterns: (a) `allStores → {}` unfiltered, (b) bare `{ storeId: null }` OR-branch with no org predicate, (c) `findUnique({where:{id}})` write gated only by role rank. There is **no platform super-admin tier** above tenants.

| ID | File:line | Leak | Sev |
|---|---|---|---|
| **L-C1** | `schema.prisma` global `legacyId`/`rowKey` + `sync.service.ts` upserts (1543,1583,1699,…) key on `legacyId` with no org; `update` branch doesn't re-set org | Two tenants' overlapping Gati ids → **silent cross-tenant overwrite of customer PII** (name/phone/GSTIN/PAN/Aadhaar); tenant B's row lost | **CRITICAL** |
| **L-C2** | `users/users.service.ts` `list:138` (`where:{}` for allStores), `listUnassigned:162`, `listPending:477`, `getOrThrow:620`, `assertCanManage:85` | HO `list()` returns **every tenant's** users (handles/phones/roles); pending-signup PII across tenants; a manager/HO can role/activate a store-less user in another org | **CRITICAL** |
| L-H1 | `stock-transfers/stock-transfers.service.ts` `list:495`, `detail:525`, `approve:219`, `reject:278`, `load:76` | HO reads/approves/rejects **another org's** transfers → reserves inventory cross-tenant | HIGH |
| L-H2 | `stores/stores.service.ts` `update:294`, `close:219`, `addManager:356` (role-only guard) | Any HO edits another tenant's store (name/address/GSTIN), closes it, or provisions a manager login into it | HIGH |
| L-H3 | `marketing/marketing.service.ts` `campaignFilter:31` (`{}` for allStores), `updateAssetStatus:135`, `updateAgencyTaskStatus:188` | HO sees/modifies another tenant's campaigns/assets/tasks | HIGH |
| L-H4 | `new-store/new-store.service.ts` `projects:64`, `assertProjectInScope:338` (HO bypass) | HO reads/mutates another org's launch projects/checklists/milestones/vendors | HIGH |
| L-H5 | `loyalty/loyalty.service.ts` `scopedWhere:296` (`{storeId:null}` no org), `payout:499` | Company-wide referral codes/PII visible across tenants; HO pays out another org's code | HIGH |
| L-H6 | `ticketing/ticketing.service.ts` `scopedWhere:62` (`{storeId:null}` no org) | Every HO-level ticket + thread readable/mutable by all tenants | HIGH |
| L-M1 | `stores/stores.service.ts` `listRegions:392` | `GET /regions` returns every tenant's regions | MEDIUM |
| L-M2 | `stores/stores.service.ts` `directory:116` `@Public()` | Unauth `GET /stores/directory` enumerates all tenants' branches | MEDIUM |
| L-M3 | `dashboard/dashboard.service.ts` `productScope:72`, `updateTaskStatus:306` | Null-store Designs KPI counts other tenants' products; cross-org global-task write | MEDIUM |
| L-M4 | `products/products.service.ts` `setImage:340` | Null-store product from another org can have its image overwritten (list/get/create are correctly scoped) | MEDIUM |
| L-M5 | `discounts/discounts.service.ts` `create:162` | Foreign `productId` snapshots that product's cost/margin (cap engine itself is correctly scoped) | MEDIUM |
| L-L1 | `audit/audit-read.service.ts` `list:71` | Store-filter drops null-store rows → HO **can't** review role-change/user events (fail-closed, no leak, but oversight gap) | LOW |
| L-L2 | `common/config-seed.ts` | Single-tenant seed (see §I-1) | LOW |
| L-L3 | HUID/`code`/SKU conflict checks | `ConflictException` across orgs leaks existence of another tenant's identifiers | LOW |
| L-L4 | `auth/auth.service.ts` `findUserByPhone:329` | OTP phone match is global (last-10-digits) → if two tenants share a phone, OTP could hit the wrong org's account | LOW |

**Verified strengths (§P):** JWT/org derivation is solid (DB-read, fail-closed, never body/token); `StoreScopeService` is correct; money/PII hot paths that route through it (sales, payments, finance, parties, leads, checkins, returns, quotes, stock, discount-cap engine, HRMS, search) are org-safe; no dangerous cross-tenant `stores[0]`/`findFirst` in hot paths.

---

## M. What MUST NOT be changed (preserve invariants)

1. **`StoreScopeService`** and its guarantees (org-bounded scope, fail-closed empty scope, IDOR rejection). Layer org on top; don't loosen it.
2. **JWT org derivation** — always from the DB user, never token/body; missing org fails closed.
3. **Rank-monotonic RBAC semantics** every controller relies on — extend with explicit org checks, don't rewrite ranks.
4. **Stock-transfer source-of-truth protection** (`stock.storeId` CARATOS-owned post-transfer, `sync.service.ts:1610`) — becomes the first `SourceOwnershipPolicy` entry.
5. **Honest AI degradation** (`NO_CLOSE_MATCH` / `SEARCH_ERROR` / NOT_INDEXED) — never fabricate scores.
6. **Org-scoped AI embeddings/search** (correct today).
7. **Working Gati extraction in `sync/`** — wrap as `GatiConnector`, do not rewrite.
8. **The "never default store attribution" discipline** already enforced in `sync.service.ts:172`, `dashboard.service.ts:459`, and the connector `README` — no hardcoded store fallback may be introduced anywhere.
9. **Neutral provenance naming** (`legacyId` not `gatiId`) on canonical models.
10. **Existing routes/DTOs** — evolve behind compatibility adapters; Eclat stays organisation #1 with identical behaviour.

---

## N. Recommended order of future implementation (direction only — no code)

Each step is independently shippable, additive, and reversible. **Nothing below is authorized by this audit — each is a separate approval.**

1. **Close the tenant-isolation leaks (§L).** Highest priority — these are live-data-safety bugs even for the *current* single client the moment a 2nd org exists. Fix L-C1, L-C2, L-H1..H6 first (add `organisationId`/`assertOrgAllowed` on the flagged paths; delete `allStores→{}` and bare `{storeId:null}` shortcuts). Regression via existing `org-isolation.e2e-spec.ts`.
2. **Org-scope the global uniques + sync (§F-1, §J-1, §D):** composite `@@unique([organisationId, legacyId])` etc.; org-filter the four destructive sync ops; org-scope sync upserts. Unblocks a safe 2nd tenant.
3. **Postgres RLS (§F-2)** as defence-in-depth so a missed filter can't leak.
4. **Fix the core sales/discount path (§C-5, §C-4):** allow a plain overall discount; stop rejecting non-split sales. Smallest change that unblocks *any* industry on the core transaction path.
5. **Per-org onboarding + industry discriminator (§I, §F-3):** replace `config-seed` with template-driven provisioning; add `Organisation.industry`.
6. **De-enum the taxonomy (§E-1, §C-2, §H-3)** → per-industry lookup tables; **custom-attribute mechanism (§F-4, §J-4)** → JSONB attributes + field-definition catalogue; jewellery becomes the first industry pack.
7. **Pluggable pricing + configurable order stages (§C-3, §C-7).**
8. **Generic import hardening (§G-3..G-7):** de-jewellery + image + provenance + more importers + persisted profiles + reconciliation reports.
9. **Connector runtime + `GatiConnector` (§G-1)**, then generic SQL/REST connectors.
10. **Frontend tenant/industry config layer (§K):** module manifest + label pack + branding context; stop compiling `lib/mock/*`.
11. **Retire the zombie AI system (§H-6); per-org AI calibration (§H-2).**
12. **Isolate jewellery plug-in modules (§C-9); externalise locale/currency/brand (§E-2,3,5); platform super-admin tier (§L root).**

---

## O. Exact files that would need modification in later steps

*(Reference map — not a change list. Grouped by workstream.)*

- **Isolation leaks (§L):** `users/users.service.ts`, `stock-transfers/stock-transfers.service.ts`, `stores/stores.service.ts` + `regions.controller.ts`, `marketing/marketing.service.ts`, `new-store/new-store.service.ts`, `loyalty/loyalty.service.ts`, `ticketing/ticketing.service.ts`, `dashboard/dashboard.service.ts`, `products/products.service.ts` (`setImage`), `discounts/discounts.service.ts` (`create`), `audit/audit-read.service.ts`, `auth/auth.service.ts` (`findUserByPhone`), `auth/roles.guard.ts`.
- **Schema / tenancy (§F,§J):** `prisma/schema.prisma` (global uniques, `Organisation.industry`, attributes columns, `SourceLink`), new migrations, `common/store-scope.service.ts` (org helpers already present).
- **Sync / connectors (§D,§G):** `sync/sync.service.ts`, `sync/sync.util.ts` (→ `GatiConnector`), `synceclatcaratsense/sync_sjep.py`, `integration/connectors/*`, `integration/import/entity-importers.ts`, `field-dictionary.ts`, new `ImportProfile` model + service.
- **Business de-jewellery (§C,§E):** `quotes/quotes.service.ts`, `discounts/discounts.service.ts`, `sales/sales.service.ts`, `returns/returns.service.ts`, `timelines/order-stages.ts`, `loyalty/loyalty.service.ts`, `special-requests/request-routing.ts`, `reporting/reporting.service.ts`, `stock/stock.service.ts`, `checkins/checkins.service.ts`, `common/config-seed.ts`, `common/tz.util.ts`, `users/users.util.ts`, `common/role.util.ts`.
- **AI (§H):** retire `products/ai-image-search.service.ts` + `image-embedding.service.ts` + `Product.embedding` + `/products/image-search`; `jewelry-ranking.service.ts` (calibration profiles), `jewelry-similarity.service.ts` (rename), `inference/preprocessing.py` + `main.py` + `Dockerfile`.
- **Frontend (§K):** `lib/navigation.ts`, `lib/i18n.ts`, `lib/mock/{catalogue,timelines,stores,returns}.ts`, `lib/format.ts`, `components/brand/logo.tsx`, `components/layout/sidebar.tsx`, `app/manifest.ts`, `app/page.tsx`, `app/login/page.tsx`, `app/globals.css`, `store/use-session.ts`, and the jewellery route pages (catalogue, inventory, quotation, returns, settings/rates, loyalty, timelines).
- **Onboarding (§I):** `onboarding/*`, new industry-pack definitions.

---

## P. Things already correctly designed — preserve

1. **`StoreScopeService`** — org-bounded, fail-closed, IDOR-rejecting. The correct multi-tenant core.
2. **JWT/org guard** (`auth/jwt-auth.guard.ts`) — DB-read org, ignores token role, fail-closed.
3. **Org-scoped AI** — `ProductEmbedding`/`SimilaritySearchFeedback` carry org; search always injects it. No cross-tenant leak.
4. **Neutral provenance** — `legacyId`/`legacyUpdatedAt` (not `gatiId`); Gati quarantined in `sync/`.
5. **`LegacyRow` raw full-mirror** — ingests any source table verbatim; a real source-agnostic foundation.
6. **The integration contracts** (`integration/contracts/*`) — a coherent, well-thought source-agnostic seam (canonical/provenance/connector/import-profile/reconciliation/embedding-provider); the right target, just needs implementation.
7. **The generic CSV/XLSX import engine** — entity-agnostic pipeline (discover→preview→run→reconcile), never fabricates data (missing metal → `unspecified`, never guessed).
8. **"Never default store attribution"** discipline — enforced in sync, dashboard hand-off, and the connector README.
9. **Honest AI degradation** and the pgvector upgrade seam (embeddings in a side table).
10. **Rank-monotonic RBAC** + explicit sensitive-op exclusions (sound base to extend with org checks).
11. **The org-tenancy retrofit itself** — 47 models NOT-NULL org, `ON DELETE RESTRICT`, org-scoped uniques where global would collide, backfill migration — substantially done and honest.

---

## Explicit answer: "Can the current system onboard a completely unknown business today? If not, exactly why?"

**No — not a genuinely unknown business, and not cleanly even a known non-jewellery one.** What works vs what blocks, verified:

**Partially possible (a known business, mostly by CSV):**
- Customers and Stores import cleanly (domain-neutral CSV importers).
- CRM, HRMS, check-ins, ticketing, finance, dashboards, marketing, discounts (cap engine), payments all function industry-neutrally once data exists.

**Hard blockers (why "unknown business" fails today):**
1. **The product/catalogue model is jewellery-required at the DB level** — `Product.metal MetalKind` is a **non-null closed enum**; `ProductCategory` is a closed enum. A non-jewellery catalogue is *unrepresentable* without a schema migration. (§C-1, §C-2, §J-2)
2. **The core sales path rejects a plain discount** — a "10% off the whole bill" sale throws because it demands a diamond/making breakdown. (§C-5)
3. **Pricing, returns, loyalty, order timeline are hardwired jewellery logic** (gold-rate×weight+making+carat; old-gold buyback; gold-savings scheme; casting/polishing stages). (§C-3,6,7,8)
4. **No connector for an unknown source** — the only live source reader is the APRS-SJEP-specific Python agent; the `IntegrationConnector` interface has **zero implementations**. A pharmacy on generic SQL/REST cannot be ingested at all. (§G-1)
5. **The generic importer is jewellery-shaped and provenance-blind** — it forces metal/karat, drops category, has no image field, and writes no `legacyId`, so **the go-live demo purge would delete every imported row**. (§G-3,4,5)
6. **No industry/tenant abstraction to onboard *into*** — no `Organisation.industry` discriminator, no industry template, no per-org enums/attributes, no per-org branding; `config-seed` only ever bootstraps the single hardcoded `org_eclat`. (§F-3, §I-1, §F-4)
7. **The entire frontend is single-tenant jewellery** — hardcoded nav copy, option sets, branding, and a jewellery marketing landing page. A textile/pharmacy user sees "Gold Rate / HUID / Old Gold / Gem" everywhere. (§K)
8. **Tenant isolation is not yet safe for a real second org** — global `legacyId` sync collisions overwrite PII across tenants, and `head_office` leaks/mutates data across tenants on 8+ paths. Even a *second jewellery* tenant is unsafe today. (§L)

**In one line:** the platform is an unusually well-factored single-tenant jewellery app with a substantially-built org-tenancy retrofit and a designed-but-unbuilt universal-connector seam — so onboarding an unknown business needs (a) the isolation leaks closed, (b) the data model + UI de-jewellered via config/extensions, and (c) the connector runtime built. None of that is done today; all of it is anticipated by the existing `integration/contracts` and `CARATOS_ARCHITECTURE.md` groundwork.

---

*End of Step 1 audit. No files were modified, committed, migrated, or deployed. Awaiting direction on Step 2.*
