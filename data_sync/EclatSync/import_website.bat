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
if exist "_pyexe.bat" (call "_pyexe.bat") else (set "PYEXE=python")

"%PYEXE%" import_website.py %*
if errorlevel 1 (
  echo.
  echo [PROBLEM] See the message above.
)

echo.
pause
endlocal
