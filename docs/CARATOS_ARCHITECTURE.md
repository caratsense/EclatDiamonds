# CaratOS Architecture

> **Status (2026-09-08): historical blueprint, not a current delivery inventory.**
> Its earlier “contract only / spec only” labels for tenancy, imports, BUSY, Tally
> and CaratOS Connect have been superseded by
> [MULTI-MARKET-CONNECTOR-ARCHITECTURE.txt](MULTI-MARKET-CONNECTOR-ARCHITECTURE.txt).
> Eclat remains the reference implementation and must keep working at every step.
>
> Companion audit context lives in [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md),
> [MULTI_STORE.md](MULTI_STORE.md), [GATI_DATA_CONTRACT.md](GATI_DATA_CONTRACT.md),
> [DATA_PIPELINE.md](DATA_PIPELINE.md).

---

## 1. Current architecture (what exists today)

| Layer | Reality | CaratOS relevance |
|---|---|---|
| Backend | NestJS + Prisma 6 + PostgreSQL, ~40 domain modules | Keep. Modules map cleanly to CaratOS "Core Business / Workforce / Intelligence / Finance". |
| Frontend | Next.js 16 + React/TS + react-query; role-aware nav from `lib/navigation.ts` | Keep. Add feature-gating alongside role-gating. |
| Schema | ~90 models, ~40 enums. Hierarchy: `Region? → Store → User/UserStore` | **No `Organisation` node** — the one structural gap. |
| Identity | JWT → `User` → `UserStore[]` → `storeIds` | Tenant slots **above** this: JWT carries `organisationId`; store scope derived from tenant membership. |
| Isolation | Server-side `StoreScopeService` (`storeFilter` / `effectiveStoreIds` / `assertStoreAllowed`). Frontend scope is advisory only. | **Correct pattern.** Organisation scope layers on top; store isolation is untouched. |
| RBAC | Rank-monotonic `RolesGuard` (`salesperson < store_manager < head_office`; `area_manager` collapsed). Sensitive ops use explicit exclusions. | Keep ranks; add explicit permission grants for sensitive ops later. |
| Provenance | Domain models carry generic `legacyId` + `legacyUpdatedAt`; `SyncState` (watermark), `LegacyRow`, `DocSequence` exist. | **Already source-generic** — not Gati-typed. Extend to multi-source. |
| Sync/Gati | Gati-specific extraction (SKU→karat, category decode, branch match) is **concentrated in `backend/src/sync/`**. Other services only reference Gati in comments describing where a `legacyId` came from. | Wrap `sync/` as `GatiConnector` behind a generic interface; core never imports Gati. |
| Source-of-truth | **Already exists** (Module 9): post-transfer `stock.storeId` is CaratOS-owned, protected from sync overwrite. | Generalize into a field-level `SourceOwnershipPolicy`. |
| Integrations | `integrations/` has provider-shaped `gold-rate` (keyless), `whatsapp`, `razorpay`, `email` — each with `enabled` + safe `dryRun` no-op. | The connector pattern in embryo. Generalize to a registry. |
| AI | `products/jewelry-similarity` + `jewelry-ranking` + `ml-inference.service` (dual DINOv2/SigLIP, in-memory cosine). Degrades honestly to `SEARCH_ERROR` / `NO_CLOSE_MATCH`. | Abstract behind an `ImageEmbeddingProvider`; never Anthropic-locked; never fake scores. |
| Storage | Cloudflare R2, signed access. | Media stays provider-abstract (`ImageConnector` / object store). |
| Audit | `AuditLog` + `AuditService.record` on sensitive mutations. | Extend audit to org/connector/sync events. |
| Infra | Backend on Railway (root_dir=backend, `prisma migrate deploy` preDeploy), frontend on Vercel (`/_api` proxy), R2 media. | Unchanged. Multi-tenant is a data concern, not an infra rewrite. |

