@echo off
REM ── Eclat Busy/SJEP Sync config — copy to eclat_config.bat and fill in. ──
REM Never commit the real eclat_config.bat (it holds passwords).

REM Eclat dashboard backend(s). Comma-separate to push to several at once, e.g.
REM   set ECLAT_BASE_URL=http://localhost:4000,https://your-eclat-backend.up.railway.app
set ECLAT_BASE_URL=https://your-eclat-backend.up.railway.app
set ECLAT_EMAIL=sync@yourjewelryclient.com
set ECLAT_PASSWORD=CHANGE_ME

REM Live SJE Plus / APRS SQL Server (READ-ONLY login recommended)
set SJEP_SQL_SERVER=localhost\SQLEXPRESS
set SJEP_SQL_DB=APRSSJEP
REM Leave USER blank to use Windows authentication:
set SJEP_SQL_USER=
set SJEP_SQL_PASS=

REM ── CATALOGUE PHOTOS ────────────────────────────────────────────────────────
REM The folder holding the jewellery photographs. The database stores only the
REM FILE NAMES, so we have to be told where the files themselves live.
REM Don't guess: run discover.bat, which hunts for the folder and prints the
REM exact line to paste here.
set SJEP_IMAGE_ROOT=

REM ── CLOUDINARY (where the photos are uploaded) ──────────────────────────────
REM Cloudinary dashboard -> Settings -> API Keys.
REM Photos go STRAIGHT from this PC to Cloudinary; they never pass through the
REM Eclat backend. Leave blank to skip photo sync entirely.
set CLOUDINARY_CLOUD_NAME=
set CLOUDINARY_API_KEY=
set CLOUDINARY_API_SECRET=
