# Eclat / CaratSense — Target Schema (PostgreSQL) — ER Overview

The Eclat **target** data model. Authored as a Prisma schema at
`backend/prisma/schema.prisma`; the initial migration lives at
`backend/prisma/migrations/<ts>_init/`. This is the clean Postgres design the new
backend (NestJS, added separately) sits on. The legacy SQL Server model is described in
`docs/legacy-schema.md`; this doc maps legacy → Eclat and marks which tables are
**sync-fed** (mirror legacy rows) vs **Eclat-native** (no legacy data).

- ORM: **Prisma 6**, provider PostgreSQL. 45 application tables.
- Applied to dev DB `eclat_dev` (Postgres 18, `localhost:5432`).

## Design principles (from CLAUDE.md)
1. **Multi-store first.** `Region → Store` hierarchy; every business entity carries
   `storeId`. Area/HO roles roll up via `Region` + `UserStore` + role rank.
2. **RBAC.** `User` (role: salesperson / store_manager / area_manager / head_office),
   `UserStore` assignments, and `DiscountLimit` for per-role discount ceilings (Module 15).
3. **Exact numerics.** Every money / gold-weight / making-charge / tax field is
   `Decimal(p,s)` — never float. Weights use scale 3 (grams/carats), money scale 2.
4. **Legacy hubs mapped** so backfill + 15-min live sync stay coherent.
5. **Sync provenance.** Sync-fed tables carry `legacyId` (unique) + `legacyUpdatedAt`;
   the agent upserts by watermark and records progress in `SyncState`.
6. **Images out of the DB.** Only URLs (+ future embedding vectors) live in Postgres;
   files go to object storage (per `docs/DATA_PIPELINE.md`).
7. **Indexes for the dominant pattern:** `(storeId, createdAt)` / `(storeId, <date>)`
   plus FK and status indexes.

## Entity groups

### Core — multi-store + RBAC (Eclat-native)
- **Region** — area/HO grouping.
- **Store** — branch; geofence (lat/lng/radius) for geo-attendance; `legacyId` ← PartyMst location row.
- **User** — staff login; `role`; optional 1:1 link to `Party` (staff master).
- **UserStore** — user↔store assignment (salesperson→1, area/HO→many); optional per-assignment role.
- **DiscountLimit** — per-role (optionally per-store) max discount % / amount (Module 15).
- **SyncState** — per-(sourceTable, store) watermark for the live sync agent.

### Party hub (sync-fed) — legacy `PartyMst`
- **Party** — universal customer/supplier/staff/salesperson/branch/account master;
  `types PartyType[]` replaces the legacy boolean role flags. Birthday/anniversary feed CRM reminders.

### Module 1 — CRM & Leads (Eclat-native; customer ← Party)
- **Lead** (ref, stage, source, value, owner, store) — **LeadNote**, **OccasionReminder**.

### Module 2 — Quotation & Pricing (Eclat-native; pricing ← legacy rate charts)
- **MetalRate** — daily metal-rate feed (sync-fed from RateDailyMst/MetalRateMst).
- **Quote** (portable: `storeId` origin + **QuoteRedeemableStore** for redeem-anywhere),
  money rollup snapshot — **QuoteLine** (per-line karat / weight / gold rate / making / stone).

### Module 5 + 9 — Catalogue / Product + Stock (sync-fed)
- **Product** — design/catalogue template (← StyleMst); `imageUrl`, `stlUrl`, and
  `embedding Float[]` for AI image search (see below).
- **StockItem** — per-physical-piece (← Inward + InwardSummary): gross/net/pure/loss
  weights, diamond/stone weights & pieces, metal/diamond/stone/making/CPF amounts, MRP/cost,
  hallmark/certificate, aging. **StockMovement** — append-only movement log (← InwardHistory).

### Sales (sync-fed) — legacy `JewelTrans`
- **Sale** (docType sale/purchase/branch_transfer/proforma/returns; `isCancelled`
  mirrors legacy `isCancel` soft-cancel) — **SaleLine** (← JewelTransInwardDetail). DSR source (Module 10).

### Module 8 — Timelines (sync-fed + native)
- **ManufacturingOrder** (← Spm_MfgOrder) — **ManufacturingOrderItem** (← SPM_MfgOrderItem)
  — **ProductionBag** (← SPM_BagMaster).
- **CustomOrder** + **CustomOrderEvent** — customer-facing stage timeline (OP-1 open:
  external vs internal visibility).

### Module 4 + 12 — Finance (sync-fed)
- **LedgerEntry** (← Journal / AccountBalance / DueDetail) — AR/AP, side, due dates.
- **Payment** (← VoucherEntry) — mode, reconciled flag (Module 12), links to Sale / SchemeMember.

### Module 6 — HRMS & geo-attendance (Eclat-native)
- **AttendanceRecord** (geo-tagged check-in vs store geofence), **LeaveRequest**, **Commission**.

