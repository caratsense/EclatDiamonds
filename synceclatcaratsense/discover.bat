@echo off
REM ===========================================================================
REM  Eclat / CaratSense — STEP 1: DISCOVERY  (read-only, changes nothing)
REM
REM  Run this only as part of the numbered, reviewed workflow. setup.bat is retired.
REM  It reads the live database read-only and reports:
REM    - how much data is there
REM    - which manufacturing status codes and departments this install uses
REM    - where the jewellery photos are kept
REM  It writes discovery_report.txt for the Eclat team and a draft stage_map.
REM  It uploads nothing and changes nothing.
REM ===========================================================================
cd /d "%~dp0"

if not exist "eclat_config.bat" (
  echo [ERROR] eclat_config.bat not found.
  echo         Copy eclat_config.example.bat to eclat_config.bat and fill in the
  echo         SQL Server lines, then run this again.
  pause
  exit /b 1
)
call eclat_config.bat

call "%~dp0require_runtime.bat"
if errorlevel 1 (
  pause
  exit /b 21
)

"%PYEXE%" discover.py
set RC=%ERRORLEVEL%

echo.
if "%RC%"=="0" (
  echo ============================================================
  echo   DISCOVERY DONE
  echo   Send  discovery_report.txt  to the Eclat team.
  echo   Then review stage_map.suggested.json, and when the stages
  echo   are confirmed, save it as  stage_map.json
  echo ============================================================
) else (
  echo [ERROR] Discovery failed - see the message above and discovery_report.txt
)
echo.
pause
exit /b %RC%
