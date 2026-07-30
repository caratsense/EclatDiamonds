@echo off
REM ===========================================================================
REM  STEP 3 of 5  —  CHECK THE CONNECTIONS
REM
REM  Confirms we can reach the jewellery database and the Eclat dashboard.
REM  Sends nothing, changes nothing.
REM ===========================================================================
setlocal EnableExtensions
cd /d "%~dp0"

echo.
echo ============================================================
echo   STEP 3 of 5 - CONNECTION CHECK
echo ============================================================
echo.

if not exist "eclat_config.bat" (
  echo [PROBLEM] No settings yet. Run 2_configure.bat first.
  pause
  exit /b 1
)
call eclat_config.bat

if exist "_pyexe.bat" (call "_pyexe.bat") else (set "PYEXE=python")

"%PYEXE%" sync_sjep.py --test
if errorlevel 1 (
  echo.
  echo [PROBLEM] Something did not connect. The message above says which.
  echo.
  echo   Cannot reach the database  - wrong server name, or ODBC Driver 17
  echo                                is not installed
  echo   Login failed               - wrong database username/password
  echo   Cannot reach Eclat         - wrong address, email or password
  echo.
  pause
  exit /b 1
)

echo.
echo ============================================================
echo   BOTH CONNECTIONS OK.
echo   Next: 4_preview.bat - shows what WOULD be sent, sends nothing.
echo ============================================================
echo.
pause
endlocal
