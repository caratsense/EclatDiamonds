@echo off
REM ===========================================================================
REM  STEP 4 of 5  —  PREVIEW (a "dry run")
REM
REM  Reads everything that WOULD be sent and prints the counts, plus anything
REM  that looks wrong in the data. Sends NOTHING.
REM
REM  This is the last cheap moment to notice a problem.
REM ===========================================================================
setlocal EnableExtensions
cd /d "%~dp0"

echo.
echo ============================================================
echo   STEP 4 of 5 - PREVIEW (nothing is sent)
echo ============================================================
echo.

if not exist "eclat_config.bat" (
  echo [PROBLEM] No settings yet. Run 2_configure.bat first.
  pause
  exit /b 1
)
call eclat_config.bat

if exist "_pyexe.bat" (call "_pyexe.bat") else (set "PYEXE=python")

"%PYEXE%" sync_sjep.py --dry-run

echo.
echo ============================================================
echo   Check the counts above against what the shop expects.
echo.
echo   If a number looks wrong - far too few customers, no sales,
echo   an empty stock list - STOP and tell the Eclat team.
echo   Sending wrong data is much harder to undo than to prevent.
echo.
echo   If the numbers look right:  5_first_sync.bat
echo ============================================================
echo.
pause
endlocal
