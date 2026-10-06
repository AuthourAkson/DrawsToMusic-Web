@echo off
setlocal
cd /d "%~dp0"
echo ================================================
echo   DrawMusic
echo ================================================
echo.

set PYEXE=
where py >nul 2>nul && set PYEXE=py
if not defined PYEXE where python >nul 2>nul && set PYEXE=python

if defined PYEXE (
  echo Starting a local server on port 8777 ...
  start "DrawMusic server" /min %PYEXE% -m http.server 8777
  timeout /t 2 /nobreak >nul
  start "" "http://localhost:8777/index.html"
  echo.
  echo Opened in your browser: http://localhost:8777/index.html
  echo The server runs in the minimized window "DrawMusic server".
  echo Close that window to stop the server.
) else (
  echo Python not found. Opening the file directly instead...
  start "" "%~dp0index.html"
  echo.
  echo If nothing opened, just double-click index.html in this folder.
)

echo.
echo You can close this window now.
pause >nul
