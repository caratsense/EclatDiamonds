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

if exist "_pyexe.bat" (call "_pyexe.bat") else (set "PYEXE=python")

"%PYEXE%" -c "import pyodbc, requests" >nul 2>&1
if errorlevel 1 (
  echo Installing the parts Python needs...
  "%PYEXE%" -m pip install -r requirements.txt
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
