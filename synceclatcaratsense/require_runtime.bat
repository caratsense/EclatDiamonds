@echo off
REM Select only the package-local reviewed runtime. Never fall back to a user's
REM global Python, whose packages can change independently of this connector.
if not exist "%~dp0verify_install_security.ps1" (
  echo [SECURITY STOP] verify_install_security.ps1 is missing.
  exit /b 20
)
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0verify_install_security.ps1" -InstallPath "%~dp0" >nul
if errorlevel 1 (
  echo [SECURITY STOP] This Gati package is not in a private, safe install folder.
  exit /b 20
)
set "PYEXE=%~dp0.venv\Scripts\python.exe"
if not exist "%PYEXE%" (
  echo [STOP] The private Gati runtime is not installed.
  echo        Open PowerShell normally in this folder and run:
  echo        powershell -ExecutionPolicy Bypass -File .\setup_runtime.ps1
  exit /b 21
)
"%PYEXE%" -c "import sys; raise SystemExit(0 if sys.version_info >= (3,10) else 1)" >nul 2>&1
if errorlevel 1 (
  echo [STOP] The private Gati runtime is damaged or unsupported.
  echo        Re-run setup_runtime.ps1 -Recreate as the normal sync user.
  exit /b 21
)
exit /b 0
