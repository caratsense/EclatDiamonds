@echo off
REM ===========================================================================
REM  WHAT IS ACTUALLY IN THE JEWELLERY SOFTWARE FOLDER
REM
REM  Looks at every file under D:\GATISOFTTECH and reports what is there:
REM  how many photographs and how big they are, which backups exist and how
REM  old, which printed forms they use, and anything that might hold a
REM  password.
REM
REM  It only looks at names, sizes and dates. It does not open, copy, move or
REM  change a single file, and it uploads nothing.
REM
REM  Different folder?   inspect_files.bat "D:\SomewhereElse"
REM ===========================================================================
setlocal EnableExtensions
cd /d "%~dp0"

echo.
echo ============================================================
echo   LOOKING AT THE FILES (nothing is changed)
echo ============================================================
echo.

if exist "eclat_config.bat" call eclat_config.bat
call "%~dp0require_runtime.bat"
if errorlevel 1 (
  pause
  exit /b 21
)

set "TARGET=%~1"
if "%TARGET%"=="" set "TARGET=D:\GATISOFTTECH"

echo Folder: %TARGET%
echo.

"%PYEXE%" inspect_files.py "%TARGET%"
if errorlevel 1 (
  echo.
  echo [PROBLEM] See the message above.
  pause
  exit /b 1
)

echo.
echo ============================================================
echo   DONE. Report written to:
echo     reports\file_inventory.txt
echo.
echo   Send that file to the Eclat team.
echo ============================================================
echo.
pause
endlocal
