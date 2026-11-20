@echo off
REM ===========================================================================
REM  LAST STEP - MAKE AN ALREADY-VERIFIED SYNC AUTOMATIC
REM
REM  Run this only after discovery, preview, a controlled first send, and a
REM  dashboard review. Run it normally as the intended Windows sync user.
REM  DO NOT use "Run as administrator".
REM ===========================================================================
setlocal EnableExtensions
cd /d "%~dp0"

echo.
echo ============================================================
echo   MAKE THE VERIFIED SYNC AUTOMATIC - LEAST PRIVILEGE
echo ============================================================
echo.

if not exist "verify_install_security.ps1" (
  echo [STOP] verify_install_security.ps1 is missing.
  exit /b 1
)
if not exist "register_scheduler.ps1" (
  echo [STOP] register_scheduler.ps1 is missing.
  exit /b 1
)

powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0verify_install_security.ps1" -InstallPath "%CD%"
if errorlevel 1 (
  echo.
  echo [STOP] The account or install folder is unsafe for scheduling.
  echo        See ONSITE-RUNBOOK.md. Nothing was scheduled.
  pause
  exit /b 1
)

if not exist "eclat_config.bat" (
  echo [STOP] No settings. Run 2_configure.bat first.
  pause
  exit /b 1
)
if not exist "reports\discovery_report.txt" (
  echo [STOP] No discovery report. Run 1_discover.bat and review its report.
  pause
  exit /b 1
)
if not exist "logs\auto_sync.log" (
  echo [STOP] No reviewed sync log. Run steps 4 and 5 first.
  pause
  exit /b 1
)
findstr /C:"Sync complete" "logs\auto_sync.log" >nul 2>&1
if errorlevel 1 (
  echo [STOP] No completed sync is recorded. Run and review 5_first_sync.bat.
  pause
  exit /b 1
)
if not exist "reports\full_sync_completed.txt" (
  echo [STOP] No successful full-run receipt exists.
  echo        Run 5_first_sync.bat all, then review the dashboard.
  pause
  exit /b 1
)
powershell.exe -NoLogo -NoProfile -NonInteractive -Command "$receipt = (Get-Item -LiteralPath 'reports\full_sync_completed.txt').LastWriteTimeUtc; $reviewedInputs = @('eclat_config.bat','gati_machine_auth.py','sync_sjep.py','sync_media.py','import_website.py'); if (Test-Path -LiteralPath 'stage_map.json' -PathType Leaf) { $reviewedInputs += 'stage_map.json' }; if ($reviewedInputs | Where-Object { (Get-Item -LiteralPath $_).LastWriteTimeUtc -gt $receipt }) { exit 1 }"
if errorlevel 1 (
  echo [STOP] Settings, mapping code, or stage mapping changed after the last full manual sync.
  echo        Re-run 5_first_sync.bat all and review the result.
  pause
  exit /b 1
)

call "eclat_config.bat"
if not defined CARATOS_AGENT_TOKEN (
  echo [STOP] CARATOS_AGENT_TOKEN is missing. Run 2_configure.bat.
  echo        Never replace it with a human email/password.
  pause
  exit /b 1
)

call "%~dp0require_runtime.bat"
if errorlevel 1 (
  pause
  exit /b 21
)

echo.
echo Rechecking the approved agent, database, and mapping contract...
"%PYEXE%" sync_sjep.py --test
if errorlevel 1 (
  echo [STOP] Connection/agent approval check failed. Nothing was scheduled.
  pause
  exit /b 1
)
"%PYEXE%" sync_sjep.py --dry-run
if errorlevel 1 (
  echo [STOP] Fresh preview failed. Nothing was scheduled.
  pause
  exit /b 1
)

echo.
echo This installer NEVER sends a full sync. It will only register the
echo already-reviewed job for the CURRENT Windows user at LIMITED privilege.
echo The job runs while that same user is signed in; it never runs as SYSTEM.
echo.
set "SCHEDULE_CONFIRM="
set /p SCHEDULE_CONFIRM="Type SCHEDULE APPROVED to continue: "
if not "%SCHEDULE_CONFIRM%"=="SCHEDULE APPROVED" (
  echo Stopped. Nothing was scheduled.
  pause
  exit /b 1
)

powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0register_scheduler.ps1"
if errorlevel 1 (
  echo.
  echo [STOP] The task was not registered. Read the error above.
  echo        Do not rerun this installer as administrator.
  pause
  exit /b 1
)

echo.
echo ============================================================
echo   INSTALLED SAFELY
echo   - Task: EclatSync
echo   - Every 15 minutes while this Windows user is signed in
echo   - Also runs once when this user signs in
echo   - Interactive user + LIMITED privilege; never SYSTEM/HIGHEST
echo   - No full sync was started by this installer
echo   - Log: logs\auto_sync.log
echo ============================================================
echo.
pause
endlocal
exit /b 0
