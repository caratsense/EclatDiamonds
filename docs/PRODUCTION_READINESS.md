# Eclat — Production Readiness

_Compiled 2026-08-13. Local only — nothing committed, pushed, or deployed._
Status vocabulary: **DONE** (built + verified locally) · **VERIFIED** (audited, correct) ·
**BLOCKED** · **CLIENT INPUT REQUIRED** · **ON-SITE REQUIRED** (needs the live Gati
machine) · **NOT STARTED**.

## 1. Executive status
The Eclat application is **feature-complete and internally consistent** for
go-live: multi-store isolation, inventory + stock-transfer + source-of-truth,
DSR, discounts/void, and the sync *contract* are all built and tested (195
backend tests pass; both TypeScripts clean). What remains is **not application
code** — it is live-Gati execution and a small set of client-supplied facts
(karat source, payments table, photo folder, branch/stage codes, AI embedding
provider). Every such gap is isolated below with the exact input required.

## 2. Multi-store — **VERIFIED / DONE**
No cross-store leak (2026-08-13 isolation audit): scope is DB-derived per request
(`JwtAuthGuard → resolveScope`), and every module re-validates request `storeId`
via `assertStoreAllowed`/`storeFilter`/`effectiveStoreIds`. HO all-stores access
is intentional and gated to that role. Contract documented in
[MULTI_STORE.md](MULTI_STORE.md). Regression: `dashboard-handoff.e2e` (4).

## 3. Surat / default-store — **DONE**
No hardcoded "main store" remains on any production path. Fixed: sync
`SYNC_DEFAULT_STORE_ID` no longer falls back to `surat-main` (unset = config
error); `createHandoff` no longer defaults to the user's first store (multi-store
users must specify); the dashboard task picker no longer defaults to a branch on
"All Stores". Legitimate placeholders/marketing/seed/timezone references left
intact. Dev `.env` (gitignored) sets the default explicitly.

## 4. Gati architecture — **VERIFIED (one DB); topology B CLIENT INPUT REQUIRED**
ONE Gati SQL Server / one `APRSSJEP` DB, multi-store by per-row branch id
(`EclatBranchId → BranchNo → LocationId`). Per-store-DB (topology B) is **not
supported today**; smallest extension identified (loop over `(db, storeLegacyId)`,
stamp `EclatBranchId`, per-DB watermark). **CLIENT INPUT REQUIRED:** confirm
one-DB vs per-store-DB.

## 5. Gati data contract — **DONE (documented); mappings VERIFIED**
Full per-entity mapping in [GATI_DATA_CONTRACT.md](GATI_DATA_CONTRACT.md) (Gati
table/field → Eclat field, identity key, store attribution, watermark,
transformation, nullable, failure). Every entity keys on `legacyId`, upserts
idempotently, skips null-identity rows.

## 6. Payments — **BLOCKED / CLIENT INPUT REQUIRED**
Only `Journal` (day-book) is wired → `LedgerEntry`. Real customer receipts with
payment MODE (`VoucherEntry`) are **not extracted**; Module 12 has no Gati source.
Not guessed. **CLIENT INPUT REQUIRED:** confirm `VoucherEntry` is the receipts/
mode source + its key columns (voucher id, mode, amount, date, party, sale ref);
then a `VoucherEntry` extractor + `POST /sync/payments` route is built.

## 7. Karat / purity — **DONE (honest) + CLIENT INPUT REQUIRED (real source)**
The sync **no longer asserts 22K**. Plain gold → `gold_unspecified` with null
karat (physical `StockItem`); rose tone → 18K. New enum value + additive
migration applied to preview; `karat-mapping.e2e` (4) verifies "never 22K".
**CLIENT INPUT REQUIRED:** the authoritative per-piece purity source (RateChart /
caratage table / Purity column). Until then, Gati gold reads as unspecified.

## 8. Photos — **VERIFIED (Gati-only); live retrieval ON-SITE / CLIENT INPUT REQUIRED**
Piece/catalogue photos come from Gati: agent reads `ImageName` → finds file under
`SJEP_IMAGE_ROOT` → uploads bytes to R2 → POSTs URL → `imageUrl`. No website
upload writes `StockItem.imageUrl` (that path was removed). **CLIENT INPUT /
ON-SITE:** photo folder path, network read access, customer-safe subfolder
selection, R2 credentials.

