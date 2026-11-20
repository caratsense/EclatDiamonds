@echo off
REM ===========================================================================
REM  STEP 3 of 5  —  CHECK THE CONNECTIONS
REM
REM  Confirms we can reach the jewellery database and the approved CaratOS
REM  backend. Sends no business rows; it does perform the restricted agent
REM  handshake/heartbeat against the explicitly approved target.
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

call "%~dp0require_runtime.bat"
if errorlevel 1 (
  pause
  exit /b 21
)

"%PYEXE%" gati_target_safety.py backend
if errorlevel 1 (
  echo Run 2_configure.bat and explicitly review the backend target.
  pause
  exit /b 20
)

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
