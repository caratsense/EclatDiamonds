# Gati sync agent — upgrade runbook (APPSERVER)

**For:** whoever is at the console on APPSERVER (192.168.1.254).
**Takes:** about an hour, most of it the first full sync.
**Result:** the deployed site stops showing data that ends on 31 July 2026.

Run these in order. Paste the output of anything marked **[report]** back to me.

---

## What is already done — do not repeat

- A Gati Connect agent is **enrolled** in CaratOS: `cmu4080tk00uznv01ybh7q7te`,
  source `gati`, whole organisation.
- Its **approved configuration is posted** — config revision
  `cb266601-4a70-4697-98d3-e7e47f8fb596`, unattributed rows routed to the
  "Unassigned — needs a branch" holding store.
- The agent's own policy check was run against production with the real token
  and **passed**, before any install. The server side is ready.
- Both scheduled tasks (`EclatSync`, `EclatSync_Boot`) are **disabled**. Leave
  them that way — they are the fallback until step 11.

You will need the agent token (`cxa_…`). It is not written down here on purpose.

---

## 1. Create the sync user — elevated PowerShell

The package refuses to run as an administrator or from a folder other accounts
can read, and it re-checks this on *every* sync. That is why this account exists.

```powershell
$pw = Read-Host -AsSecureString "New password for svc_caratos"
New-LocalUser -Name svc_caratos -Password $pw -FullName "CaratOS sync" -PasswordNeverExpires
Add-LocalGroupMember -Group Users -Member svc_caratos
Get-LocalGroupMember -Group Administrators | Select-Object Name
```

**[report]** the last line. `svc_caratos` must NOT appear in it.

Keep that password — step 12 needs it.

## 2. Give it read-only SQL access — elevated

APPSERVER is a workgroup machine, so this is a local Windows login. No password
is stored anywhere as a result.

```sql
USE [master];
CREATE LOGIN [APPSERVER\svc_caratos] FROM WINDOWS WITH DEFAULT_DATABASE=[APRSSJEP];
USE [APRSSJEP];
CREATE USER [APPSERVER\svc_caratos] FOR LOGIN [APPSERVER\svc_caratos];
ALTER ROLE [db_datareader] ADD MEMBER [APPSERVER\svc_caratos];
DENY INSERT, UPDATE, DELETE, EXECUTE, ALTER, CONTROL TO [APPSERVER\svc_caratos];
```

Run it with `sqlcmd -S localhost -d master -E -i <file>.sql`.

## 3. Install Python for all users — elevated

Python 3.14 currently lives under Administrator's profile, which `svc_caratos`
cannot read — and a virtual environment built from it would record that path and
break. Re-run the 3.14 installer with **"Install for all users"** ticked, or:

```
python-3.14.x-amd64.exe /quiet InstallAllUsers=1 PrependPath=1
```

**[report]** `& "C:\Program Files\Python314\python.exe" --version`

## 4. Copy the package — elevated

Source is the `synceclatcaratsense` folder from the repo. Copy it to the sync
user's private area. Do **not** use `D:\EclatSync_new`: a folder on `D:\`
inherits a `BUILTIN\Users` entry from the drive root and fails the check in
step 6.

```
robocopy <source> C:\Users\svc_caratos\AppData\Local\CaratOS\GatiConnect /E ^
  /XD __pycache__ .venv logs reports /XF eclat_config.bat
copy D:\EclatSync\_pyexe.bat C:\Users\svc_caratos\AppData\Local\CaratOS\GatiConnect\
```

**Do not add `/COPYALL` or `/SEC`, and do not use `xcopy /O`.** Those preserve the
*source* folder's permissions, which would drag `BUILTIN\Users` across from `D:\`
and fail step 6 with an error that reads like an unrelated permissions problem.
A plain copy inherits the destination's permissions, which is what we want. A zip
extracted into place is equally fine.

`eclat_config.bat` is excluded deliberately — it is a developer's local file.
Step 7 writes the real one. `_pyexe.bat` must come across or the scripts cannot
find Python.

## 5. Check the folder's permissions — elevated

