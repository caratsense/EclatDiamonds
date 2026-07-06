@echo off
REM ===========================================================================
REM  Eclat / CaratSense — INSTALL ONCE, RUNS FOREVER
REM  Run this ONE time on the client's office PC (where SJE Plus / APRS SQL
REM  Server runs).  Right-click -> "Run as administrator".
REM
REM  After this, the read-only sync runs by itself:
REM    - every 15 minutes, FOREVER
REM    - automatically at every PC restart (boot)
REM    - as the SYSTEM account, so nobody needs to be logged in
REM  It survives reboots and needs zero babysitting.
REM ===========================================================================
setlocal EnableExtensions
cd /d "%~dp0"

echo.
echo ============================================================
echo   ECLAT SYNC - INSTALL ONCE, RUNS FOREVER
echo ============================================================
echo.

REM --- 0. Must be administrator (needed to create a SYSTEM scheduled task) ---
net session >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Please RIGHT-CLICK this file and choose "Run as administrator".
  pause
  exit /b 1
)
echo [OK] Running as administrator

REM --- 1. Find Python (full path, so the SYSTEM task can run it) ---
set "PYEXE="
for /f "delims=" %%P in ('where python 2^>nul') do if not defined PYEXE set "PYEXE=%%P"
if not defined PYEXE (
  echo [ERROR] Python not found. Install Python 3.10+ from https://www.python.org/downloads/
  echo         During install TICK "Add Python to PATH", then re-run this file.
  pause
  exit /b 1
)
echo [OK] Python: %PYEXE%
> "_pyexe.bat" echo set "PYEXE=%PYEXE%"

REM --- 2. Config present? ---
if not exist "eclat_config.bat" (
  echo [ERROR] eclat_config.bat not found. Fill in the 3 SQL lines first
  echo         SJEP_SQL_SERVER, SJEP_SQL_DB, SJEP_SQL_PASS - then re-run.
  pause
  exit /b 1
)
echo [OK] eclat_config.bat found

REM --- 3. Install Python dependencies ---
echo.
echo Installing Python dependencies...
"%PYEXE%" -m pip install --upgrade pip
"%PYEXE%" -m pip install -r requirements.txt
if errorlevel 1 (
  echo [ERROR] pip install failed. Check internet/proxy and re-run.
  pause
  exit /b 1
)
echo [OK] Dependencies installed

REM --- 4. Connectivity test (Eclat login + READ-ONLY SQL connect). Pulls nothing. ---
echo.
echo [NOTE] Needs "ODBC Driver 17 for SQL Server" if the SQL test fails:
echo        https://learn.microsoft.com/sql/connect/odbc/download-odbc-driver-for-sql-server
echo.
echo Running connectivity test...
call eclat_config.bat
"%PYEXE%" sync_sjep.py --test
if errorlevel 1 (
  echo.
  echo [ERROR] Test FAILED. Fix the issue above - credentials / URL / SQL / ODBC,
  echo         then re-run this setup.
  pause
  exit /b 1
)
echo [OK] Connectivity test passed

REM --- 5. Register the FOREVER schedule (every 15 min + at boot, as SYSTEM) ---
echo.
echo Registering scheduled tasks (every 15 min + at boot, forever)...
schtasks /Create /TN "EclatSync" /TR "\"%~dp0run_sync.bat\"" /SC MINUTE /MO 15 /RU SYSTEM /RL HIGHEST /F
if errorlevel 1 (
  echo [ERROR] Could not create the 15-minute task. Make sure you ran as administrator.
  pause
  exit /b 1
)
schtasks /Create /TN "EclatSync_Boot" /TR "\"%~dp0run_sync.bat\"" /SC ONSTART /RU SYSTEM /RL HIGHEST /F

REM --- 6. Kick off the first sync now ---
echo.
echo Running the first sync now...
call "%~dp0run_sync.bat"

echo.
echo ============================================================
echo   DONE - THE SYNC NOW RUNS FOREVER BY ITSELF
echo   - "EclatSync"       : every 15 minutes
echo   - "EclatSync_Boot"  : at every PC restart
echo   - Runs as SYSTEM (no login needed), survives reboots
echo   - Log:  auto_sync.log   (in this folder)
echo.
echo   To STOP it later (admin Command Prompt):
echo     schtasks /Delete /TN "EclatSync" /F
echo     schtasks /Delete /TN "EclatSync_Boot" /F
echo ============================================================
echo.
pause
endlocal
