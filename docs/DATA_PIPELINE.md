# Eclat / CaratSense — Data Pipeline (Legacy → Eclat)

How data gets from the client's existing jewelry ERP (**Gatisofttech SJE Plus / APRS-SJEP**, SQL Server) into Eclat. Modeled on the **proven** Busy→CaratSense sync built for the Ashish Textile client (`auto_sync_busy.py`). This is the reference implementation — repointed from MS Access to SQL Server.

## The decision
**Hybrid pipeline** = one-time historical backfill + continuous live sync.

1. **Initial backfill (one-time):** restore the latest `APRSSJEP.bak` into a throwaway SQL Server, map the APRS tables to the Eclat model, ETL all history into Eclat's Postgres. Done once per store.
2. **Ongoing live sync (the real pipeline):** a small Python agent runs on the client's **office PC** (where SQL Server lives), connects **read-only** to the *live* database every ~15 min, detects new/changed rows via a watermark, and pushes them to the Eclat backend API. No manual exports, no `.bak` handover for day-to-day, no freeze window.

**Why this beats the `.bak`-handover approach:** his system keeps adding data all day. A one-time backup is stale immediately. The live agent keeps Eclat current automatically and never needs access *into* his server (it pushes out). The `.bak` route is kept only as the initial backfill + a disaster fallback.

## Why it's lower-risk than the textile case
| | Ashish (Textile) — proven | Jewelry (SJEP/APRS) |
|---|---|---|
| Their software | Busy | Gatisofttech SJE Plus / APRS |
| DB engine | MS Access `.bds` (file-locked) | **SQL Server** (live server) |
| Driver | pypyodbc + Access ODBC (32-bit, fiddly) | **pyodbc + SQL Server ODBC (cleaner)** |
| Read method | copy file → temp → query | query the live DB read-only (no copy needed) |
| Net | works in production today | strictly simpler |

## Architecture
```
CLIENT OFFICE PC (where SJE Plus + SQL Server run)
  ┌─────────────────────────────────────────────┐
  │  sync_sjep.py  (Windows Task Scheduler:       │
  │                 every 15 min + at login)      │
  │   ① pyodbc connect read-only to live SQL Srvr │
  │   ② watermark check (UpdateDate/EntryDate/PK) │
  │   ③ SQL queries on APRS tables (IMPLEMENTED)  │
  │   ④ transform → clean records                 │
  │   ⑤ push to Eclat REST API / direct PG load   │
  └───────────────────────┬──────────────────────┘
                          │ HTTPS (push out — no inbound access to his server)
                          ▼
                 ECLAT BACKEND  →  PostgreSQL (Railway)
                                   images → object storage (URLs only)
```

## Reliability rules (copied from the proven textile sync)
- **Never lose a row:** only advance the watermark/sync-state after *every* upload chunk returns 200. Any failure → retry everything next cycle.
- **Change detection:** skip work when nothing changed (watermark unmoved).
- **Schema-defensive:** discover available columns at runtime; APRS column names may vary by version.
- **Batch big IN()/uploads** so a full year of vouchers can't exceed query/timeout limits.
- **Read-only:** the agent must never write to his live DB.

## Status — implemented (2026-06-17)

### 1. Live-sync extract queries — DONE
`data_sync/EclatSync/sync_sjep.py` now has **real SQL** in every `extract_*()` (no more `TODO(schema)`), validated against the restored copy `APRSSJEP_eclat` on `localhost\SQLEXPRESS`:

| Extractor | Legacy source | Watermark | Rows (restored copy) |
|---|---|---|---|
| `extract_parties` | `PartyMst` | `UpdateDate`/`EntryDate` | 564 |
| `extract_items` | `StyleMst` + `StyleMstSummary` + `ToneMst` | `UpdateDate`/`EntryDate` | 753 |
| `extract_stock` | `Inward` + `InwardSummary` + `ToneMst` | `UpdateDate`/`EntryDate` | 2,690 |
| `extract_sales` | `JewelTrans` | `UpdateDate`/`EntryDate` | 239 |
| `extract_sale_lines` | `JewelTransInward` + `JewelTransInwardSummary` | parent `JewelTransId` | 3,275 |
| `extract_orders` | `Spm_MfgOrder` | `UpdateDate`/`EntryDate` | 121 |
| `extract_order_items` | `SPM_MfgOrderItem` | parent `OrderId` | 1,220 |
| `extract_payments` | `Journal` (day-book) | `EntryDate`/identity `Id` | 475 |