Only the sync user, SYSTEM and local Administrators may appear, and the **owner**
must be one of those three as well — the check tests both. A per-user
`%LOCALAPPDATA%` path normally satisfies this already by inheritance, so look
before changing anything:

```
icacls C:\Users\svc_caratos\AppData\Local\CaratOS\GatiConnect
```

**[report]** it. Expect exactly `SYSTEM`, `BUILTIN\Administrators` and
`APPSERVER\svc_caratos`. If `BUILTIN\Users` or anyone else appears — which means
the copy carried permissions across from `D:\` — fix it:

```
icacls C:\Users\svc_caratos\AppData\Local\CaratOS\GatiConnect /inheritance:r
icacls C:\Users\svc_caratos\AppData\Local\CaratOS\GatiConnect ^
  /grant "APPSERVER\svc_caratos:(OI)(CI)F" "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" /T
icacls C:\Users\svc_caratos\AppData\Local\CaratOS\GatiConnect /setowner "APPSERVER\svc_caratos" /T
```

**Now close the elevated session.** Everything below runs signed in as
`svc_caratos`, in a normal window. Never "Run as administrator" again.

## 6. Build the runtime and check the posture — as svc_caratos

```powershell
cd $env:LOCALAPPDATA\CaratOS\GatiConnect
powershell -ExecutionPolicy Bypass -File .\setup_runtime.ps1
powershell -ExecutionPolicy Bypass -File .\verify_install_security.ps1 -InstallPath $PWD
```

**[report]** both. The second must print nothing and exit 0. Any
`[SECURITY STOP]` line names exactly what to fix — usually a leftover ACL entry.

Build the virtual environment **here, as this user**. The security check inspects
`.venv`, `.venv\Scripts`, `.venv\Scripts\python.exe` and `.venv\Lib\site-packages`
individually, so one built elsewhere and moved in fails — and it would carry the
wrong base Python path anyway.

## 7. Write the configuration — as svc_caratos

Copy `eclat_config.example.bat` to `eclat_config.bat` and set these. Values in
the first block are carried across from `D:\EclatSync\eclat_config.bat`, which is
known good — read them from there, do not retype from memory.

```
set "ECLAT_BASE_URL=https://backend-production-89dd.up.railway.app"
set "CARATOS_APPROVED_BACKEND_ORIGIN=https://backend-production-89dd.up.railway.app"
set "SJEP_IMAGE_ROOT=D:\GATISOFTTECH\SJEP IMAGES"
set "SJEP_IMAGE_ONLY_FOLDERS=ALR,AER,APD,ABR,AGR,ANK"
set "R2_ACCOUNT_ID=<carry across>"
set "R2_ACCESS_KEY_ID=<carry across>"
set "R2_SECRET_ACCESS_KEY=<carry across>"
set "R2_BUCKET=<carry across>"
set "R2_PUBLIC_BASE_URL=<carry across>"

set "CARATOS_AGENT_TOKEN=cxa_…"

set "SJEP_SQL_SERVER=localhost"
set "SJEP_SQL_DB=APRSSJEP"
set "SJEP_SQL_USER="
set "SJEP_SQL_PASS="

