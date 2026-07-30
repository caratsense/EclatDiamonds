# On-site runbook — bringing the client's data into Eclat

For the **Eclat engineer** driving the client's PC over AnyDesk.
The operator-facing instructions are in `README.md`; this is the order of
operations and what to do when something is not as expected.

Everything here is **read-only** against SQL Server. Nothing writes to, alters,
or locks the client's live database.

---

## What you are bringing across

| Their system | Becomes in Eclat |
|---|---|
| `PartyMst` | Customers, suppliers, salespeople, branches |
| `StyleMst` | Catalogue products (the design master) |
| `Inward` | Stock — every physical piece |
| `JewelTrans` (+ lines) | Sales / invoices |
| `Spm_MfgOrder` (+ items) | Manufacturing orders — *what is on order* |
| `SPM_BagMaster` + `SPM_DepartmentMst` | **The manufacturing timeline — where each piece has got to** |
| `Journal` | Payments / ledger |
| `ImageName` files on disk | Catalogue photographs (via Cloudinary) |

Two things are **specific to each install** and must be read off their machine
rather than assumed:

1. **`Spm_MfgOrder.OrderStatus` is an int** whose meaning nobody has written down,
   and the shop-floor **department ids** likewise. Guess them and every order
   displays a confident, wrong manufacturing stage — worse than showing none.
2. **The photo folder.** The database stores only file *names*.

`discover.py` exists to answer both. That is why it runs first.

---

## Order of operations

### Step 0 — before you connect
Have ready:
- The Eclat **sync account** (a `head_office` login) — email + password.
- The **Cloudinary** cloud name, API key, API secret.
- The backend URL (`https://backend-production-89dd.up.railway.app`).

Copy the whole `EclatSync` folder onto the client's PC (Desktop is fine).

### Step 1 — Python + config
1. Install Python 3.10+ if absent — **tick "Add Python to PATH"**.
2. Copy `eclat_config.example.bat` → `eclat_config.bat`.
3. Fill in the Eclat and SQL Server sections. Leave `SJEP_IMAGE_ROOT` and the
   Cloudinary keys blank for now.

For SQL Server, prefer a **read-only login** (`create_readonly_login.sql` creates
one). Windows auth works too — leave `SJEP_SQL_USER` blank.

### Step 2 — DISCOVERY (always first)
```
discover.bat
```
Produces `discovery_report.txt` and `stage_map.suggested.json`. Read the report
with the client on the call:

- **Row counts** — sanity-check against what they believe they have. A count of 0
  for `Spm_MfgOrder` means they don't use manufacturing orders and there is no
  timeline to bring across; say so rather than shipping an empty screen.
- **`OrderStatus` codes** — ask directly: *"when an order is status 3, where is it?"*
  Write their answer into `stage_map.suggested.json`.
- **Departments** — the guessed stages are marked `"guess": true`. Confirm each.
  A shop's "Finishing" might mean polishing or final QC; only they know.
- **Photo folder** — if found, the report prints the exact `set SJEP_IMAGE_ROOT=…`
  line. If not, ask *"where are the jewellery photos kept?"* and set it by hand.

When the stages are agreed, save the file as **`stage_map.json`**. Anything left
`null` still records the movement — it just doesn't advance the order, which is
the safe direction to be wrong in.

### Step 3 — data sync
```
setup.bat        (right-click -> Run as administrator)
```
Installs dependencies, runs a connectivity test, registers the schedule (every
15 min + at boot, as SYSTEM), and runs the first sync.

Watch `auto_sync.log`. The extract line should show non-zero counts:
```
extracted: parties=564 items=753 stock=2690 sales=239(...) orders=121(...) bags=... payments=475
```

### Step 4 — photos
Fill in `SJEP_IMAGE_ROOT` and the Cloudinary keys in `eclat_config.bat`, then
**start small**:
```
sync_media.bat 25
```
Check 25 photos appear in Cloudinary and on the Eclat catalogue. Then run the
whole set:
```
sync_media.bat
```
The first full run can take hours on a large catalogue — that is expected. It is
resumable: stop it, run it again, it picks up where it stopped. Photos upload
straight from this PC to Cloudinary and never pass through the Eclat backend.

### Step 5 — verify in the product
Sign in to Eclat as head office and confirm:
- **Catalogue** shows real photographs.
- **Inventory** piece counts are in the right order of magnitude.
- **Timelines** shows orders at sensible stages — not everything at "booked".
- **Payments / Reporting** show non-zero figures.

---

## Scheduling the photo sync (optional)

`setup.bat` schedules the data sync only. Photos change far less often, so run
them nightly rather than every 15 minutes:

```
schtasks /Create /TN "EclatMediaSync" /TR "\"C:\path\to\EclatSync\sync_media.bat\"" ^
  /SC DAILY /ST 02:00 /RU SYSTEM /RL HIGHEST /F
```

---

## When it doesn't go to plan

**"No SQL Server ODBC driver installed"**
Install *ODBC Driver 17 for SQL Server*, then re-run.

**Discovery connects but every count is 0**
You're on the wrong database. Check `SJEP_SQL_DB` — some installs use `APRS`
or `SJEPlus` rather than `APRSSJEP`. `discover.bat` prints which one it opened.

**Photo folder not found**
The search is deliberately bounded — it will not find a network share or an
unusual custom path, because walking every drive can take many minutes while
someone waits on the call. Ask the shop and set `SJEP_IMAGE_ROOT` by hand.

**"N photos are named in the database but not on disk"**
Normal in some measure — old rows often reference photos that were never taken
or were cleaned up. If the number is large, there is probably a second photo
folder; ask.

**Orders all sit at "booked"**
Either `stage_map.json` is missing (the log says so explicitly) or every code in
it is still `null`. Go back to the discovery report and get the decode confirmed.

**Uploads fail with 401**
The sync account is not `head_office`. Every `/sync/*` route is restricted to
that role so store staff cannot bulk-write.

**A sync run failed halfway**
Nothing to do. The watermark only advances when *every* chunk succeeds, so the
next run re-sends the same rows. Upserts are keyed on `legacyId`, so re-sending
refreshes rather than duplicating.

---

## What this never does

- No writes to SQL Server. The connection is opened `readonly=True` with
  `ApplicationIntent=ReadOnly`.
- No inbound network access to the client's PC — outbound HTTPS only.
- No deletions in Eclat. Legacy cancellations are soft (`isCancel`), so rows are
  re-pulled and updated, never removed.
