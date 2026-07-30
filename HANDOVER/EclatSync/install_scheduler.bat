@echo off
REM ===========================================================================
REM  LAST STEP  —  MAKE IT AUTOMATIC
REM
REM  Only run this AFTER you have seen real data arrive correctly in the
REM  dashboard. From here the sync runs every 15 minutes forever, so anything
REM  mapped wrongly would be re-sent every 15 minutes forever too.
REM
REM  Right-click -> "Run as administrator".
REM ===========================================================================
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

echo.
echo ============================================================
echo   MAKE THE SYNC AUTOMATIC
echo ============================================================
echo.

net session >nul 2>&1
if errorlevel 1 (
  echo [PROBLEM] Right-click this file and choose "Run as administrator".
  pause
  exit /b 1
)

if not exist "eclat_config.bat" (
  echo [PROBLEM] No settings. Run 2_configure.bat first.
  pause
  exit /b 1
)

REM --- Refuse to automate anything that has not been looked at first. ---
REM These are not box-ticking: scheduling before a verified run is how bad data
REM gets pushed every 15 minutes for a week before anyone notices.
if not exist "reports\discovery_report.txt" (
  echo [STOP] No discovery report found.
  echo.
  echo        Run 1_discover.bat and send the report to the Eclat team
  echo        BEFORE automating anything.
  pause
  exit /b 1
)
if not exist "logs\auto_sync.log" (
  echo [STOP] No sync has ever run on this computer.
  echo.
  echo        Run 4_preview.bat, then 5_first_sync.bat, and check the
  echo        dashboard. Only automate a sync you have already watched work.
  pause
  exit /b 1
)
findstr /C:"Sync complete" "logs\auto_sync.log" >nul 2>&1
if errorlevel 1 (
  echo [STOP] No completed sync in the log yet.
  echo.
  echo        Run 5_first_sync.bat and make sure it finishes, then come back.
  pause
  exit /b 1
)

echo [OK] Discovery report exists
echo [OK] At least one sync has completed
echo.

call eclat_config.bat
if not defined SJEP_SQL_USER (
  echo ************************************************************
  echo   WARNING - NO DATABASE LOGIN SET
  echo.
  echo   The automatic sync runs as the COMPUTER, not as you. With a
  echo   blank username it will try to open the database as the
  echo   machine account, which usually has no permission - so the
  echo   sync silently fails every 15 minutes even though your manual
  echo   runs worked perfectly.
  echo.
  echo   Strongly recommended: ask IT to run create_readonly_login.sql,
  echo   then run 2_configure.bat again and enter that login.
  echo ************************************************************
  echo.
  set /p GOON="Continue anyway? (y/N): "
  if /I not "!GOON!"=="y" (
    echo Stopped. Nothing was scheduled.
    pause
    exit /b 1
  )
)

set "PYEXE="
for /f "delims=" %%P in ('where python 2^>nul') do if not defined PYEXE set "PYEXE=%%P"
if not defined PYEXE (
  echo [PROBLEM] Python not found. Install it with "Add Python to PATH" ticked.
  pause
  exit /b 1
)
> "_pyexe.bat" echo set "PYEXE=%PYEXE%"
echo [OK] Python: %PYEXE%

echo.
echo Scheduling: every 15 minutes, and at every restart...
schtasks /Create /TN "EclatSync" /TR "\"%~dp0run_sync.bat\"" /SC MINUTE /MO 15 /RU SYSTEM /RL HIGHEST /F
if errorlevel 1 (
  echo [PROBLEM] Could not create the task. Did you run as administrator?
  pause
  exit /b 1
)
schtasks /Create /TN "EclatSync_Boot" /TR "\"%~dp0run_sync.bat\"" /SC ONSTART /RU SYSTEM /RL HIGHEST /F

echo.
echo ============================================================
echo   DONE - THE SYNC IS NOW AUTOMATIC
echo     every 15 minutes, and after every restart
echo     runs even with nobody logged in
echo     log:  logs\auto_sync.log
echo.
echo   IMPORTANT: check logs\auto_sync.log in about 20 minutes and
echo   confirm you see a fresh "Sync complete". If it stopped
echo   working the moment it became automatic, it is almost always
echo   the database login - see the warning above.
echo.
echo   To switch it off later (admin Command Prompt):
echo     schtasks /Delete /TN "EclatSync" /F
echo     schtasks /Delete /TN "EclatSync_Boot" /F
echo ============================================================
echo.
pause
endlocal