The watermark predicate is `UpdateDate > @since OR (UpdateDate IS NULL AND EntryDate > @since)`, with `@since=''` meaning full backfill. Each extractor returns clean `list[dict]` records.

**Production sink correction:** the original skeleton POSTed Excel to `/upload/excel` — that route **does not exist** in the Eclat NestJS backend. The module header in `sync_sjep.py` now documents the real target: either (a) a per-entity bulk-upsert **Eclat REST API** route keyed on `legacyId`, or (b) a **direct Postgres load** (same upsert-on-`legacyId` logic as the backfill below). The `/upload/excel` code is retained only as a reference shape and is **not** wired in.

### 2. One-time backfill — DONE & RUN
`backend/scripts/backfill-legacy.mjs` (Node + Prisma client + legacy reader) loads core entities into `eclat_dev` and was run successfully. Rows loaded:

| Eclat table | Legacy source | Rows loaded |
|---|---|---|
| `Party` | `PartyMst` | 564 |
| `Product` | `StyleMst` (+Summary) | 753 |
| `StockItem` | `Inward` (+`InwardSummary`) | 2,690 |
| `Sale` | `JewelTrans` | 239 |
| `SaleLine` | `JewelTransInward` (+Summary) | 3,275 |
| `ManufacturingOrder` | `Spm_MfgOrder` | 121 |
| `ManufacturingOrderItem` | `SPM_MfgOrderItem` | 1,220 |

- **Idempotent:** upserts on unique `legacyId`; re-running produces identical counts (verified) and never touches the demo seed (rows without `legacyId`). Demo parties stay at 4 → `Party` total 568.
- **Store mapping:** the backup is a single-branch fresh install with no clean legacy→store mapping, so everything attaches to the seeded store **`surat-main`**.
- **Run it:** `cd backend && node scripts/backfill-legacy.mjs`  (verify with `node scripts/verify-backfill.mjs`).

**Connection quirk (local only):** the local `SQLEXPRESS` has **TCP/IP disabled** (shared-memory/named-pipes only) and SQL Browser stopped, so the `mssql`/tedious npm driver cannot reach it without reconfiguring the service (disallowed — originals are read-only). The backfill therefore reads the legacy DB via the working **`Invoke-Sqlcmd`** path (SqlServer PowerShell module) as a JSON-returning child process. `mssql` stays installed for the production agent, where the client's server has TCP enabled.

## What still requires the client's LIVE SQL Server
1. **Live-sync deployment.** The Python agent must run on the client's office PC against the live `APRSSJEP` DB (not the restored `APRSSJEP_eclat` copy). The SELECTs are identical; only `SJEP_SQL_DB`/`SJEP_SQL_SERVER` change. The agent needs a least-privilege read-only login and TCP/IP enabled (or run through the same `Invoke-Sqlcmd` bridge).
2. **Wire the production sink.** Build the Eclat REST bulk-upsert routes (or point the agent at the direct Postgres load) and advance the watermark only after a confirmed 200/commit.
3. **Code decodes to confirm on the live data** (marked `# LIVE-DB:` in `sync_sjep.py`):
   - `JewelTrans.TranType` → `SaleDocType` (JWSL/JWPH/JWBAP/JWBAI/JWPRM/BJW* — confirm branch-transfer vs return variants).
   - `Spm_MfgOrder.OrderStatus` int codes → Eclat `OrderStatus` stages (backfill maps all to `booked` for now).
   - Receipts: confirm whether the client books payments in `VoucherEntry` (only 13 rows here) vs `Journal`; add a `VoucherEntry` extractor + `Payment` mapping if so.
   - `Inward` karat: legacy stores metal *tone* not karat; the backfill defaults gold to 22k. True karat needs the live `RateChart`/quality join.
4. **Full history.** The restored backup looks like a fresh install (Mar–Jun 2026 only, ~239 sales). Confirm the live DB carries full history before relying on it for DSR/trend baselines.

## Watermark columns (confirmed against legacy-schema.md §5)
Transaction tables have an identity-bigint PK (best for *new* rows) + `EntryDate`/`UpdateDate` (for *changed* rows). Primary watermark = `UpdateDate`/`EntryDate` for edited-in-place tables (`JewelTrans`, `Inward`, `Spm_MfgOrder`), identity PK for append-only logs (`Journal`, `InwardHistory`). Soft-cancel via `isCancel` bit — re-pull updated rows, do not rely on deletes.
