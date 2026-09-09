# Eclat / CaratSense — connecting your jewellery system to the dashboard

This folder holds a small program that runs on the office computer where your
jewellery software (SJE Plus / APRS) keeps its data.

Every 15 minutes it **reads** your sales, stock, orders and customers and sends
them to your Eclat dashboard.

- It **never changes anything** in your system. The connection it opens is
  read-only, so it physically cannot write.
- It **never opens your computer up** to anyone. It only sends data out, the same
  way your browser sends a form.

---

## Run the steps in order. Do not skip ahead.

The files are numbered for a reason. Each step is safe on its own, and each one
is a chance to catch a problem while it is still cheap to fix.

| | Run this | What happens | Sends anything? |
|---|---|---|---|
| 0 | `setup_runtime.ps1` | Creates the private, version-locked Python runtime | No |
| 1 | `1_discover.bat` | Reads your system, writes a report | **No** |
| 2 | `2_configure.bat` | Asks a few questions, saves your settings | No |
| 3 | `3_test.bat` | Checks both connections work | No |
| 4 | `4_preview.bat` | Shows exactly what *would* be sent | **No** |
| 5 | `5_first_sync.bat` | Sends a **small batch** to check | Yes, a little |
| — | `install_scheduler.bat` | Schedules the reviewed sync for the signed-in user | Yes |

**Steps 1 to 4 change nothing anywhere.** You can run them as often as you like.

The last step is deliberately separate and deliberately last. Once the sync is
automatic it repeats every 15 minutes while the designated Windows user is
signed in — so anything set up wrongly would be re-sent every 15 minutes too. It
refuses to run until it can see that you completed step 1 and watched a sync
finish.

---

## Before you start

**Two things need installing.** Both are free and standard.

1. **Python** — from <https://www.python.org/downloads/>.
   On the first screen of the installer, tick **"Add Python to PATH"** at the
   bottom. This is the single most common cause of trouble. If you miss it,
   uninstall and install again.

2. **ODBC Driver 17 for SQL Server** — search that exact name; it is a Microsoft
   download. Often already installed. Step 3 will tell you if it is missing.

After copying this folder to the private location described below, open a normal
(non-administrator) PowerShell in it and run:

```
powershell -ExecutionPolicy Bypass -File .\setup_runtime.ps1
```

This creates `.venv` inside the package and installs the exact versions in
`requirements-lock.txt`; the numbered scripts refuse to use a global Python or
install packages by themselves. For an offline office PC, IT can provide a
reviewed wheelhouse and pass `-Wheelhouse D:\path\to\wheelhouse`.

**One thing to ask your IT person for.** The file `create_readonly_login.sql` in
this folder creates a database account that can only read, never write. Ask them
to run it and give you the username and password.

> **Prefer the dedicated read-only SQL login.** A blank login uses the exact
> Windows account that owns the scheduled task. It can work, but IT must grant
> that user read-only database access and keep the same user signed in.

**Keep this folder private.** Install it in a local, per-user directory such as
`%LOCALAPPDATA%\CaratOS\GatiConnect`, not a shared Desktop, network share, or
folder readable/writable by other users. It contains a database password and an
agent token. `install_scheduler.bat` checks the owner and ACL of the folder and
runtime files and refuses to schedule if anyone except the exact run-as user,
local Administrators, and SYSTEM has access. It also rejects junctions, symbolic
links, service accounts, and elevated execution.

`setup.bat` is a retired compatibility file. It deliberately performs no
install, schedule, or sync. Use the numbered steps above.

---

## Step by step

### 1. `1_discover.bat` — look at the system

Double-click it. Takes a couple of minutes.

It writes **`reports\discovery_report.txt`**. **Send that file to the Eclat team
and wait**, because it answers three things nobody can guess from outside:

- **Which shop does each record belong to?** If you run several branches, this
  decides whether each branch gets its own figures or everything lands in one
  pile.
- **What do your manufacturing status codes mean?** They are stored as numbers.
  Guessing turns every order into a confident, wrong answer — worse than showing
  nothing.
- **Where are the jewellery photographs kept?** Your database stores only the
  file names, not the pictures.

The report also prints a few real records from each table, so you can see at a
glance whether the data looks like what you expect.

### 2. `2_configure.bat` — enter the details

Answers a handful of questions and writes the settings file for you.

Have ready: the SQL Server name and database name (your IT person knows), the
read-only database login from above, an organisation-wide Gati Connect agent
token, and the storage keys the Eclat team gives you. A human Eclat account is
not used by the sync process.

Leave the photo folder blank — step 1 found it, and the Eclat team will tell you
what to put there.

### 3. `3_test.bat` — check it connects

Confirms it can reach both your database and the dashboard. Nothing is sent.

If it fails, the message says which side failed and what usually causes it.

### 4. `4_preview.bat` — see what would be sent

Reads everything and prints the totals — customers, stock, sales, orders —
**without sending anything**.

**Compare those numbers against what the shop expects.** If the stock count is
wildly off, or sales are empty, stop here and tell the Eclat team. This is the
last free moment to catch a problem.

It also lists anything odd it noticed: pieces with no code, records that name no
branch, duplicate entries.

