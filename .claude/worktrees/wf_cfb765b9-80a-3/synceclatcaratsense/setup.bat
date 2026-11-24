@echo off
REM ===========================================================================
REM  RETIRED COMPATIBILITY ENTRY POINT
REM
REM  The old version of this file installed packages, created SYSTEM/HIGHEST
REM  scheduled tasks, and immediately ran an unrestricted full sync. That path
REM  is intentionally disabled. It bypassed discovery, preview, sample review,
REM  source approval, and least-privilege scheduling.
REM ===========================================================================
setlocal EnableExtensions
cd /d "%~dp0"

echo.
echo ============================================================
echo   setup.bat HAS BEEN RETIRED FOR SAFETY
echo ============================================================
echo.
echo   Nothing was installed, scheduled, or uploaded.
echo.
echo   Use the reviewed workflow, in order:
echo     1_discover.bat
echo     2_configure.bat
echo     3_test.bat
echo     4_preview.bat
echo     5_first_sync.bat
echo.
echo   Check the sample in the dashboard. Only then run:
echo     install_scheduler.bat
echo.
echo   install_scheduler.bat must be run as the normal Windows user,
echo   never with "Run as administrator".
echo ============================================================
echo.
pause
endlocal
exit /b 2
