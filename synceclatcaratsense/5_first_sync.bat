@echo off
REM ===========================================================================
REM  STEP 5 of 5  —  THE FIRST REAL SEND, IN SMALL STEPS
REM
REM  Sends a SMALL batch first so it can be checked in the dashboard before
REM  everything goes. Nothing is scheduled yet — the automatic every-15-minutes
REM  sync is only installed afterwards, by install_scheduler.bat, and only once
REM  you have seen the data arrive correctly.
REM
REM    5_first_sync.bat        -> 25 rows of each kind
REM    5_first_sync.bat 500    -> 500 rows of each kind
REM    5_first_sync.bat all    -> everything
REM ===========================================================================
setlocal EnableExtensions
cd /d "%~dp0"

if not exist "eclat_config.bat" (
  echo [PROBLEM] No settings yet. Run 2_configure.bat first.
  pause
  exit /b 1
)
call eclat_config.bat

call "%~dp0require_runtime.bat"
if errorlevel 1 (
  pause
  exit /b 21
)

"%PYEXE%" gati_target_safety.py backend
if errorlevel 1 (
  echo Run 2_configure.bat and explicitly review the backend target.
  pause
  exit /b 20
)

set "BATCH=%~1"
if "%BATCH%"=="" set "BATCH=25"

echo.
echo ============================================================
if /I "%BATCH%"=="all" (
  echo   STEP 5 of 5 - SENDING EVERYTHING
) else (
  echo   STEP 5 of 5 - SENDING A SMALL BATCH ^(%BATCH% of each^)
)
echo ============================================================
echo.

if /I "%BATCH%"=="all" (
  "%PYEXE%" sync_sjep.py
) else (
  "%PYEXE%" sync_sjep.py --limit %BATCH%
)
set "SYNC_EXIT=%ERRORLEVEL%"
if not "%SYNC_EXIT%"=="0" (
  echo.
  echo [PROBLEM] The send failed. No completion receipt was written.
  pause
  endlocal & exit /b %SYNC_EXIT%
)

if /I "%BATCH%"=="all" (
  if not exist "reports" mkdir "reports"
  > "reports\full_sync_completed.txt" echo Full manual sync completed successfully at %DATE% %TIME%.
  >> "reports\full_sync_completed.txt" echo Review the dashboard before approving automatic scheduling.
)

echo.
echo ============================================================
echo   NOW OPEN THE ECLAT DASHBOARD AND CHECK:
echo.
echo     Customers   - real names, not blanks
echo     Stock       - pieces you recognise
echo     Sales       - amounts that look right
echo     Branches    - data under the correct shop
echo.
if /I not "%BATCH%"=="all" (
  echo   Looks right? Send more:
  echo     5_first_sync.bat 500
  echo     5_first_sync.bat all
  echo.
)
if /I "%BATCH%"=="all" (
  echo   Full-run receipt written: reports\full_sync_completed.txt
  echo   Review the dashboard before approving automation.
  echo.
)
echo   Once EVERYTHING is correct, and only then:
echo     install_scheduler.bat   ^(run normally; never Run as administrator^)
echo ============================================================
echo.
pause
endlocal