### 5. `5_first_sync.bat` — send a small batch

Sends **25 of each kind** by default. Then open the dashboard and check:

- Customers — real names, not blanks
- Stock — pieces you recognise
- Sales — amounts that look right
- Branches — data under the correct shop

Happy? Send more:

```
5_first_sync.bat 500
5_first_sync.bat all
```

### 6. `install_scheduler.bat` — make it automatic

**Only after everything above looks right.** Run it normally while signed in as
the Windows user that will own the sync. **Do not use “Run as administrator”.**

The installer re-runs the restricted-agent connection test and a no-upload
preview, asks for the exact confirmation `SCHEDULE APPROVED`, and registers one
interactive `LIMITED` task. It never starts a full sync. From then on the task
runs every 15 minutes while that same user is signed in and once at sign-in. It
never runs as SYSTEM and never requests highest privileges.

It also refuses an old full-sync receipt if the local configuration, mapper
code, photo/website mapper, or `stage_map.json` changed afterwards. Run and
review `5_first_sync.bat all` again after any such change; a fresh dry-run alone
does not prove that the new mapping was accepted correctly end to end.

Old packages created `EclatSync` / `EclatSync_Boot` as SYSTEM. The safe installer
will not overwrite an unknown existing principal. If either old task exists, IT
must inspect and delete it in a separate elevated maintenance session, close
that session, then run this installer normally as the intended non-admin user.

Check `logs\auto_sync.log` twenty minutes later and confirm a fresh “Sync
complete”. On a machine that must sync with nobody signed in, provision a
dedicated non-admin service identity and a reviewed secret-storage design; do
not change this task to SYSTEM/HIGHEST as a shortcut.

---

## Photographs

Do this after the data sync is working.

1. Put the photo folder path from step 1 into `eclat_config.bat`
   (`SJEP_IMAGE_ROOT`).

2. **Choose which folders to use** — `sync_media.bat --folders`

   This lists every folder holding pictures. **Open a few from each and look at
   them.** Photo libraries usually hold two very different kinds of image: the
   shots a customer should see, and technical ones with the measurements and
   description printed across the picture. Only the first belong in a catalogue —
   a customer shown a photo with "18.5 mm" written over it is worse than a
   customer shown nothing.

   Then set ONE of these in `eclat_config.bat`:

   ```
   set "SJEP_IMAGE_ONLY_FOLDERS=LIVE IMAGES"      use only these
   set "SJEP_IMAGE_SKIP_FOLDERS=STL,SIZE,DETAIL"  use everything except these
   ```

   Leave both blank to take everything.

3. Try a few: `sync_media.bat 25`. Check they appear in the catalogue, and that
   none of them have writing on the picture.
4. Then `sync_media.bat` for the rest.

Thousands of photos take a few hours. That is normal. You can stop it and start
it again. The ledger records the storage upload separately from each backend's
link receipt. An approval or link failure exits nonzero and remains pending; the
next run reuses the stored URL and retries the link instead of uploading the
photo again. A photo is complete only after the backend confirms that the exact
batch was fully upserted with zero skips. The pictures go straight from this
computer to the storage service; they do not pass through the Eclat servers.

---

## Day to day

Leave the designated sync user signed in. It runs on its own in that user's
interactive, limited-privilege session.

- **Check it is working:** open `logs\auto_sync.log`. Each run adds a line;
  "Sync complete" means success.
- **Run one now:** double-click `run_sync.bat` normally, never elevated.
- **See the schedule:** Windows Task Scheduler, look for `EclatSync`.

**Turn it off** (a normal Command Prompt as the task owner):

```
schtasks /Delete /TN "EclatSync" /F
```

Removing an old SYSTEM-owned `EclatSync_Boot` may require IT's elevated
maintenance session. Do not run the agent scripts from that session.

---

## What is in this folder

