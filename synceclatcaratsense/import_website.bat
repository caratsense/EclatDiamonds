@echo off
REM ===========================================================================
REM  WEBSITE DESIGNS -> CATALOGUE
REM
REM  Brings the designs from eclatdiamonds.in into Eclat: the retouched
REM  photographs the client already publishes, and a price for designs no
REM  branch stocks.
REM
REM  Why not the shop's own picture folder? Many of those images have the
REM  measurements printed across them. Correct for the workshop, wrong for a
REM  customer.
REM
REM  Uploads nothing -- the photos are already on the website's CDN, so only
REM  the link is stored. Does not touch your jewellery system at all.
REM
REM    import_website.bat           show what would happen, send nothing
REM    import_website.bat --send    do it
REM ===========================================================================
setlocal EnableExtensions
cd /d "%~dp0"

if exist "eclat_config.bat" (call eclat_config.bat) else (
  echo [PROBLEM] eclat_config.bat missing. Run 2_configure.bat first.
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
if /I "%~1"=="--send" (
  "%PYEXE%" gati_target_safety.py backend
  if errorlevel 1 (
    echo Run 2_configure.bat and explicitly review the backend target.
    pause
    exit /b 20
  )
)

"%PYEXE%" import_website.py %*
set "IMPORT_EXIT=%ERRORLEVEL%"
if not "%IMPORT_EXIT%"=="0" (
  echo.
  echo [PROBLEM] See the message above.
)

echo.
pause
endlocal & exit /b %IMPORT_EXIT%
