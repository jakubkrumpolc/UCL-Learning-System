@echo off
rem Serve the study site at http://127.0.0.1:8000 and open it.
setlocal
title UCL Learning System
cd /d "%~dp0.."

call :findpy py -3
if defined PY goto :run
call :findpy python
if defined PY goto :run
call :findpy python3
if defined PY goto :run

echo Python 3.7 or newer was not found.
echo Install it from https://www.python.org/downloads/
echo and tick "Add python.exe to PATH".
echo.
pause
exit /b 1

:findpy
%* -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 7) else 1)" >nul 2>&1
if errorlevel 1 exit /b 1
set "PY=%*"
exit /b 0

:run
%PY% "%~dp0serve.py" %*
if errorlevel 1 goto :failed
exit /b 0

:failed
echo.
pause
exit /b 1
