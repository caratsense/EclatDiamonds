# CaratOS Step 2 — Tenant Isolation Hardening — Report

> **Scope:** ONLY the tenant-isolation/security findings in `CARATOS_STEP1_AUDIT.md` §L (+ the schema/provenance and existence-check items it references). No product universalization, no jewellery-logic changes, no connectors, no frontend redesign, no RLS (Part 7 — deferred by instruction).
>
> **Safety:** No commit, no push, no deploy, no production migration, no data deletion (beyond tests' own fixtures), no `git add -A`. All work is local against the CaratOS dev DB `eclat_preview`.

---

## A. Changes made

The whole leak class in §L had one root cause: **`head_office` was treated as a global super-role, and provenance keys were globally unique.** Every fix threads `organisationId` (from the authenticated user) into the query/lookup/write that was missing it, and each was made at the shared choke-point rather than per-caller.

### Part 1 — CRITICAL sync provenance (invariant: `orgA + externalId X` can never resolve to `orgB + externalId X`)
- **Schema:** dropped 20 global single-column uniques → org-scoped composites:
  - `legacyId String? @unique` → `@@unique([organisationId, legacyId])` on **16 models** (Store, User, Party, MetalRate, Product, StockItem, StockMovement, Sale, SaleLine, ManufacturingOrder, ManufacturingOrderItem, ProductionBag, LedgerEntry, Payment, SchemeMember, ReturnRecord).
  - `LegacyRow` `@@unique([sourceTable, rowKey])` → `@@unique([organisationId, sourceTable, rowKey])`.
  - `SyncState` `@@unique([sourceTable, storeId])` → `@@unique([organisationId, sourceTable, storeId])`.
  - `Store.code`, `Region.code` (tenant-owned) → `@@unique([organisationId, code])`.
  - Left genuinely-global uniques untouched: `Organisation.slug`, `User.email` (login handle), `googleSub`, `partyId`, `phoneE164`, `wamid`, all `ref`, `Product [organisationId, sku]` (already scoped), `DiscountPreset.code`/`ReferralCode.code` (already scoped), reversal/one-to-one FKs.
- **Migration:** hand-written `20260831120000_caratos_org_scoped_provenance` (Prisma's `migrate dev` demanded a full DB reset due to unrelated drift in the `.env` DB — **refused; no reset**). Applied to **`eclat_preview` only** via `migrate deploy` (never prod). Verified: all 20 old indexes dropped, all 20 composites created, zero pre-existing `(org, key)` collisions.
- **`sync.service.ts`:** every provenance touch is now org-scoped — all 10 upserts key on `{ organisationId_legacyId: {…} }` (the composite `where` makes the `update` branch physically unable to touch another org's row); all `findUnique/findFirst` by `legacyId` add `organisationId`; branch/id resolution, `idMap`, website-match, `planAdoptions` candidate/known-id scans, and `syncProductImages` are org-filtered; and **all four destructive ops** (`resetSyncedData`, `pruneEmptyStores`, `purgeDemo`, `resetToHeadOffice`) now carry `organisationId` on every count/`deleteMany`/`updateMany`. A DMMF-driven `orgScopedWhere` helper scopes the heterogeneous purge/reset loops through each model's org column or nearest required org-bearing relation, and **skips (never wipes) a model it cannot tie to an org**.

### Part 2 — CRITICAL users isolation (`users.service.ts`)
- `getOrThrow(id)` → `getOrThrow(actor, id)` doing `findFirst({ id, organisationId: actor.organisationId })`. One change org-bounds **all 8** by-id mutations (updateRole, updateStore, deactivate incl. the reassign recipient, activate, approve, reject, setLeaveAllocation) — a cross-org target is now indistinguishable from non-existent (404) before any rank check.
- `list`, `listUnassigned`, `listPending` now all include `organisationId: actor.organisationId` (were `{}` / org-less → every tenant's users, pending-signup PII, unassigned users).

### Part 3 — HIGH leaks
- **stock-transfers:** `load(id)`→`load(user,id)` with `assertOrgAllowed` (root-cause for approve/reject/every transition); `list` org-bounded (was `{}`); `detail` org-checked.
- **stores:** `update`/`close`/`addManager` `assertOrgAllowed` after load (were role-only guards).
- **marketing:** `campaignFilter` `{}`→`{ organisationId }` (single choke-point → covers `assertCampaignInScope`, asset/task status updates, asset/task listings).
- **new-store:** `projects` org-bounded; `assertProjectInScope` blanket HO/allStores bypass replaced with a hard `project.organisationId === user.organisationId` check (covers checklist/milestone/vendor updates).
- **loyalty:** `scopedWhere` rewritten to `{ organisationId, OR: [storeFilter, { storeId: null }] }` (null-store branch fenced to the caller's org); `referrals` no-code path org-bound via its `code` relation (the `Referral` model has no org column); `payout` `assertOrgAllowed` after load.
- **ticketing:** `scopedWhere` rewritten identically → `list/get/update/close/addMessage` all org-bound; a store-less Org-B ticket is unreachable from Org A.

### Part 4 — MEDIUM
- **stores.listRegions:** org-filtered. **createRegion** code check org-scoped.
- **Public `/stores/directory` (§I-4/§L-M2):** now tenant-scoped. Accepts `?org=<id|slug>`; with no param it resolves the sole organisation **only when the platform is single-tenant** (keeps current Eclat self-signup working with no frontend change) and returns `[]` the moment a second org exists — never a first/default-org guess. *(Coordinator refinement — see §A note.)*
- **dashboard:** `productScope` null-store branch + `updateTaskStatus` (Task ownership) org-bound.
- **products.setImage:** `p.organisationId !== user.organisationId → NotFound` (the store-only check skipped null-store products).
- **discounts.create:** the price/cost snapshot lookup is now `findFirst({ id, organisationId })` — a foreign `productId` is a hard reject, not a silent margin leak.

### Part 5 — audit read (`audit-read.service.ts`)
- Replaced the store-only filter (which dropped all null-store rows) with `{ organisationId, OR: [storeFilter, …] }`. Org-level (null-store) events (role changes, user create/approve) are restored **for head office only** — a scoped manager stays bounded to their own store rows (no new visibility). Another tenant's audit — store-scoped or null-store — can never surface. *(Coordinator refinement gated the null-store branch to HO — see §A note.)*

### Part 6 — auth / existence checks
- **OTP `findUserByPhone`:** now collects **all** active last-10-digit matches and returns `null` (fail closed) unless exactly one — OTP can never resolve into the wrong organisation. *(This prevents wrong-org resolution; it does not enable one phone to log in to two orgs — that needs the future tenant-aware login flow. See §F.)*
- **HUID existence check (`stock.service.ts`):** the dedupe `findFirst` is org-scoped, so it no longer leaks another tenant's HUID or blocks a legitimate same-HUID piece in a different org.
- SKU (`@@unique([organisationId, sku])`) already org-scoped — left as-is; store/region `code` handled in Part 1.

### Coordinator refinements (author, on top of the agent lanes)
1. **audit-read:** gated the restored null-store (org-level) events to **HO only**, so store_managers gain no visibility they didn't have before (the task asked for HO to see org-level events; it did not ask to widen managers).
2. **stores.directory:** added the **single-org fallback** so current single-tenant Eclat self-signup keeps working (the frontend calls `/stores/directory` with no param, [auth.ts:90](frontend/src/lib/queries/auth.ts#L90)) while staying safe once a second tenant exists.
3. **Test teardown FK-order fix** in 3 new specs (`AuditLog.actorId → User` is `onDelete: RESTRICT`, so org-B audit rows must be deleted before the users they reference).
4. **`sync-store-adoption.e2e-spec.ts`:** updated the pre-existing unit test's `planAdoptions` call to the new org-scoped arity `(organisationId, records)` — the only existing test the signature change touched.

---

## B. Files changed (Step 2 only — the working tree also carries prior-session uncommitted work, out of scope)

**Schema + migration (2)**
- `backend/prisma/schema.prisma`
- `backend/prisma/migrations/20260831120000_caratos_org_scoped_provenance/migration.sql` *(new)*

**Backend services/controllers (16)**
- `backend/src/sync/sync.service.ts`
- `backend/src/users/users.service.ts`
- `backend/src/stores/stores.service.ts`, `backend/src/stores/stores.controller.ts`, `backend/src/stores/regions.controller.ts`
- `backend/src/stock-transfers/stock-transfers.service.ts`
- `backend/src/marketing/marketing.service.ts`
- `backend/src/new-store/new-store.service.ts`
- `backend/src/loyalty/loyalty.service.ts`
- `backend/src/ticketing/ticketing.service.ts`
- `backend/src/dashboard/dashboard.service.ts`
- `backend/src/products/products.service.ts` *(setImage only)*
- `backend/src/discounts/discounts.service.ts` *(create lookup only)*
- `backend/src/audit/audit-read.service.ts`
- `backend/src/auth/auth.service.ts` *(findUserByPhone only)*
- `backend/src/stock/stock.service.ts` *(HUID check only)*

**Tests (7)**
- New: `backend/test/org-isolation-{users,sync,stores-transfers,marketing-newstore,loyalty-ticketing,medium}.e2e-spec.ts`
- Modified: `backend/test/sync-store-adoption.e2e-spec.ts` *(arity fix for the org-scoped `planAdoptions`)*
- Unchanged (pre-existing, still green): `backend/test/org-isolation.e2e-spec.ts`

---

## C. Security issues fixed (mapped to the audit)

| Audit ID | Severity | Fixed |
|---|---|---|
| §L-C1 | CRITICAL | Global `legacyId`/`rowKey` cross-tenant sync collision & PII overwrite |
| §L-C2 | CRITICAL | UsersService cross-tenant read + mutation |
| §L-H1 | HIGH | Stock-transfer cross-tenant read/approve/reject |
| §L-H2 | HIGH | Store cross-tenant update/close/addManager |
| §L-H3 | HIGH | Marketing cross-tenant campaign/asset/task |
| §L-H4 | HIGH | New-store cross-tenant project/checklist/milestone/vendor |
| §L-H5 | HIGH | Loyalty cross-tenant referral PII + payout |
| §L-H6 | HIGH | Ticketing cross-tenant null-store tickets |
| §L-M1 | MEDIUM | Region list cross-tenant |
| §L-M2 / §I-4 | MEDIUM | Public directory tenant enumeration |
| §L-M3 | MEDIUM | Dashboard null-store product count + task write |
| §L-M4 | MEDIUM | products.setImage null-store cross-org |
| §L-M5 | MEDIUM | discounts.create cost/margin snapshot leak |
| §L-L1 | LOW | Audit read: HO could not see org-level events |
| §L-L3 | LOW | HUID existence oracle across orgs |
| §L-L4 | LOW | OTP phone resolving to the wrong org |
| §F-1 / §J-1 | (schema) | Destructive sync ops org-scoped; provenance uniqueness org-scoped |

**Also fixed structurally:** the four destructive sync ops (`resetSyncedData`, `purgeDemo`, `pruneEmptyStores`, `resetToHeadOffice`) that previously ran `deleteMany` with no org filter (one tenant's admin could wipe all tenants) are now org-scoped.

---

## D. Tests added / changed

- **6 new isolation specs** (58 assertions total across all 7), each building a fresh, spec-unique Org B from scratch and proving both directions: Org A cannot read/modify Org B, and Org B can still act on its own data. Coverage matches Part 8's required matrix — users, stores, marketing, new-store, referrals+payout, tickets, stock transfers+approve, products, dashboard, audit, and the duplicate-legacy-ID overwrite exploit.
- **1 pre-existing test adapted** (`sync-store-adoption`) to the new org-scoped `planAdoptions` arity — logic unchanged, still 6/6.
- No existing test was weakened or deleted; the pre-existing `org-isolation.e2e-spec.ts` still passes 12/12.

---

## E. Exact test results (verbatim, against `eclat_preview`)

**Compile / build**
- `npx tsc --noEmit` → **exit 0 (clean)**
- `npx nest build` → **exit 0**
- `eclat_preview` migrate status → **56 migrations applied, schema up to date**

**Isolation specs (run individually)**
```
org-isolation.e2e-spec.ts ................ 12 passed
org-isolation-users.e2e-spec.ts .......... 10 passed
org-isolation-sync.e2e-spec.ts ...........  2 passed
org-isolation-stores-transfers.e2e-spec .. 13 passed
org-isolation-marketing-newstore.e2e-spec.  9 passed
org-isolation-loyalty-ticketing.e2e-spec .  7 passed
org-isolation-medium.e2e-spec.ts .........  5 passed
                                           ── 58 passed, 0 failed
```

**Full E2E suite** (`jest --config ./test/jest-e2e.json --runInBand`)
```
Test Suites: 1 skipped, 33 passed, 33 of 34 total
Tests:       6 skipped, 310 passed, 316 total
FULL_E2E_EXIT=0
```
The 1 skipped suite / 6 skipped tests are pre-existing, environment-gated skips (unchanged from the prior baseline of 6 skips) — not introduced by this step. **0 failures.**

*(An initial full run surfaced 1 failing suite — `sync-store-adoption` — because that pre-existing unit test still called `planAdoptions` with the old single-arg signature; fixed by passing the org id, re-run confirms 6/6 and the full suite at 0 failures.)*

---

## F. Remaining isolation risks (documented, not silently left)

1. **OTP + genuinely shared phone across tenants** — today's mitigation *prevents wrong-org resolution* (fails closed on ambiguity) but does not *enable* the same phone to sign in to two orgs. The proper fix needs a **tenant-aware login context** (org resolved from subdomain/slug at login), which does not exist yet. Deferred to the future onboarding/domain work.
2. **Public `/stores/directory`** — the single-org fallback is safe only while the platform is single-tenant; once a second org exists, the signup UI must pass `?org=`. A proper fix resolves the org from the signup *context* (subdomain/custom domain). **Frontend follow-up:** [frontend/src/lib/queries/auth.ts:90](frontend/src/lib/queries/auth.ts#L90) will need to pass the org once multi-tenant signup lands (no change needed today — single-org fallback covers it).
3. **`Store.code`/`Region.code` now org-scoped, but `Store.id` remains the global PK** — the app derives some store ids from slugs; two orgs with the same store code could still collide on `id`. A schema/id-strategy decision for a later step (flagged, not a live leak — the org-scoped code constraint closes the enumeration/conflict path).
4. **App-level isolation depends on every query carrying an org predicate.** This step closed the 16 audited misses and adds regression tests, but the durable guarantee is **Postgres RLS** — explicitly deferred to a later hardening step (Part 7).
5. **No platform super-admin tier** — `head_office` is now strictly org-bounded everywhere (correct for this step). A cross-org platform-admin principal, if ever needed, is a deliberate future addition.

---

## G. Deliberately deferred (per instruction or dependency)

- **RLS (Part 7)** — explicitly out of scope for Step 2; application-level isolation made correct + tested first.
- **Tenant-aware login/signup architecture** — the OTP and public-directory proper fixes depend on it; not invented here (would be a rushed architecture). Minimal safe mitigations shipped instead.
- **Platform super-admin tier** — not introduced (task said don't unless required for correctness; it wasn't).
- **`Referral` model org column** — the model has no `organisationId`; org-bounded via its `code` relation instead of a schema change (kept the diff to isolation only).
- **Product/`Store.id` id-strategy** — noted in §F, belongs to a schema step.
- Everything explicitly forbidden by the task: industry abstraction, product taxonomy, custom attributes, connector runtime, generic SQL connector, frontend universalization, branding, pricing abstraction — **not touched.**

---

## H. Confirmation: no deployment / commit / push occurred

- **No `git commit`, no `git push`, no `git add`** — verified: `git status` shows all Step-2 changes still unstaged/untracked (working tree only; 186 files total including prior-session work).
- **No deploy** to Railway/Vercel.
- **No production migration** — the new migration was applied **only** to the local `eclat_preview` dev DB via `migrate deploy`; Prisma's reset was refused when offered.
- **No production data change / no data deletion** — only tests' own fixtures were created and torn down.
- **Invariants preserved (Part 9):** `StoreScopeService`, JWT DB-derived `organisationId`, fail-closed empty scope, `assertStoreAllowed`/`assertOrgAllowed`, the role hierarchy, org-scoped AI embeddings/search, sync extraction behaviour, no-default-store attribution, and the audit trail — all intact and still green in the full suite.

**STOP — Step 2 complete. Awaiting explicit direction before any deploy or Step 3.**
