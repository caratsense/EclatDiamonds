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

REM The parts Python needs to talk to SQL Server. Installed here because this is
REM the FIRST script anyone runs — the old installer did it, and moving the
REM scheduler to the end left nothing installing them at all.
REM Quick no-op once they are present, so re-running costs nothing.
"%PYEXE%" -c "import pyodbc, requests" >nul 2>&1
if errorlevel 1 (
  echo First run - installing the parts Python needs. This takes a minute...
  echo.
  "%PYEXE%" -m pip install -r requirements.txt
  if errorlevel 1 (
    echo.
    echo [PROBLEM] Could not install. Usually no internet, or a company proxy.
    echo           Python itself is fine - it is the download that failed.
    pause
    exit /b 1
  )
  echo.
)

"%PYEXE%" discover.py
if errorlevel 1 (
  echo.
  echo [PROBLEM] Could not read the database. See the message above.
  echo           Usually: wrong server name, or the ODBC driver is missing.
  pause
  exit /b 1
)

REM The files, straight after the database, in the same step.
REM
REM This used to be a separate script anyone could forget to run - and it was
REM forgotten, which left the photographs an unknown right up to go-live week.
REM The database says which pictures the catalogue REFERS to; only the disk says
REM which of them exist. Half a job either way, so they are now one job.
echo.
echo ------------------------------------------------------------
echo   Now looking at the FILES on this computer...
echo ------------------------------------------------------------
echo.

set "FILEROOT=%SJEP_IMAGE_ROOT%"
if not defined FILEROOT set "FILEROOT=D:\GATISOFTTECH"
if not exist "%FILEROOT%" set "FILEROOT=C:\GATISOFTTECH"

if exist "%FILEROOT%" (
  "%PYEXE%" inspect_files.py "%FILEROOT%"
) else (
  echo   Could not find the jewellery software folder automatically.
  echo   Not a failure - the database report above is still complete.
  echo   If you know where it is, run:  inspect_files.bat "D:\Wherever"
)

echo.
echo ============================================================
echo   DONE. Two reports have been written:
echo     reports\discovery_report.txt   (the database)
echo     reports\file_inventory.txt     (the files and photographs)
echo.
echo   SEND BOTH FILES TO THE ECLAT TEAM AND WAIT FOR CONFIRMATION
echo   before running step 3.
echo ============================================================
echo.
pause
endlocal