### Assumption sweep (production paths) — no dangerous defaults
- `MOCK_STORES[0]` session default = the synthetic **"All Stores" aggregate** (`isAggregate`), not a real store.
- Sync target `defaultStoreId` is **configured per-install and throws if unset** ("no main store, never fall back").
- `resolveTimezone → storeIds[0]` is **timezone-anchor only** (all branches Asia/Kolkata today).
- HRMS / team `userStores[0]` fallbacks are **user-scoped** (the actor's own first store), never cross-tenant.
- All "Surat" strings are **comments, UI placeholders, or Eclat marketing copy** — branding to neutralize, not logic.

**Conclusion:** Eclat is a well-factored single-tenant app that is unusually close to the CaratOS shape. The decoupling is mostly *adding a tenant node* and *formalizing the connector/import contracts that already exist informally*.

---

## 2. Target architecture

```
CaratOS Platform
  └── Organisation (tenant)            ← NEW top-level node
        ├── Region (optional)
        │     └── Store / Warehouse / Office
        ├── Users / Roles / Permissions
        ├── Feature entitlements
        └── Integrations
              └── Integration Engine   ← generic connector layer
                    ├── GatiConnector      (wraps existing sync/)
                    ├── TallyConnector      (contract only — BLOCKED on specs)
                    ├── BusyConnector       (contract only — BLOCKED on specs)
                    ├── Excel / CSV / XML / JSON Connector
                    ├── SqlServer / MySql / Postgres Connector
                    └── CustomApiConnector
                          ↓
                    Canonical Model (source-agnostic)
                          ↓
   Products · Stock · Customers · Staff · Sales · Payments ·
   Orders · Manufacturing · Media
```

**Invariant:** the core application depends only on the **Canonical Model**. It never imports Gati/Tally/BUSY-specific code. Connectors map *into* the canonical model; adapters keep source specifics at the edge.

---

## 3. Canonical data layer (Phase 2 — contracts landed this phase)

Every externally-sourced record carries a **provenance envelope** (see
`backend/src/integration/contracts/provenance.ts`):

- `sourceSystem` (gati | tally | busy | excel | csv | sqlserver | mysql | postgres | api | manual)
- `externalId` / `legacyId`
- `organisationId`, `storeId?`
- `createdAt` / `updatedAt`
- sync metadata (`syncedAt`, `watermark`, `batchId`)
- **field-level ownership** (`SOURCE_OWNED` | `CARATOS_OWNED` | `CONFLICT` | `UNKNOWN`)

Canonical entities (contracts in `backend/src/integration/contracts/canonical.ts`):
`Organisation, Store, CanonicalUser/Staff, CanonicalCustomer, CanonicalProduct,
CanonicalStockItem, CanonicalSale/SaleLine, CanonicalPayment, CanonicalOrder/OrderItem,
CanonicalManufacturingOrder, CanonicalProductionBag, CanonicalStockMovement, CanonicalMedia`.

These are **TypeScript contracts only** — the existing Prisma models remain the runtime
persistence. The canonical types are the shape connectors produce and the mapping engine
validates against, decoupling extraction from storage.

**Metal/purity rule:** never invent purity. Canonical `metal`/`karat` are optional and
carry `Unknown/Unspecified` where the source is silent. (Mirrors the existing
`MetalKind.gold_unspecified`.)

---

## 4. Integration engine (Phase 3 — contracts landed this phase)

`IntegrationConnector` interface (`contracts/connector.ts`) with the lifecycle:

```
discover() → inspect() → preview() → extract() → transform()
           → validate() → reconcile() → sync()
```

Each connector declares **capabilities** (`supportsCustomers/Products/Stock/Sales/
Payments/Staff/Manufacturing/Images/Orders`) so an org can mix sources
(e.g. Gati→inventory, Tally→accounting, Excel→staff, R2→images) simultaneously.

> **No fake mappings.** Only the *contract* is defined. `GatiConnector` will wrap the
> existing, real `sync/` extraction. `TallyConnector` / `BusyConnector` are **BLOCKED**
> until real field specs / test instances are available — their capability sets will
> report `NOT_CONFIGURED`, never guessed mappings.

---

## 5. CaratOS Connect (Phase 4 — spec only, not built this phase)

A Windows-first local agent (separate deployable, not in this repo yet):

```
CaratOSConnect/  connector · config · imports · exports · logs · cache · queue
```

Reads the customer's SQL Server / MySQL / files **read-only**, extracts to a controlled
intermediate representation, validates, queues offline, uploads over authenticated TLS,
retries, reconciles. Must not require the source software to expose an API. Credentials
encrypted at rest; never sent to the browser. Detailed spec: `docs/CARATOS_CONNECT.md`
(to be authored when Phase 4 is approved).

---

## 6. Import / export & discovery (Phases 5–6 — contracts landed this phase)

`ImportProfile` + `FieldMapping` (`contracts/import-profile.ts`): column detection →
mapping UI → preview → validation → duplicate detection → import. Mappings are saved as
a reusable profile per (organisation, source). **Never assume column meaning** — unknown
columns are surfaced for user confirmation with a `confidence` score.

Discovery + dry-run (`contracts/sync-result.ts`): every first-time import produces a
`DiscoveryReport` and every sync a `ReconciliationReport` with
`discovered/imported/updated/skipped/failed/duplicated/unmapped/missingStore/needsReview`
plus per-record errors. **Required flow:**
`DISCOVER → PREVIEW → VALIDATE → CONTROLLED SAMPLE → RECONCILE → USER APPROVAL → FULL SYNC`.
No destructive/full sync runs immediately. `--sample / --store / --entity / --limit`
are first-class.

---

## 7. Multi-tenant / store attribution (Phase 7 — DEFERRED, needs approval)

Data isolated by **organisation + store**. Store managers see only assigned stores; HO
sees org-wide. **Never** use first/alphabetical/Surat/default/machine-name fallback for
ownership. If attribution is impossible → `UNASSIGNED / HOLD` with explicit reconciliation,
never a guess.

This requires the schema migration below and is **not executed this phase**.

---

## 8. Source of truth (Phase 9 — pattern exists, generalize later)

Field ownership is one of `SOURCE_OWNED | CARATOS_OWNED | CONFLICT | UNKNOWN`. Sync never
overwrites a `CARATOS_OWNED` field. **The existing stock-transfer protection
(`stock.storeId` post-transfer) must remain intact** and becomes the first policy entry.

---

## 9. AI catalogue (Phase 12 — contract landed this phase)

`ImageEmbeddingProvider` (`contracts/embedding-provider.ts`) abstracts embedding behind an
interface (self-hosted DINOv2/SigLIP today; Gemini/OpenAI/future via adapter). AI operates
on **canonical products** regardless of origin. If unavailable, catalogue works normally and
search reports a degraded state. **Never fake similarity scores** — the existing
`NO_CLOSE_MATCH` / `SEARCH_ERROR` honesty is the standard.

---

## 10. Migration strategy (safe, additive, reversible)

**This phase (done):** contracts + this doc. Zero migration, zero runtime change.

**Next — Organisation foundation (needs approval; local-only when approved):**
1. Classify all ~90 models: `GLOBAL | ORGANISATION | STORE | USER | TRANSACTION | INTEGRATION`.
2. Add `Organisation` model; add **nullable** `organisationId` to organisation-owned models.
3. Backfill the single existing "Eclat" organisation onto all rows.
4. Flip `organisationId` to required; add org-aware indexes and `@@unique([organisationId, …])`
   only where a global unique would otherwise collide (SKU, `legacyId`, store `code`, user handle).
5. Resolve `organisationId` from JWT in `StoreScopeService`; add `assertOrgAllowed`.
6. Regression + isolation tests each step. Eclat stays organisation #1 with identical behaviour.

**Decisions required before step 1** (from the audit):
1. Tenancy model: shared-DB + `organisationId` (recommended) vs schema/DB-per-tenant.
2. Tenant resolution: `organisationId` in JWT (recommended) vs subdomain vs header — never request body.
3. Keep `Region` optional under `Organisation`.
4. "Eclat" organisation name/slug for backfill.
5. RBAC: additive explicit permissions alongside ranks (recommended, non-breaking).
6. Which global uniques become org-scoped.

---

## 11. Risks

- **Schema migration on ~90 models** — highest-risk step; mitigated by the nullable→backfill→require sequence and per-step regression.
- **Unique-constraint collisions** across orgs (SKU, handles) — must be decided per field.
- **Timezone roll-ups** once orgs span zones — `resolveTimezone` needs per-store windows.
- **Connector coverage is installation-specific** — Tally stays blocked. BUSY is enabled only for the
  verified `Master1` debtor/customer-master path through the outbound Connect agent; products, stock,
  vouchers and ledgers stay blocked until each client installation is inspected. Never fabricate mappings.
- **Feature-gating drift** — backend must enforce every feature the frontend hides.

---

## 12. What must NOT be changed

- Server-side store isolation (`StoreScopeService`) and its guarantees.
- Rank-monotonic RBAC semantics currently relied on by every controller.
- The stock-transfer source-of-truth protection.
- Honest AI degradation (`NO_CLOSE_MATCH` / `SEARCH_ERROR`).
- Working Gati extraction in `sync/` (it becomes `GatiConnector`, not a rewrite).
- Existing routes/DTOs without a compatibility adapter.
- No hardcoded store fallback may be introduced anywhere.

---

## 13. Implementation phases (status)

| Phase | Scope | Status |
|---|---|---|
| 1 | Audit | **DONE** |
| 2 | Canonical model contracts | **DONE (this phase, contracts only)** |
| 3 | Integration connector contracts | **DONE (this phase, contracts only)** |
| 4 | CaratOS Connect agent | **SPEC ONLY** |
| 5–6 | Import/export + discovery contracts | **DONE (this phase, contracts only)** |
| 7 | Organisation model + migration | **DEFERRED — needs approval** |
| 8 | Generic sync engine (report contract) | **DONE (contract); engine DEFERRED** |
| 9 | Source-of-truth policy | **PATTERN EXISTS; generalize DEFERRED** |
| 10 | Images/media contract | **DONE (contract only)** |
| 11 | Staff import optional | **PATTERN EXISTS (manual creation works)** |
| 12 | AI provider abstraction contract | **DONE (contract only)** |
| 13 | Onboarding wizard | **SKELETON EXISTS; DEFERRED** |
| 14 | Integration UI | **DEFERRED** |
| 15 | Security (connector) | **SPEC in Phase 4** |
| 16 | Testing | **run each phase** |

Nothing above wires into the request path yet; the contracts are the seam that lets each
later phase land without touching core business logic.
