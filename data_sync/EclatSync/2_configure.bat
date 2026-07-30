@echo off
REM ===========================================================================
REM  STEP 2 of 5  —  ANSWER A FEW QUESTIONS
REM
REM  Asks for the connection details and writes eclat_config.bat for you.
REM  Typing them into a file by hand is where most installation problems come
REM  from, so this does it instead.
REM ===========================================================================
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

echo.
echo ============================================================
echo   STEP 2 of 5 - SETTINGS
echo ============================================================
echo.

if exist "eclat_config.bat" (
  echo A settings file already exists.
  set /p OVERWRITE="Replace it? (y/N): "
  if /I not "!OVERWRITE!"=="y" (
    echo Keeping the existing file. Nothing changed.
    pause
    exit /b 0
  )
  copy /y "eclat_config.bat" "eclat_config.backup.bat" >nul
  echo Old settings saved as eclat_config.backup.bat
  echo.
)

echo --- YOUR JEWELLERY DATABASE ---
echo.
echo Server name. Press ENTER for the usual value.
set "SQLSRV=localhost\SQLEXPRESS"
set /p SQLSRV="  SQL Server [localhost\SQLEXPRESS]: "

set "SQLDB=APRSSJEP"
set /p SQLDB="  Database name [APRSSJEP]: "

echo.
echo Database login. Your IT person can create a read-only one by
echo running create_readonly_login.sql - that is the recommended way.
echo.
echo   IMPORTANT: leaving these blank uses the Windows login, which
echo   usually FAILS once the sync runs automatically in the
echo   background. Use a database login unless told otherwise.
echo.
set "SQLUSER="
set /p SQLUSER="  Database username: "
set "SQLPASS="
if defined SQLUSER set /p SQLPASS="  Database password: "

echo.
echo --- YOUR ECLAT DASHBOARD ---
echo.
set "ECURL=https://backend-production-89dd.up.railway.app"
set /p ECURL="  Eclat address [%ECURL%]: "
set "ECMAIL="
set /p ECMAIL="  Eclat sync email: "
set "ECPASS="
set /p ECPASS="  Eclat sync password: "

echo.
echo --- PHOTOGRAPHS (optional, you can fill this in later) ---
echo.
echo Leave blank for now - step 1 finds the folder for you.
set "IMGROOT="
set /p IMGROOT="  Photo folder: "

echo.
echo --- PHOTO STORAGE (given to you by the Eclat team) ---
echo.
set "R2ACC="
set /p R2ACC="  R2 account id: "
set "R2KEY="
set /p R2KEY="  R2 access key id: "
set "R2SEC="
set /p R2SEC="  R2 secret key: "
set "R2BUCKET=eclat-media"
set /p R2BUCKET="  R2 bucket [eclat-media]: "
set "R2URL="
set /p R2URL="  R2 public address: "

REM Written fresh each time so a half-edited old file cannot leak through.
> "eclat_config.bat" echo @echo off
>>"eclat_config.bat" echo REM Written by 2_configure.bat - contains passwords, keep private.
>>"eclat_config.bat" echo set "ECLAT_BASE_URL=%ECURL%"
>>"eclat_config.bat" echo set "ECLAT_EMAIL=%ECMAIL%"
>>"eclat_config.bat" echo set "ECLAT_PASSWORD=%ECPASS%"
>>"eclat_config.bat" echo set "SJEP_SQL_SERVER=%SQLSRV%"
>>"eclat_config.bat" echo set "SJEP_SQL_DB=%SQLDB%"
>>"eclat_config.bat" echo set "SJEP_SQL_USER=%SQLUSER%"
>>"eclat_config.bat" echo set "SJEP_SQL_PASS=%SQLPASS%"
>>"eclat_config.bat" echo set "SJEP_IMAGE_ROOT=%IMGROOT%"
>>"eclat_config.bat" echo set "R2_ACCOUNT_ID=%R2ACC%"
>>"eclat_config.bat" echo set "R2_ACCESS_KEY_ID=%R2KEY%"
>>"eclat_config.bat" echo set "R2_SECRET_ACCESS_KEY=%R2SEC%"
>>"eclat_config.bat" echo set "R2_BUCKET=%R2BUCKET%"
>>"eclat_config.bat" echo set "R2_PUBLIC_BASE_URL=%R2URL%"

echo.
echo Settings saved.
echo.

if not defined SQLUSER (
  echo ************************************************************
  echo   WARNING: no database login was given.
  echo   The test below may pass, but the automatic sync will
  echo   probably FAIL later, because it runs as the computer
  echo   rather than as you. Ask IT to run create_readonly_login.sql
  echo   and run this step again.
  echo ************************************************************
  echo.
)

echo Now checking that everything connects...
echo.
call "3_test.bat"
endlocal
