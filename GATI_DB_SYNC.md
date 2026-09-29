# Gati DB → CaratOS sync

How Gati's data (styles, stock, sales, orders, bags, ledger, parties, daily
metal rates and style photos) reaches CaratOS: what runs, where it runs, and how
to check, change or repair it.

**This is the source of truth for the sync as installed on 2026-09-29.** Older
documents describe earlier setups (`D:\EclatSync`, head-office email/password
on the server, a SYSTEM task, `data_sync/EclatSync`). They are history. Where
they disagree with this file, this file is right.

Field-by-field mapping per entity: [docs/GATI_DATA_CONTRACT.md](docs/GATI_DATA_CONTRACT.md).

---

## 1. The picture

```
Eclat Head Office LAN
┌────────────────────────────────────────────────────────────────────────┐
│ APPSERVER  192.168.1.254  (Windows Server 2025; tailnet 100.73.117.110) │
│                                                                        │
│  Gati SJE Plus (Windows ERP) ──writes──▶ SQL Server 2022 Express       │
│  (staff type orders, stock,               DB APRSSJEP                  │
│   sales, daily rate …)                        ▲                        │
│                                               │ SELECT only            │
│                                               │ Windows login          │
│                                               │ APPSERVER\svc_caratos  │
│  Task Scheduler: "CaratOS Gati Sync"          │ (db_datareader, writes │
│   every 15 min, as svc_caratos, ──▶ C:\CaratOS\GatiConnect\run_sync.bat │
│   logged on or not                   1. sync_sjep.py   (data + rates)  │
│                                      2. sync_media.py  (style photos)  │
│  D:\GATISOFTTECH\SJEP IMAGES ─────────────┘ reads photo files          │
└──────────────────────────────────────┬─────────────────────────────────┘
                                       │ outbound HTTPS only
                     ┌─────────────────┴───────────────────┐
                     ▼                                     ▼
   Railway: backend-production-89dd.up.railway.app   Cloudflare R2 (photos)
   NestJS /sync/*  →  Railway Postgres               public URLs linked via
                                                     POST /sync/product-images
                     │
                     ▼
   Vercel: eclat-diamonds-pi.vercel.app  (catalogue, stock, sales, top-bar rate)
```

Nothing writes back to Gati. The sync reads SQL Server with a login that is
denied INSERT/UPDATE/DELETE/EXECUTE/ALTER, and it only ever pushes outward.

---

## 2. What is where