| File | What it is |
|---|---|
| `1_discover.bat` … `5_first_sync.bat` | The steps above, in order |
| `install_scheduler.bat` | Makes the sync automatic. Last, and only once. |
| `run_sync.bat` | One sync cycle. Used by the schedule; also manual. |
| `register_scheduler.ps1` | Creates the interactive, least-privilege task. |
| `verify_install_security.ps1` | Fails closed on unsafe identity/path/ACL. |
| `setup_runtime.ps1` | Builds the package-local, exact-version Python runtime. |
| `require_runtime.bat` | Makes every entry point refuse a missing/global runtime. |
| `requirements-lock.txt` | Exact dependency set; suitable for a reviewed offline wheelhouse. |
| `setup.bat` | Retired guardrail; points operators to the numbered workflow. |
| `sync_media.bat` | Uploads photographs |
| `eclat_config.bat` | **Your** settings. Contains passwords — keep private. |
| `create_readonly_login.sql` | Give to IT: makes a read-only database account |
| `logs\` | What happened, and when |
| `reports\` | The discovery report |
| `ONSITE-RUNBOOK.md` | For the Eclat engineer, not for day-to-day use |

---

## For the Eclat / IT team

- Connects with `ApplicationIntent=ReadOnly` and `readonly=True`. Use the
  least-privilege login from `create_readonly_login.sql`; never `sa`.
- Outbound HTTPS only. No inbound firewall changes.
- Mapped watermarks are independent per source; raw-mirror watermarks are
  independent per table. Both are namespaced by backend, approved mapper hash,
  SQL-source hash and server configuration revision. A new approval generation
  therefore rereads safely instead of inheriting an incompatible checkpoint.
- A watermark only advances after **every** related upload chunk returns a
  complete zero-skip acknowledgement. Child/summary/lookup-only edits are
  included in the parent boundary; any partial run deliberately advances none.
- Data, media and website commands share one operating-system process lock.
  Checkpoint and media-ledger files are atomically replaced, so overlap, Ctrl+C
  or a crash cannot expose a half-written JSON file.
- If a heartbeat reports that head office changed the configuration generation,
  the process is permanently fenced until it exits and a clean run starts.
- Records are upserted on their original id, so re-sending refreshes rather than
  duplicating. The sync never deletes anything in Eclat.

### Discovery → controlled sample → full sync

1. **Discover** (`1_discover.bat`) — read-only. The report
   now ends with a **PER-STORE x PER-ENTITY MATRIX**: for stores, products, stock,
   customers, sales, payments, orders, manufacturing and photos it shows
   `Store | Entity | Count | Missing Store | Unknown Mapping` using the same branch
   attribution the sync uses. "Missing Store" = rows with no branch value; "Unknown
   Mapping" = a branch value not in the store catalog. Products/photos are shown as
   a single GLOBAL row (company-wide, storeId null). Both extra columns near zero =
   a clean per-branch cutover.

2. **Controlled sample** — prove ONE slice before any full run. None of these
   advance the real watermark and all stay idempotent (upsert on legacyId):
   - `python sync_sjep.py --sample` — a few rows per entity (implies `--limit 10`),
     printing a per-batch breakdown (attributed-direct / fell-back-via-book /
     unknown, plus upserted / skipped / errors).
   - `python sync_sjep.py --store <branchLegacyId>` — only rows resolving to that
     one branch (children follow their filtered parents).
   - `python sync_sjep.py --entity sales` — one extractor only. Aliases:
     `customers=parties`, `payments=ledger`, `manufacturing=orders`.
   - Combine them, e.g. `--sample --store 10 --entity sales`. A controlled run also
     skips the store-catalog / staff push and the full raw mirror.

3. **Full sync** — a normal `run_sync.bat` (no controlled flags) advances the
   watermark and, unless `SJEP_SKIP_MIRROR=1`, runs the keep-everything mirror.

### Configuration / env vars

All settings come from `eclat_config.bat` (never committed — see
`eclat_config.example.bat` for the template with blank placeholders):

| Var | Meaning |
|---|---|
| `ECLAT_BASE_URL` | One Eclat backend URL; each environment needs its own enrolled agent/token |
| `CARATOS_APPROVED_BACKEND_ORIGIN` | Exact reviewed copy of `ECLAT_BASE_URL`; a missing/mismatched pin stops every networked command before authentication |
| `CARATOS_AGENT_TOKEN` | restricted organisation-wide Gati Connect token (secret) |
| `ECLAT_WEBSITE_API` / `ECLAT_APPROVED_WEBSITE_API` / `ECLAT_WEBSITE_ORIGIN` | Optional exact product feed, its reviewed pin and explicit public origin; no package default |
| `SJEP_SQL_SERVER` / `SJEP_SQL_DB` | SQL Server instance + database (read-only) |
| `SJEP_SQL_USER` / `SJEP_SQL_PASS` | read-only login; blank = Windows auth |
| `SJEP_SKIP_STAFF` / `SJEP_SKIP_MIRROR` | `1` to skip staff import / raw mirror |
| `SJEP_IMAGE_ROOT` / `SJEP_IMAGE_ONLY_FOLDERS` / `SJEP_IMAGE_SKIP_FOLDERS` | photo folder + include/exclude filters |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` / `R2_PUBLIC_BASE_URL` | Cloudflare R2 (photos upload straight from this PC) |
| `SYNC_DEFAULT_STORE_ID` | branch legacyId to pass to `--store` for controlled runs |

`2_configure.bat` deliberately offers no backend or website production default.
An existing installation created by an older package must rerun step 2 and
review its target once; copying only `ECLAT_BASE_URL` is no longer enough. Feed
and backend requests refuse redirects so an approved URL cannot silently move a
one-click command to another host.

Before the first upload, run `sync_sjep.py --dry-run` and copy its printed
`profileHash` and `sourceInstanceHash` into the enrolled agent's head-office
configuration. Saving that configuration creates a server-controlled
`configRevision`. Every `/sync` request presents all three values; the backend
rejects human JWTs, disabled/unapproved agents, a changed mapping contract, a
repointed SQL source, or a stale configuration generation before domain writes.
The profile hash includes the actual Gati mapper scripts and the canonical
contents (or explicit absence) of `stage_map.json`, so replacing any extractor,
field mapping or order-stage mapping requires a fresh dry-run and head-office
approval; remembering to bump a manual version is not the security boundary.
