@echo off
REM ===========================================================================
REM  STEP 1 of 5  —  LOOK, DON'T TOUCH
REM
REM  Reads the jewellery database and writes a report. It does NOT change
REM  anything in your system and does NOT send anything anywhere.
REM
REM  Safe to run any time, as many times as you like.
REM ===========================================================================
setlocal EnableExtensions
cd /d "%~dp0"

echo.
echo ============================================================
echo   STEP 1 of 5 - READING YOUR SYSTEM (nothing is changed)
echo ============================================================
echo.

if not exist "eclat_config.bat" (
  echo No settings file yet - that's fine for this step.
  echo Using the default server name. If it cannot connect, run
  echo 2_configure.bat first and then come back here.
  echo.
) else (
  call eclat_config.bat
)

if exist "_pyexe.bat" (call "_pyexe.bat") else (set "PYEXE=python")

"%PYEXE%" discover.py
if errorlevel 1 (
  echo.
  echo [PROBLEM] Could not read the database. See the message above.
  echo           Usually: wrong server name, or the ODBC driver is missing.
  pause
  exit /b 1
)

echo.
echo ============================================================
echo   DONE. A report has been written to:
echo     reports\discovery_report.txt
echo.
echo   SEND THAT FILE TO THE ECLAT TEAM AND WAIT FOR CONFIRMATION
echo   before running step 3.
echo ============================================================
echo.
pause
endlocal
