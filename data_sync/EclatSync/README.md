# Eclat / CaratSense — On-site Sync Agent (operator guide)

This small program runs on **your office PC** (the one where **SJE Plus / APRS
SQL Server** runs). Every 15 minutes it reads new sales / orders / stock / parties
from your live database **read-only** and sends them to the Eclat dashboard in the
cloud. It never changes your data and never opens any door into your PC — it only
pushes data out over HTTPS.

> This mirrors the proven CaratSenseSync agent already running for the Ashish
> Textile client (there it reads from Busy; here it reads from SJE Plus / APRS).

---

## One-time installation (about 10 minutes)

You need: this `EclatSync` folder on the office PC, and the connection details
from the Eclat team (a login email + password for the sync account, and the Eclat
backend web address).

### Step 1 — Install Python
1. Download Python 3.10 or newer from <https://www.python.org/downloads/>.
2. Run the installer. **Important:** tick **"Add Python to PATH"** on the first
   screen, then click Install.

### Step 2 — Install the SQL Server ODBC driver
Download and install **"ODBC Driver 17 for SQL Server"** (free, from Microsoft):
<https://learn.microsoft.com/sql/connect/odbc/download-odbc-driver-for-sql-server>
(If it is already installed on this PC, you can skip this — the test in Step 4
will tell you.)

### Step 3 — Enter your connection details
1. In this folder, make a copy of **`eclat_config.example.bat`** and name the copy
   **`eclat_config.bat`**.
2. Open `eclat_config.bat` in Notepad and fill in:
   - `ECLAT_BASE_URL` — the Eclat backend web address (given by the Eclat team).
   - `ECLAT_EMAIL` / `ECLAT_PASSWORD` — the sync account login (given by the Eclat team).
   - `SJEP_SQL_SERVER` — your SQL Server, e.g. `localhost\SQLEXPRESS`.
   - `SJEP_SQL_DB` — the database name, e.g. `APRSSJEP`.
   - Leave `SJEP_SQL_USER` / `SJEP_SQL_PASS` **blank** to use Windows login, OR
     fill in the **read-only** SQL login the Eclat team set up.
3. Save and close.

> Keep `eclat_config.bat` private — it contains passwords. It is never uploaded
> or committed anywhere.

### Step 4 — Run the installer
1. **Right-click `setup.bat` → "Run as administrator".**
2. It installs the components, runs a connection test, and schedules the agent to
   run automatically **every 15 minutes and at each login**.
3. If the test fails, the message tells you what to fix (usually the driver in
   Step 2 or a detail in `eclat_config.bat`). Fix it and run `setup.bat` again.

That's it. The sync now runs in the background automatically.

---

## Day-to-day

- **Nothing to do** — it runs on its own every 15 minutes.
- **Run it once right now:** double-click **`run_sync.bat`**.
- **Check it's working:** open **`auto_sync.log`** in this folder. Each run writes a
  timestamped entry; "Sync complete" means success.
- **See the schedule:** open Windows **Task Scheduler** and look for **`EclatSync`**.

## Stop / remove the agent
Open Command Prompt as administrator and run:
```
schtasks /Delete /TN "EclatSync" /F
schtasks /Delete /TN "EclatSync_Logon" /F
```

---

## Catalogue photos

Your jewellery photographs can come across too, so the catalogue shows the real
piece instead of a grey box.

1. Run **`discover.bat`** first (see below) — it finds the folder your photos are
   kept in and prints the exact line to paste into `eclat_config.bat`.
2. Add your **Cloudinary** details to `eclat_config.bat` (cloud name, API key,
   API secret — from your Cloudinary dashboard under Settings → API Keys).
3. Try a small batch: **`sync_media.bat 25`**. Check those 25 appear.
4. Then run **`sync_media.bat`** for the rest.

The first full run can take a few hours if you have thousands of photos. That is
normal. You can stop it and start it again — it carries on from where it stopped
and never re-uploads the same photo twice. Photos go straight from this PC to
Cloudinary.

---

## Before the first sync: `discover.bat`

Run this once, before `setup.bat`. It **only reads** — it changes nothing and
uploads nothing. It writes `discovery_report.txt`, which tells the Eclat team:

- how much data is in your system,
- which production-stage codes and departments you use (so orders show the right
  manufacturing stage rather than a guessed one),
- where your photographs are kept.

Send that file to the Eclat team.

---

## Files in this folder
| File | What it is |
|------|------------|
| `discover.bat` | **Run first.** Read-only survey of your system. |
| `discover.py` | The survey program. |
| `sync_sjep.py` | The sync program (sales, stock, orders, manufacturing, payments). |
| `sync_media.bat` / `sync_media.py` | Uploads catalogue photographs. |
| `setup.bat` | One-time installer (run as administrator). |
| `run_sync.bat` | Runs one sync cycle (used by the schedule; also manual). |
| `eclat_config.example.bat` | Template for your connection details. |
| `eclat_config.bat` | **Your** filled-in details (you create this; keep private). |
| `stage_map.json` | Which of your production codes means which stage. |
| `requirements.txt` | The Python components the installer adds. |
| `auto_sync.log` / `media_sync.log` | Log of each run (created automatically). |
| `sync_state.json` | Remembers the last synced record so it never re-sends (auto). |
| `uploaded_media.json` | Remembers which photos are already uploaded (auto). |
| `ONSITE-RUNBOOK.md` | For the Eclat engineer, not for day-to-day use. |

## Safety notes (for the Eclat / IT team)
- The agent connects with **`ApplicationIntent=ReadOnly`** and `readonly=True`; use a
  **least-privilege read-only SQL login** (don't use `sa`).
- It is **outbound-only** (HTTPS to the Eclat backend) — no inbound firewall changes.
- The watermark only advances after **every** upload chunk returns HTTP 200, so a
  failed run safely retries everything next cycle (no lost or duplicated rows).
- The data-extraction SQL is still `TODO(schema)` pending `docs/legacy-schema.md`
  (real APRS table/column names). Scheduling, auth, watermark and upload are final.
