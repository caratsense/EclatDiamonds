@echo off
REM ── Eclat Busy/SJEP Sync config — copy to eclat_config.bat and fill in. ──
REM Never commit the real eclat_config.bat (it holds passwords).

REM Eclat dashboard backend(s). Comma-separate to push to several at once, e.g.
REM   set ECLAT_BASE_URL=http://localhost:4000,https://your-eclat-backend.up.railway.app
set "ECLAT_BASE_URL=https://your-eclat-backend.up.railway.app"
set "ECLAT_EMAIL=sync@yourjewelryclient.com"
set "ECLAT_PASSWORD=CHANGE_ME"

REM Live SJE Plus / APRS SQL Server (READ-ONLY login recommended)
set "SJEP_SQL_SERVER=localhost\SQLEXPRESS"
set "SJEP_SQL_DB=APRSSJEP"
REM Leave USER blank to use Windows authentication:
set "SJEP_SQL_USER="
set "SJEP_SQL_PASS="

REM ── CONTINUOUS SYNC BEHAVIOUR (the every-15-min scheduled run) ───────────────
REM The scheduled task runs `python sync_sjep.py` with NO arguments, so anything
REM you want the automatic sync to do must be set as an env var HERE.
REM
REM SJEP_SKIP_STAFF — set to 1 ONCE THE SHOP HAS GONE LIVE on self-signup.
REM   After go-live, people create their own accounts in the app and a manager /
REM   head office approves them. If this is left off, the sync keeps re-importing
REM   Gati's staff every 15 minutes and re-clutters the roster after the wipe.
REM   Leave BLANK during the initial backfill; set to 1 when you switch to signup.
set "SJEP_SKIP_STAFF="
REM
REM SJEP_SKIP_MIRROR — set to 1 to skip the full raw-table mirror on every run.
REM   The mapped shop data (customers/stock/sales/…) is unaffected; the mirror is
REM   just the keep-everything backup and its first pass is long. Most deployments
REM   leave this ON (=1) for the continuous sync and run a mirror manually now and
REM   then.
set "SJEP_SKIP_MIRROR=1"

REM ── CATALOGUE PHOTOS ────────────────────────────────────────────────────────
REM The folder holding the jewellery photographs. The database stores only the
REM FILE NAMES, so we have to be told where the files themselves live.
REM Don't guess: run discover.bat, which hunts for the folder and prints the
REM exact line to paste here.
set "SJEP_IMAGE_ROOT="

REM Which folders inside it to actually use.
REM A jewellery photo library usually holds two kinds of picture: the shots a
REM customer should see, and technical ones with the measurements printed across
REM them. Only the first belong in a catalogue.
REM Run  sync_media.bat --folders  to list what is there, look at a few, then set
REM ONE of these (leave both blank to take everything):
REM   set "SJEP_IMAGE_ONLY_FOLDERS=LIVE IMAGES"      take only these
REM   set "SJEP_IMAGE_SKIP_FOLDERS=STL,SIZE,DETAIL"  take everything except these
set "SJEP_IMAGE_ONLY_FOLDERS="
set "SJEP_IMAGE_SKIP_FOLDERS="

REM ── CLOUDFLARE R2 (where the photos are uploaded) ───────────────────────────
REM Photos go STRAIGHT from this PC to R2; they never pass through the Eclat
REM backend. Leave blank to skip photo sync entirely.
REM
REM Where each value comes from (Cloudflare dashboard -> R2):
REM   R2_ACCOUNT_ID        R2 -> Overview, the "Account ID" on the right.
REM   R2_ACCESS_KEY_ID     R2 -> API -> Manage API Tokens -> Create Token
REM   R2_SECRET_ACCESS_KEY (shown ONCE when the token is created — copy it then)
REM   R2_BUCKET            the bucket name you created, e.g. eclat-media
REM   R2_PUBLIC_BASE_URL   bucket -> Settings -> Public access. Either the
REM                        r2.dev dev URL (https://pub-xxxx.r2.dev) or your
REM                        custom domain (https://images.yourshop.com).
REM                        NO trailing slash.
set "R2_ACCOUNT_ID="
set "R2_ACCESS_KEY_ID="
set "R2_SECRET_ACCESS_KEY="
set "R2_BUCKET="
set "R2_PUBLIC_BASE_URL="

REM Optional: only if your bucket uses a jurisdiction-specific endpoint (EU/FedRAMP).
REM set R2_ENDPOINT=https://<account-id>.eu.r2.cloudflarestorage.com

REM ── CLOUDINARY (alternative to R2 — leave blank if using R2) ────────────────
set "CLOUDINARY_CLOUD_NAME="
set "CLOUDINARY_API_KEY="
set "CLOUDINARY_API_SECRET="