### Module 7 — Check-ins & footfall (Eclat-native; CCTV dropped)
- **CheckIn** — customer entry/exit, attending rep, purpose, outcome.

### Module 17 — Loyalty & gold savings (Eclat-native; legacy schema-only)
- **SchemePlan** (← SchemeMaster) — **SchemeMember** (← SchemeMemberMaster) —
  **SchemeInstallment** (per-installment, gold-weight credited).

### Modules 13 / 14 / 15 / 16 / 11 (mostly Eclat-native)
- **Ticket** + **TicketMessage** (13, patternTag for recurrence).
- **ReturnRecord** + **ReturnPhoto** (14; ← JewelTrans return variant; photo intake = URLs).
- **DiscountRequest** (15; requester/approver + role, margin-impact preview).
- **MarketingCampaign** + **CampaignStore** + **MarketingAsset** (16).
- **NewStoreProject** + **NewStoreChecklistItem** + **NewStoreMilestone** + **NewStoreVendor** (11).

## Legacy → Eclat mapping (sync-fed tables)

| Legacy (SQL Server) | Eclat (Postgres) | Watermark (see DATA_PIPELINE.md) |
|---|---|---|
| `PartyMst` | `Party` (+ `Store` for location rows) | `PartyNo` → `legacyId`; `UpdateDate` |
| `StyleMst` (+ Summary) | `Product` | `StyleId`; `UpdateDate` |
| `Inward` + `InwardSummary` | `StockItem` | `JewelId`; `UpdateDate` |
| `InwardHistory` | `StockMovement` | `Id` (append-only) |
| `JewelTrans` | `Sale` | `JewelTransId`; `UpdateDate`; `isCancel` |
| `JewelTransInwardDetail` | `SaleLine` | parent `JewelTransId` |
| `Spm_MfgOrder` | `ManufacturingOrder` | `OrderId`; `UpdateDate` |
| `SPM_MfgOrderItem` | `ManufacturingOrderItem` | `OrderItemId` |
| `SPM_BagMaster` | `ProductionBag` | `BagId` |
| `Journal` / `AccountBalance` / `DueDetail` | `LedgerEntry` | `Id` (append-only) |
| `VoucherEntry` | `Payment` | `VoucherEntryId`; `UpdateDate` |
| `RateDailyMst` / `MetalRateMst` | `MetalRate` | rate-effective date |
| `SchemeMaster` / `SchemeMemberMaster` / `SchemeMemberInstalment` | `SchemePlan` / `SchemeMember` / `SchemeInstallment` | (no legacy data — design ref only) |

**Eclat-native (no legacy source):** Region, User, UserStore, DiscountLimit, SyncState,
Lead/LeadNote/OccasionReminder, Quote/QuoteLine/QuoteRedeemableStore, CustomOrder(+Event),
AttendanceRecord, LeaveRequest, Commission, CheckIn, Ticket(+Message),
DiscountRequest, MarketingCampaign(+Store/Asset), NewStore* . `ReturnRecord` is partially
sync-fed (return-type JewelTrans) but mostly native (photo intake, approval workflow).

## How RBAC + store-scoping is enforced (for the backend-engineer)
- **No DB-level RLS in this initial migration.** Scoping is enforced in the NestJS layer:
  a request carries the user's role + their `UserStore` set; query guards inject a
  `storeId IN (...)` filter (salesperson → own store; store_manager → store;
  area_manager → region's stores; head_office → all). Role rank mirrors the frontend
  `ROLE_RANK` (salesperson 1 → head_office 4).
- **Optional hardening (recommended later):** enable Postgres **RLS** on store-scoped
  tables with a policy on `current_setting('app.store_ids')`, set per request via
  `SET LOCAL`. The schema is RLS-ready (every business table has `storeId`). Track this as
  a follow-up migration; do not block on it.
- **Discount approval:** `DiscountLimit` holds per-role ceilings; the app compares a
  `DiscountRequest.percent` against the requester's limit and auto-escalates
  (`status = escalated`) when it exceeds the role's `maxPercent`.

## AI image search (Module 5) — pgvector upgrade
pgvector is **not installed** on the dev Postgres, so `Product.embedding` is `Float[]`
(portable; the migration applies anywhere). To enable ANN search where `vector` exists:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE "Product" ADD COLUMN embedding_v vector(512);
-- re-embed (or cast) into embedding_v, then drop the Float[] column
CREATE INDEX product_embedding_hnsw ON "Product"
  USING hnsw (embedding_v vector_cosine_ops);
```
Model the column in Prisma as `Unsupported("vector(512)")` and run search via `$queryRaw`
(`ORDER BY embedding_v <=> $1 LIMIT k`). Image **files** stay in object storage — only the
URL + vector live in Postgres.
