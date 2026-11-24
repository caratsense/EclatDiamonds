@echo off
REM ===========================================================================
REM  DOES THE WEBSITE MATCH THE SHOP SYSTEM?
REM
REM  The website knows the prices and photographs. The shop system knows what is
REM  actually in each branch. To show one catalogue they have to be joined by
REM  the design code — this checks whether that works.
REM
REM  Reads the database read-only and reads the public website.
REM  Changes nothing. Uploads nothing. Needs internet.
REM ===========================================================================
setlocal EnableExtensions
cd /d "%~dp0"

echo.
echo ============================================================
echo   COMPARING THE WEBSITE WITH THE SHOP SYSTEM
echo ============================================================
echo.

if exist "eclat_config.bat" (
  call eclat_config.bat
) else (
  echo No settings file yet - run 2_configure.bat first.
  pause
  exit /b 1
)

call "%~dp0require_runtime.bat"
if errorlevel 1 (
  pause
  exit /b 21
)

"%PYEXE%" gati_target_safety.py website
if errorlevel 1 (
  echo Run 2_configure.bat and explicitly review the website feed.
  pause
  exit /b 20
)

"%PYEXE%" check_website_match.py
if errorlevel 1 (
  echo.
  echo [PROBLEM] See the message above.
  pause
  exit /b 1
)

echo.
echo ============================================================
echo   DONE. Report written to:
echo     reports\website_match.txt
echo.
echo   Send that file to the Eclat team.
echo ============================================================
echo.
pause
endlocal