## 9. Manufacturing — **VERIFIED (mapping); stage codes CLIENT INPUT REQUIRED**
`Spm_MfgOrder`/`SPM_MfgOrderItem`/`SPM_BagMaster` mapped; bag movement advances
the order to its furthest stage (never backward; cancelled terminal; unmapped
department reported, never guessed). Template added:
`synceclatcaratsense/stage_map.example.json` (placeholder codes only).
**CLIENT INPUT REQUIRED:** real `OrderStatus`/`DepartmentId` codes (from
`discover.bat` → confirm → save as `stage_map.json`). Without it, orders stay
`booked`.

## 10. CustomOrder linkage — **BLOCKED / CLIENT PROCESS INPUT REQUIRED** (OP-25)
No deterministic key ties an Eclat `CustomOrder` to a Gati order/bag; must not be
inferred from name/description/amount/date. **CLIENT INPUT REQUIRED:** a Gati
field carrying the CO reference, a bag-barcode↔CO link entered in Eclat, or a
mapping table.

## 11. AI catalogue — **DONE (real architecture) + BLOCKED (provider + pgvector)**
Rebuilt from keyword-matching to **real cosine visual-similarity**: provider-
agnostic embedding abstraction (`image-embedding.service.ts`), store-scoped vector
search with threshold/ranking, HO-only reindex endpoint, and honest degradation
(`available`/`visualMatch` flags — never fabricated results; every result a real
catalogue Product). `ai-image-search.e2e` (16) all credential-free. **BLOCKED:**
(a) an image-embedding provider + key (Anthropic doesn't emit image embeddings);
(b) pgvector — not installed here, so a ready-but-**unapplied** migration sits at
`backend/prisma/manual/20260813_pgvector_image_search.sql`. Live inference
**not tested** (no provider). See OP-28.

## 12. Discovery — **DONE (tooling ready); ON-SITE REQUIRED (run)**
`discover.py` now emits the exact **`Store | Entity | Count | Missing Store |
Unknown Mapping`** matrix (read-only) for stores/products/stock/customers/sales/
payments/orders/manufacturing/photos — products/photos as a `GLOBAL` row, payments
flagged `SOURCE UNCONFIRMED`. Offline self-check passes. **ON-SITE REQUIRED:** run
`discover.bat` against the live DB (cannot connect here).

## 13. Controlled sync — **DONE (tooling ready); ON-SITE REQUIRED (run)**
`sync_sjep.py` gained `--sample` / `--store <branchLegacyId>` / `--entity` /
`--limit` — one store, one entity, limited rows, filtering the existing flow (no
parallel path). Safety: controlled runs join the `partial` guard so the real
watermark is **never advanced**; idempotent legacy-id upsert; per-batch
attributed/fell-back/unknown + upserted/skipped reporting. **ON-SITE REQUIRED:**
execute against the live DB.

## 14. Reconciliation — **NOT STARTED (ON-SITE REQUIRED)**
The discovery matrix (§12) is the pre-sync input side; the post-sync
`Entity | Gati | Eclat | Missing | Duplicate | Failed | Unmapped` and per-store
`Store | Entity | Gati | Eclat | Difference` reports require an actual controlled
sync against live Gati + the Eclat DB to diff. Cannot be produced here.

## 15. Sync source of truth — **VERIFIED / DONE**
Gati owns legacy metadata; Eclat owns `storeId`/`status` once a piece is
`ho_approved`/`dispatched`/`received`/`acknowledged`. Preserved and green:
`stock-transfer` (22), `stock-transfer-sync` (5), `stock-adjust-entry` (11).

## 16. Sync-agent delivery — **DONE (structure) + secret leak fixed**
Canonical agent = `synceclatcaratsense/` (`HANDOVER/EclatSync/` is an older
duplicate; not touched). Added a corrected `.gitignore` (excludes real config,
state, media ledger, `stage_map.json`, reports, logs, venv, pycache — verified via
`git check-ignore`), extended `README.md` (discovery→sample→full), and
`eclat_config.example.bat` (placeholders). **Fixed a real leak:** the *tracked*
`eclat_config.example.bat` was exposing the real R2 account id, bucket URL, and
service email — all blanked. The real `eclat_config.bat` is gitignored and
untouched. **Action for you:** this folder is currently untracked in git — decide
whether to add it to version control (safe now that its `.gitignore` protects
secrets) so the agent isn't machine-bound.

## 17. Security — **VERIFIED (targeted)**
Store isolation (no leak), sync auth (`/sync/*` head-office-only), idempotent
legacy-id upserts, stock-movement/transfer-reservation integrity (transfer-locked
pieces can't be hand-adjusted or bulk-adjusted), immutable payments + soft-void
sales, discount approval caps, AI results authorization (store-scoped, real
catalogue only), bulk-import all-or-nothing with row errors, file parsing (multer
size limits; image-only). No new findings requiring a fix beyond those already
applied. Not-covered (flagged): a dedicated SQL-injection pass of the sync
extractor's raw SQL (ingestion path, separate concern).

## 18. Tests — actual numbers
- Backend `tsc`: **0 errors**. Frontend `tsc`: **0 errors**. Frontend lint/build: green (prior run).
- Backend full suite: **195 passed / 2 failed / 6 skipped (203 total)**.
- New/updated this phase: `karat-mapping` (4), `dashboard-handoff` (4), `ai-image-search` (16); prior `stock-transfer` (22), `stock-transfer-sync` (5), `stock-adjust-entry` (11), `reporting-dsr` (7) all green.
- **The 2 failures** are `integrations` › "reports every integration not-live when no credentials" and "gold-rate refresh is manager+ only". **Classification: environment-only, pre-existing.** Evidence: the keyless auto gold-rate feed is active in the preview env (so integrations don't read as "not live"); no code under `integrations/` was touched this session, and both have failed since the first run this session. **Not introduced, not blocking.**

## 19. Genuine blockers
| # | Blocker | Type |
|---|---|---|
| 1 | Per-piece **karat** source | CLIENT INPUT |
| 2 | **Payments** — `VoucherEntry` confirmation + columns | CLIENT INPUT |
| 3 | Gati **topology** (one DB vs per-store) | CLIENT INPUT |
| 4 | **Photo** folder + network access + R2 creds | CLIENT INPUT / ON-SITE |
| 5 | **Branch** column per table + BookMaster-per-branch | CLIENT / ON-SITE (`discover.bat`) |
| 6 | **stage_map** real codes | CLIENT INPUT |
| 7 | **CustomOrder ↔ Gati** linkage | CLIENT PROCESS |
| 8 | AI **embedding provider + key** | CREDENTIAL |
| 9 | **pgvector** installed on prod Postgres | INFRA |
| 10 | **ANTHROPIC_API_KEY** (metadata enrichment) | CREDENTIAL |
| 11 | Live sync / reconciliation | ON-SITE |

## 20. Exact client inputs required
1. Gati topology: one DB for all stores, or one DB per store?
2. Per-piece purity: which table/column carries karat (RateChart / caratage / Purity)?
3. Payments: is `VoucherEntry` the receipts table? Provide voucher-id, mode, amount, date, party, sale-reference columns.
4. Photos: `SJEP_IMAGE_ROOT` path, read access, customer-safe subfolders, R2 credentials.
5. Manufacturing: real `OrderStatus` + `DepartmentId` codes → Eclat stage (via `discover.bat`).
6. CustomOrder linkage mechanism (field / barcode / table).
7. AI: an image-embedding provider endpoint + key (and confirm pgvector can be installed on the prod Postgres).
8. `ANTHROPIC_API_KEY` (optional metadata enrichment).
9. `SPM_Users` — if staff designation import is wanted.

## 21. Exact on-site steps
1. Install the agent on the Gati machine; copy `eclat_config.example.bat` → `eclat_config.bat`, fill real values (SQL server/db, `ECLAT_BASE_URL`, `SYNC_DEFAULT_STORE_ID` = the store that owns unattributed rows, `SJEP_IMAGE_ROOT`, R2 creds).
2. Run `discover.bat` → review `reports/discovery_report.txt` (incl. the per-store×entity matrix) and `reports/stage_map.suggested.json`.
3. Confirm branch columns, BookMaster-per-branch, and the `OrderStatus`/`DepartmentId` codes; save the confirmed map as `stage_map.json`.
4. Set `SYNC_BRANCH_COLUMNS` if discover shows a different authoritative branch column.
5. Controlled trial: `sync_sjep.py --sample --store <branchLegacyId> --entity stock` (then customers/sales/orders) — verify attribution, identity, relationships, images; watermark stays put.
6. Provision the karat source, `VoucherEntry` extractor, photo folder, AI embedding provider + pgvector as each client input arrives.
7. Full sync per entity (dependency order: parties → products → stock → sales → sale-lines → orders → order-items → bags → ledger → media).
8. Produce the reconciliation reports (§14) and sign off per store.

---
_Git safety: commits 0 · pushes 0 · Railway deploys 0 · Vercel deploys 0. Migrations applied only to `eclat_preview`; the pgvector migration is unapplied._