| Thing | Value |
|---|---|
| Server | `APPSERVER`, LAN `192.168.1.254`, our tailnet `100.73.117.110` (SSH key `~/.ssh/sjep-eclat`, user `Administrator`) |
| Source DB | SQL Server 2022 Express, `localhost`, database `APRSSJEP` |
| Install folder | `C:\CaratOS\GatiConnect` (the repo's `synceclatcaratsense/` package) |
| Folder access | only `APPSERVER\svc_caratos`, `SYSTEM`, `BUILTIN\Administrators`; inheritance off. The package refuses to run otherwise. |
| Python | `C:\Program Files\Python314` (3.14.6) is the base; the package runs from its own `.venv` inside the install folder |
| Windows account | `svc_caratos`, local, **not** an administrator, member of Users, has "Log on as a batch job". Its password is random and was never written down; re-registering the task sets a new one. |
| SQL access | Windows login `APPSERVER\svc_caratos` → user in `APRSSJEP`, `db_datareader`, explicit DENY INSERT/UPDATE/DELETE/EXECUTE/ALTER. No SQL password exists anywhere. |
| Scheduled task | `\CaratOS Gati Sync`, every 15 min from 00:05, runs as `svc_caratos` with a stored password, RunLevel Limited, IgnoreNew (no overlapping runs), 4 h limit |
| Task command | `cmd.exe /d /c C:\CaratOS\GatiConnect\run_sync.bat >> C:\CaratOS\GatiConnect\logs\task_output.log 2>&1` |
| Config | `C:\CaratOS\GatiConnect\eclat_config.bat` (secrets: agent token, R2 keys). Never commit it or copy it off the server. |
| Logs | `logs\task_output.log` (everything the task prints), `logs\auto_sync.log` (data sync), `logs\media_sync.log` (photos) |
| Checkpoints | `sync_state.json` in the install folder: one watermark per source, per backend and config revision. `mirror_<backend>.sqlite`: per-table fingerprint and per-row hash of what the mirror has sent (§4a). |
| Backend | `https://backend-production-89dd.up.railway.app` (Railway project "Eclat Diamonds", service `backend`, branch `main`) |
| CaratOS agent | `ConnectAgent` `cmu4080tk00uznv01ybh7q7te` "ECLAT  AGENT", source `gati`, whole organisation |
| Archive of the old setup | `C:\Users\Administrator\CaratOS-archive\` (zips of `D:\EclatSync` and `D:\Tally\EclatSync`, their task XML). Contains the old head-office password; delete once no longer needed. |

### eclat_config.bat keys

| Key | Value / meaning |
|---|---|
| `ECLAT_BASE_URL`, `CARATOS_APPROVED_BACKEND_ORIGIN` | both the production backend URL; the agent refuses to run if they differ |
| `CARATOS_AGENT_TOKEN` | `cxa_…` machine token of the agent above (only its SHA-256 is stored server-side) |
| `SJEP_SQL_SERVER` / `SJEP_SQL_DB` | `localhost` / `APRSSJEP`. **Do not change**: the approved `sourceInstanceHash` is computed from exactly these strings. |
| `SJEP_SQL_USER` / `SJEP_SQL_PASS` | blank = Windows login of the task account |
| `SJEP_SKIP_MIRROR` | blank = the every-table mirror (§4a) runs each cycle. `1` switches it off. |
| `SJEP_MIRROR_BUDGET_SEC` | optional; seconds the mirror may spend per cycle (default 480). The rest resumes next cycle. |
| `SJEP_SKIP_STAFF` | blank: Gati staff (PartyMst `IsSalesMan=1`) are imported as inactive users, by the owner's choice |
| `SJEP_IMAGE_ROOT` | `D:\GATISOFTTECH\SJEP IMAGES` |
| `SJEP_IMAGE_ONLY_FOLDERS` | `ALR,AER,APD,ABR,AGR,ANK` (customer-facing photo folders only) |
| `R2_*` | Cloudflare R2 bucket for catalogue photos |

---

## 3. One cycle, step by step

`run_sync.bat` (every 15 minutes):

1. **Refuses unsafe runs**: `verify_install_security.ps1` stops it if the process
   is elevated, runs as SYSTEM/service, the folder is on a share/junction, or any
   file or `.venv` path is owned by or granted to anyone but the three allowed
   identities (exit 20). `gati_target_safety.py` checks the backend URL equals
   the approved origin and is HTTPS.
2. **`sync_sjep.py`** — data:
   1. `GET /integration/connect/me` with the token and three headers:
      `x-caratos-profile-hash` (SHA-256 of the contract + code of `sync_sjep.py`,
      `sync_media.py`, `import_website.py` + `stage_map.json`),
      `x-caratos-source-instance-hash` (driver + server + database) and
      `x-caratos-config-revision`. The backend compares them with the agent's
      **approved config** and answers 403 on any mismatch.
   2. Heartbeats (`/integration/connect/heartbeat`) as it goes: this is what the
      "Last check-in" on `/data` shows.
   3. **Stores** (full pull every run): a branch is any `PartyMst` id referenced
      as a `BranchNo` by the data (10 today). The `IsLocation` flag is not used —
      on this database it marks suppliers and a test row.
   4. **Staff** (full pull): `PartyMst IsSalesMan=1` → inactive users.
   5. **Rates** (full pull): see §5.
   6. **Mapped entities**, incremental per source:

      | Gati table | Route | CaratOS model |
      |---|---|---|
      | `PartyMst` | `/sync/parties` | `Party` |
      | `StyleMst` + `StyleMstSummary` + `ToneMst` | `/sync/products` | `Product` (the style catalogue) |
      | `Inward` + summary | `/sync/stock` | `StockItem` |
      | `JewelTrans` | `/sync/sales` | `Sale` (TranType decides sale / purchase / branch transfer / return) |
      | `JewelTransInward` | `/sync/sale-lines` | `SaleLine` |
      | `Spm_MfgOrder` | `/sync/orders` | `ManufacturingOrder` |
      | `SPM_MfgOrderItem` | `/sync/order-items` | order items |
      | `SPM_BagMaster` | `/sync/bags` | `ProductionBag` |
      | `Journal` | `/sync/ledger` | `LedgerEntry` |
      | `InwardHistory` | `/sync/stock-movements` | `StockMovement` |

      A row is picked up when `COALESCE(UpdateDate, EntryDate)` is at or after the
      source's watermark and not after the `GETDATE()` taken at the start of the
      run (append-only tables go by identity id). Rows go up in chunks of 3,000.
   7. **Zero-skip acknowledgement**: a chunk counts only if the backend answers
      with the same entity, `received` = rows sent, `upserted` = rows sent,
      `skipped` = 0 and a watermark. Otherwise nothing for that source is
      checkpointed and the same rows are re-sent next cycle.
   8. Watermarks are saved (`acknowledged mapped checkpoints saved`), and the
      log ends with `Sync complete` (or `Sync incomplete`, exit 1).
3. **Mirror of every table** (§4a): only new and changed rows, within a time
   budget.
4. **`sync_media.py`** — photos (only if step 2 succeeded): reads `ImageName`
   for styles and pieces, finds the file under `SJEP_IMAGE_ROOT` (allowed
   folders only), uploads new files to R2, then `POST /sync/product-images`
   with the public URL. It remembers what is uploaded and linked, so a quiet
   cycle uploads nothing.

**Branch attribution.** Stock uses the row's `BranchNo`. Sales, orders and
ledger rows have no branch column; the agent maps their `BookNo` →
`BookMaster.BranchNo` (333 books today). A row that names no branch goes to the
store **"Unassigned — needs a branch"** — never to a guessed shop
(`unattributedMode: holding` in the agent's config). On 2026-09-29: sales 603
attributed / 277 unassigned, orders 22 / 237, ledger 1,410 / 452.

**The backend upserts on `(organisationId, legacyId)`**, where `legacyId` is
Gati's own primary key (`StyleId`, `JewelId`, …). Re-sending is always safe.
Nothing is ever deleted by the sync (see §8).

---

## 4. The style catalogue

`/sync/products` writes one `Product` per `StyleMst` row (`legacyId = StyleId`,
company-wide, `gatiSyncedAt` = time of sync). The catalogue page lists
`GET /products`: designs with a photo first, then newest first. A new style
keyed in Gati appears within one cycle; its photo follows in the same cycle when
the file is in an allowed image folder. On 2026-09-29 Gati had **1,042 styles**
and all 1,042 were synced.

---

## 4a. Every Gati table: the mirror (`LegacyRow`)

So that any Gati data can be used in CaratOS **without changing the agent**,
every table of `APRSSJEP` (about 1,136, of which ~260 hold rows) is copied into
the CaratOS table **`LegacyRow`**, one row per source row:

| Column | Holds |
|---|---|
| `sourceTable` | the Gati table name, e.g. `RateDailyMst_Log`, `SPM_BagTransaction` |
| `rowKey` | the row's primary-key values joined with `\|` (an MD5 of the row when the table has no primary key) |
| `data` | the whole source row as **jsonb**, every column, Gati's own column names |
| `legacyUpdatedAt` | the row's `UpdateDate`, else `EntryDate`, when it has one |
| `syncedAt` | when CaratOS last received it |

How only new and changed rows are sent (`mirror_changed` in `sync_sjep.py`):

1. Per table, a cheap fingerprint: `COUNT_BIG(*)` and
   `CHECKSUM_AGG(BINARY_CHECKSUM(*))`. Unchanged since last cycle → skipped.
2. A changed table is read, each row hashed (MD5 of its JSON), and only rows
   whose hash differs from what the backend already acknowledged are sent.
3. Once every 24 h every table is re-hashed anyway (`BINARY_CHECKSUM` ignores
   `text`/`ntext`/`image`/`xml` columns, so an edit only there is caught by the
   daily pass).
4. Rows go up 500 at a time (max ~2 MB) to `POST /sync/raw`, which stores a batch
   with one `INSERT … ON CONFLICT` statement. The pass stops after
   `SJEP_MIRROR_BUDGET_SEC` (480 s) and resumes next cycle — the first pass over
   the whole database (~350k rows) spreads over a few cycles instead of flooding
   Railway, which is what the old full mirror did in July.
5. What was acknowledged is kept in `mirror_<backend>.sqlite`; a chunk that fails
   is re-sent next cycle.

Using it later — no agent change needed, only backend code or SQL:

```sql
-- today's rate history as Gati keeps it
SELECT data->>'RateDailyMst_LogId' AS log_id, data->>'RawNo' AS raw, data->>'SaleRate' AS rate
FROM "LegacyRow" WHERE "organisationId" = 'org_eclat' AND "sourceTable" = 'RateDailyMst_Log';

-- every bag movement (a table the mapped sync does not model)
SELECT data FROM "LegacyRow" WHERE "sourceTable" = 'SPM_BagTransaction'
ORDER BY "legacyUpdatedAt" DESC LIMIT 50;
```

The mapped entities (§3) remain the typed, business-ready models; `LegacyRow` is
the complete raw copy to build new features from. Changing how a mapped entity is
modelled is a backend change that can read `LegacyRow` — it never needs the agent.

## 5. Metal rates (the top-bar gold rate)

Gati staff key the day's rate every morning in **Masters → Daily Rate**.
It lives in:

| Table | Holds |
|---|---|
| `RateDailyMst` | the **current** rate per raw material: `RawNo`, `SaleRate`, `CostRate` (INR per gram) |
| `RateDailyMst_LogMain` | one row per rate day: `RateDate`, `EntryBy`, `EntryDate`, `UpdateDate` (history since 2026-03-30) |
| `RateDailyMst_Log` | the rates of each day |
| `RawMst` | `RawNo` → `RawName`: 8 `GOLD`, 11 `SILVER`, 18 `OLD GOLD` |

Each cycle `push_rates` sends the current `GOLD` and `SILVER` sale rates (with
the latest rate day) to **`POST /sync/rates`**. Cost rate is never sent.
`OLD GOLD` is the buy-back rate, not a selling price, and is not sent.

The backend (`src/integrations/gati-rates.ts`) turns them into `MetalRate` rows:

| Metal | Rate |
|---|---|
| `gold_24k` | Gati `GOLD` sale rate (fine gold) |
| `gold_22k`, `gold_18k` / `rose_gold_18k`, `gold_14k`, `gold_12k`, `gold_10k`, `gold_9k` | 24K × 0.916, 0.75, 0.585, 0.5, 0.417, 0.375 (the IBJA fineness) |
| `silver` | Gati `SILVER` sale rate |

`legacyId = gati:<rate day>:<metal>:<rate>[:derived]`. An unchanged rate only
has its `effectiveFrom` renewed every cycle; a new rate adds a row and becomes
the live one. The top bar shows 22K; the card shows all of them with
"Source: Gati daily rate · rate of <day>".

**`GOLD_RATE_SOURCE=gati`** (Railway variable on the backend) makes Gati the only
source: the hourly IBJA job and the "Pull from feed" button do nothing, so IBJA
can never overwrite the shop's rate between two agent runs. The rate turns
**stale** (amber dot) when the agent has not confirmed it for 18 h — that means
the sync has stopped, not that the shop skipped a day. Remove the variable to go
back to IBJA.

Example, 2026-09-29: Gati GOLD 14,800 → 24K ₹14,800/g, 22K ₹13,556.80/g;
SILVER ₹222/g.

---

## 6. Security model (why it is built this way)

- **Read-only by construction**: SQL denies every write verb to the login; the
  code only runs SELECTs, with `ApplicationIntent=ReadOnly`.
- **No human password on the server**: the machine token authorises only the
  `/sync/*` ingestion routes of this one agent, and only its SHA-256 is stored.
  (The previous setup kept a head-office email and password in a `.bat` file.)
- **No admin at run time**: the package refuses to run elevated or as SYSTEM.
- **Approved code only**: any edit to `sync_sjep.py`, `sync_media.py`,
  `import_website.py` or `stage_map.json` changes the profile hash, and the
  backend rejects the agent (403) until head office approves the new hash (§7).
- **Private folder**: nobody but the sync account, SYSTEM and Administrators can
  read the token or swap the code.

---

## 7. Operating it

### Is it working?
- CaratOS `/data` → **On-site agents** → "ECLAT  AGENT": *Last check-in* within
  15 min, version `0.3.0`.
- Or on the server: the end of `C:\CaratOS\GatiConnect\logs\task_output.log`
  should be `Sync complete`; `Get-ScheduledTaskInfo 'CaratOS Gati Sync'`
  → `LastTaskResult 0`.
- Or in the database: `ConnectAgent.lastSeenAt` / `lastSyncAt`, and `SyncState`
  per source table.

### Run it now
On the server (as Administrator): `Start-ScheduledTask -TaskName 'CaratOS Gati Sync'`.
Never run `run_sync.bat` from an admin window — it will refuse (elevated).

### Change the agent's code
1. Change and commit it in `synceclatcaratsense/`.
2. Compute the new approval hashes from the committed files:
   `python -c "import gati_machine_auth as g,json;print(json.dumps(g.approval_summary('localhost','APRSSJEP')))"`
3. As head office: `POST /integration/connect/agents/cmu4080tk00uznv01ybh7q7te/config` with
   `{"config":{"enabled":true,"unattributedMode":"holding","expectedProfileHash":"…","expectedSourceInstanceHash":"…"}}`.
   The config is replaced whole, so send every key. There is no UI for this.
4. Copy the changed files into `C:\CaratOS\GatiConnect` (plain copy — they inherit
   the folder's permissions).
5. Trigger a run. A new config revision starts new checkpoints, so this first run
   is a **full backfill** (about 3 minutes for the whole database today).

Files outside the hash (`run_sync.bat`, `require_runtime.bat`, `setup_runtime.ps1`, …)
can be copied without re-approval.

### Rotate the token
`POST /integration/connect/agents/:id/rotate` (head office; or `/data` → the agent
→ rotate). The new token is shown once; put it in `CARATOS_AGENT_TOKEN` in
`eclat_config.bat`. The config revision does not change, so no backfill.

### Re-register the task (e.g. after a password reset)
Register it again with `Register-ScheduledTask` as `APPSERVER\svc_caratos`,
`-RunLevel Limited`, a fresh random password (`Set-LocalUser` first), the action
in §2 and a 15-minute repetition. The package's own `install_scheduler.bat` /
`register_scheduler.ps1` are **not** used here: they only create a task that
runs while `svc_caratos` is signed in, which on an unattended server means never.

### Rebuild the Python runtime
Run `setup_runtime.ps1 -PythonPath "C:\Program Files\Python314\python.exe"` **as
`svc_caratos`** (a one-off scheduled task as that user; it refuses elevation).

### Stop it
`Disable-ScheduledTask -TaskName 'CaratOS Gati Sync'`. To cut it off from the
backend instead, revoke the agent in `/data`.

### If something stops

| Message (task_output.log / auto_sync.log) | Means |
|---|---|
| `[SECURITY STOP] This process is elevated` | run from an admin window; use the task |
| `[SECURITY STOP] … not in a private, safe install folder` | a file or folder gained an extra ACL entry or owner — re-apply §2 folder access |
| `requires an enrolled Gati Connect agent` / 401 | token missing, wrong or rotated |
| `does not match the current approved configuration` | code or `stage_map.json` changed without re-approval (§7) |
| `pinned to a different source descriptor` | `SJEP_SQL_SERVER`/`SJEP_SQL_DB` changed |
| `Login failed for user 'APPSERVER\svc_caratos'` / `Cannot open database` | SQL access lost. **Do not add `DENY CONTROL`**: at database level it also denies CONNECT and SELECT. |
| task result `0x41303`, nothing in the log | "Log on as a batch job" right missing for `svc_caratos` |
| `REJECTED acknowledgement: server skipped N row(s)` | the backend refused rows; they retry every cycle until fixed — read the backend log for the entity |
| `mirror: … deferred to next cycle` | normal while the mirror catches up; not an error |

---

## 8. Known limits

- **Deletions in Gati are not propagated yet.** The sync only inserts and updates; the mirror counts rows deleted in Gati ("N row(s) deleted in Gati (not removed)" in the log) but does not remove them. The removal step (`/sync/reconcile`, and dropping mirror rows) is designed but not built: it deletes production data and is waiting for explicit sign-off.
  On 2026-09-29, 1,058 stock pieces, 84 sales and 10 styles that came from the
  June/August backup imports no longer exist in Gati but are still in CaratOS,
  so CaratOS stock totals are higher than Gati's. They need a decided clean-up
  (delete or mark), not a silent one.
- **`stage_map.json` is absent**, so every production bag and order stays at
  stage "booked". Creating it (from `discover.bat` → `stage_map.suggested.json`)
  changes the profile hash: re-approve (§7).
- **Rows without a branch** land in "Unassigned — needs a branch" (sales without
  a branch book, most manufacturing orders). That is deliberate.
- **Staff duplicates**: a person imported from Gati and the same person's own
  sign-up are two users, by the owner's choice (`SJEP_SKIP_STAFF` blank).
- **Payments (`VoucherEntry`) are not synced**; the ledger (`Journal`) is.
- The old SQL login `eclat_readonly` (from the July setup) still exists on the
  SQL Server and is unused.

---

## 9. History

| Date | What |
|---|---|
| 2026-06 / 07 | First agent in `D:\EclatSync` (and a copy in `D:\Tally\EclatSync`), logging in with a head-office email/password, task as Administrator. Last successful upload **2026-07-31 18:01**. |
| 2026-09-03 → 09-16 | Backend switched `/sync/*` to enrolled-agent tokens only. The old agent kept running and got **403 on every upload** until it was disabled on 09-16. Nothing reached CaratOS for two months. |
| 2026-09-16 | Agent "ECLAT  AGENT" enrolled and its config approved, but never installed. |
| 2026-09-23 / 09-28 | Manual imports of the 8 Jun `.bak` and the 4 Aug CSV export (data up to those dates). |
| **2026-09-29** | Old folders and tasks archived and removed. Gati daily rates added (`/sync/rates`, `GOLD_RATE_SOURCE=gati`). Installed at `C:\CaratOS\GatiConnect` as `svc_caratos`, task every 15 min, photos in the same cycle. Fixed on the way: `setup_runtime.ps1` ($LASTEXITCODE under StrictMode), `require_runtime.bat` (trailing-backslash path), and the SQL `DENY CONTROL` that blocked the read-only login. First run 18:35 IST: full backfill of 909 parties, 1,042 styles, 4,908 stock, 880 sales (6,321 lines), 259 orders (2,842 items), 2,148 bags, 1,862 ledger rows, 14,939 movements and the day's rates, zero rows skipped. |
| 2026-09-29 (evening) | Mirror of every Gati table re-enabled as a change-only mirror (fingerprint + row hash, 500-row chunks, 480 s budget per cycle); `/sync/raw` made a single bulk statement. |
