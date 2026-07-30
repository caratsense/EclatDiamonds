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
| 1 | `1_discover.bat` | Reads your system, writes a report | **No** |
| 2 | `2_configure.bat` | Asks a few questions, saves your settings | No |
| 3 | `3_test.bat` | Checks both connections work | No |
| 4 | `4_preview.bat` | Shows exactly what *would* be sent | **No** |
| 5 | `5_first_sync.bat` | Sends a **small batch** to check | Yes, a little |
| — | `install_scheduler.bat` | Makes it run automatically, forever | Yes |

**Steps 1 to 4 change nothing anywhere.** You can run them as often as you like.

The last step is deliberately separate and deliberately last. Once the sync is
automatic it repeats every 15 minutes forever — so anything set up wrongly would
be re-sent every 15 minutes forever too. It refuses to run until it can see that
you completed step 1 and watched a sync finish.

---

## Before you start

**Two things need installing.** Both are free and standard.

1. **Python** — from <https://www.python.org/downloads/>.
   On the first screen of the installer, tick **"Add Python to PATH"** at the
   bottom. This is the single most common cause of trouble. If you miss it,
   uninstall and install again.

2. **ODBC Driver 17 for SQL Server** — search that exact name; it is a Microsoft
   download. Often already installed. Step 3 will tell you if it is missing.

**One thing to ask your IT person for.** The file `create_readonly_login.sql` in
this folder creates a database account that can only read, never write. Ask them
to run it and give you the username and password.

> **Please do this rather than leaving the login blank.** A blank login uses your
> Windows account, which works while *you* are running things by hand — and then
> fails once the sync runs automatically in the background, because at that point
> it runs as the computer, not as you. The failure is silent. This one detail
> causes more support calls than everything else combined.

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
read-only login from above, and the Eclat email/password and storage keys the
Eclat team gives you.

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

**Only after everything above looks right.** Right-click → **Run as
administrator**.

From here it runs every 15 minutes and after every restart, with nobody logged
in. Check `logs\auto_sync.log` twenty minutes later and confirm a fresh
"Sync complete" — if it worked by hand but not automatically, it is almost
always the database login.

---

## Photographs

Do this after the data sync is working.

1. Put the photo folder path from step 1 into `eclat_config.bat`
   (`SJEP_IMAGE_ROOT`).
2. Try a few: `sync_media.bat 25`. Check they appear in the catalogue.
3. Then `sync_media.bat` for the rest.

Thousands of photos take a few hours. That is normal. You can stop it and start
it again — it remembers what is done and never uploads the same photo twice. The
pictures go straight from this computer to the storage service; they do not pass
through the Eclat servers.

---

## Day to day

Nothing. It runs on its own.

- **Check it is working:** open `logs\auto_sync.log`. Each run adds a line;
  "Sync complete" means success.
- **Run one now:** double-click `run_sync.bat`.
- **See the schedule:** Windows Task Scheduler, look for `EclatSync`.

**Turn it off** (Command Prompt as administrator):

```
schtasks /Delete /TN "EclatSync" /F
schtasks /Delete /TN "EclatSync_Boot" /F
```

---

## What is in this folder

| File | What it is |
|---|---|
| `1_discover.bat` … `5_first_sync.bat` | The steps above, in order |
| `install_scheduler.bat` | Makes the sync automatic. Last, and only once. |
| `run_sync.bat` | One sync cycle. Used by the schedule; also manual. |
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
- The watermark only advances after **every** upload chunk returns 2xx, so a
  failed run safely retries everything next cycle — no lost or duplicated rows.
  `--limit` and `--only` runs deliberately never advance it.
- Command line: `--dry-run`, `--limit N`, `--only parties,stock`, `--test`.
- Records are upserted on their original id, so re-sending refreshes rather than
  duplicating. The sync never deletes anything in Eclat.
