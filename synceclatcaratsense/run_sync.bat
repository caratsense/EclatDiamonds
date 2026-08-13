@echo off
REM ===========================================================================
REM  Eclat Sync — ONE cycle. Triggered by the "EclatSync" scheduled task
REM  (every 15 min + at every boot, as SYSTEM, forever) and also runnable
REM  manually by double-clicking. Idempotent + watermarked, so running it
REM  twice never duplicates or loses data.
REM ===========================================================================
cd /d "%~dp0"

if not exist "eclat_config.bat" (
  echo [ERROR] eclat_config.bat missing. Run setup.bat first.
  exit /b 1
)

REM Load connection settings (cloud URL + SQL details).
call eclat_config.bat

REM Use the full Python path baked by setup.bat so this works even when run as
REM SYSTEM (whose PATH usually does not include Python). Falls back to PATH.
if exist "_pyexe.bat" (call "_pyexe.bat") else (set "PYEXE=python")

"%PYEXE%" sync_sjep.py
