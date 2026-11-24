@echo off
REM ===========================================================================
REM  Eclat / CaratSense — CATALOGUE PHOTO SYNC
REM
REM  Uploads the shop's jewellery photographs to Cloudinary and links them to the
REM  catalogue. Read-only against SQL Server and against the photo folder.
REM
REM  The FIRST run can take a long time (it uploads every photo). Later runs only
REM  handle new ones. Safe to stop and restart -- progress is checkpointed.
REM
REM  Try a small batch first:   sync_media.bat 25
REM ===========================================================================
cd /d "%~dp0"

if not exist "eclat_config.bat" (
  echo [ERROR] eclat_config.bat missing. Copy eclat_config.example.bat and fill it in.
  pause
  exit /b 1
)
call eclat_config.bat

if exist "_pyexe.bat" (call "_pyexe.bat") else (set "PYEXE=python")

REM --folders lists the photo folders so a human can decide which ones belong in
REM a customer-facing catalogue. Many jewellery libraries keep technical shots
REM with measurements printed across the picture; those must not go in.
if /I "%~1"=="--folders" (
  "%PYEXE%" sync_media.py --folders
) else if "%~1"=="" (
  "%PYEXE%" sync_media.py
) else (
  echo Running a limited batch of %~1 photos...
  "%PYEXE%" sync_media.py --limit %~1
)

echo.
echo Log: media_sync.log
pause