set "SJEP_SKIP_MIRROR=1"
set "SJEP_SKIP_STAFF="
```

Four of these are not free choices:

- **`SJEP_SQL_SERVER` must stay `localhost` and the database `APRSSJEP`.** The
  approved configuration is bound to a hash of exactly those two strings.
  `localhost\SQLEXPRESS` is a different hash and every push would be refused.
- **`SJEP_SQL_USER`/`PASS` stay blank.** The sync user has a Windows login from
  step 2, so no database password is stored on this machine.
- **`SJEP_SKIP_MIRROR=1` is mandatory.** The raw mirror walks 1,149 tables; in
  July it took Railway down on `Const_PortCode` (72,830 rows) with "Application
  failed to respond". The shop-facing data does not depend on it.
- **`SJEP_SKIP_STAFF` stays blank** — Gati remains the source of truth for staff,
  as the owner decided. Staff will keep arriving from the sync alongside
  app-created accounts, so **expect duplicates in the people list**: the same
  person once from Gati and once from their own sign-up. That is the chosen
  behaviour, not a fault. Setting this to `1` stops it, and is one line.

There is no `ECLAT_EMAIL` or `ECLAT_PASSWORD` any more. That is the point of this
upgrade: the head-office password stops living on this machine.

## 8. Discover, test, preview — as svc_caratos

```
1_discover.bat
3_test.bat
4_preview.bat
```

**[report]** all three. `3_test.bat` is the one that proves SQL and the token
both work. If it reports an authorisation failure, stop and send it to me — do
not change the config to "fix" it.

## 9. The real run — as svc_caratos

```
5_first_sync.bat all
```

This is the long one. Expect roughly 119 parties, 221 products, 2,468 stock
pieces, 321 sales (1,792 lines), 64 orders (905 items), 479 bags and 781
payments — six weeks of backlog.

**[report]** the tail of `logs\auto_sync.log`. The line that matters is
**`watermark advanced`**. Without it nothing was committed, whatever else the log
says. Also expect `reports\full_sync_completed.txt` to appear.

## 10. Confirm it landed — anywhere

1. Sign in to https://eclat-diamonds-pi.vercel.app as head office.
2. `/data` → **On-site agents** → the agent's **Last check-in** should now show a
   time, and **Version** should read `0.3.0` instead of "not reported".
3. Check stock counts and recent orders show September, not July.

That **Last check-in** field is the new safeguard. Six weeks of silence happened
because nothing announced the sync had stopped; this is where that now shows.

## 11. Schedule it

**Do not edit `eclat_config.bat` between step 9 and here.** The installer
compares its timestamp against the full-run receipt and refuses if the config is
newer — a tidy-up here means running step 9 again.

The two old tasks must be **deleted**, not left disabled: the installer refuses
to overwrite a task whose principal it does not recognise. Tell me when you reach
this point and I will remove them over RPC, then:

```
install_scheduler.bat
```

It re-runs every safety check, refuses if any is unmet, and creates its own task
with a 15-minute repeat.

## 12. Make it survive a logoff

The installer creates the task with an interactive token, which only runs while
`svc_caratos` is signed in. On an unattended server that means the sync stops the
next time someone logs out — the exact silent failure we are fixing.

Convert it to a stored password (I can do this over RPC too):

```
schtasks /Change /TN "\<task name>" /RU "APPSERVER\svc_caratos" /RP <password>
```

Grant `svc_caratos` the **Log on as a batch job** right
(`secpol.msc` → Local Policies → User Rights Assignment). The account is
non-admin, so the security check still passes on every run.

**[report]** `schtasks /Query /TN "\<task name>" /V /FO LIST`

## 13. Rotate the token — last

The token passed through a chat transcript, so retire it once everything works:

1. `/data` → the agent → rotate.
2. Put the new value in `CARATOS_AGENT_TOKEN` in `eclat_config.bat`.
3. Wait for the next run and confirm **Last check-in** moves.

Rotating does not disturb the approved configuration — only the credential
changes.

One consequence to know about later: editing the config here makes it newer than
`reports\full_sync_completed.txt`. That is harmless for running, but if the task
ever needs rebuilding with `install_scheduler.bat`, it will refuse until a fresh
`5_first_sync.bat all` has been run. Re-run the sync — do not backdate or delete
the receipt to get past it.

---

## If something stops

| Message | Means |
|---|---|
| `[SECURITY STOP] This process is elevated` | You are in an admin window. Sign in as `svc_caratos`. |
| `[SECURITY STOP] Unexpected owner` / extra identity | Step 5's ACL did not take. Re-run it. |
| `requires an enrolled Gati Connect agent` | The token is missing from the config or was not read. |
| `does not have a complete approved configuration` | The approved config was cleared server-side. Tell me. |
| `does not match the current approved configuration` | A mapping file was edited, or the SQL server/database string changed. |
| `pinned to a different source descriptor` | `SJEP_SQL_SERVER`/`SJEP_SQL_DB` changed after the first successful push. |
| `Application failed to respond` | The raw mirror ran. `SJEP_SKIP_MIRROR=1` is missing. |

Nothing in this runbook deletes or overwrites data in Gati. The agent reads the
SQL Server read-only and pushes outward over HTTPS.
