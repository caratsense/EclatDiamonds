@echo off
REM ===========================================================================
REM  STEP 2 of 5  —  ANSWER A FEW QUESTIONS
REM
REM  Asks for the connection details and writes eclat_config.bat for you.
REM
REM  The questions are asked by configure.py rather than by this file. cmd's
REM  own `set /p` does FILENAME COMPLETION on a Tab character, so a tab inside
REM  a pasted value silently injects a filename into the middle of the answer —
REM  which is exactly how an R2 key once became
REM  "1_discover.bat4155a8a1f5f56dbf...". Python's input() does not do that, and
REM  it can check each value looks right before saving.
REM ===========================================================================
setlocal EnableExtensions
cd /d "%~dp0"

call "%~dp0require_runtime.bat"
if errorlevel 1 (
  pause
  exit /b 21
)

"%PYEXE%" configure.py
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)

echo.
echo Now checking that everything connects...
echo.
call "3_test.bat"
set "TEST_EXIT=%ERRORLEVEL%"
endlocal & exit /b %TEST_EXIT%
