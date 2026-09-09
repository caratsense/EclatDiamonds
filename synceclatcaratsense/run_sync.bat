@echo off
REM ===========================================================================
REM  One approved sync cycle. The EclatSync task invokes this as the explicit
REM  interactive Windows user at LIMITED privilege. It refuses service accounts,
REM  elevation, linked/network installs, and install folders readable by another
REM  local/domain principal.
REM ===========================================================================
setlocal EnableExtensions
cd /d "%~dp0"

if not exist "verify_install_security.ps1" (
  echo [SECURITY STOP] verify_install_security.ps1 is missing.
  endlocal
  exit /b 20
)
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0verify_install_security.ps1" -InstallPath "%CD%" >nul
if errorlevel 1 (
  echo [SECURITY STOP] Unsafe account or install-directory permissions.
  endlocal
  exit /b 20
)

if not exist "eclat_config.bat" (
  echo [ERROR] eclat_config.bat missing. Run 2_configure.bat first.
  endlocal
  exit /b 1
)
call "eclat_config.bat"

if not defined CARATOS_AGENT_TOKEN (
  echo [ERROR] CARATOS_AGENT_TOKEN missing. Run 2_configure.bat.
  endlocal
  exit /b 1
)

call "%~dp0require_runtime.bat"
if errorlevel 1 (
  endlocal
  exit /b 21
)

"%PYEXE%" gati_target_safety.py backend
if errorlevel 1 (
  echo [SAFETY STOP] Backend target is missing or differs from its explicit approval.
  endlocal
  exit /b 20
)

"%PYEXE%" sync_sjep.py
set "SYNC_EXIT=%ERRORLEVEL%"
endlocal & exit /b %SYNC_EXIT%
