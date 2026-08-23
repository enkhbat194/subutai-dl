@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
set "PS_SCRIPT=%SCRIPT_DIR%owner-youtube-acceptance.ps1"
set "RETRY_SCRIPT=%SCRIPT_DIR%owner-youtube-fresh-url-retry.ps1"

if not exist "%PS_SCRIPT%" (
  echo Subutai owner acceptance script is missing: %PS_SCRIPT%
  exit /b 2
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" %*
set "EXIT_CODE=%ERRORLEVEL%"

if "%EXIT_CODE%"=="0" goto :passed

if exist "%RETRY_SCRIPT%" (
  echo.
  echo Primary YouTube acceptance did not pass. Trying bounded fresh media URL retry routes...
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%RETRY_SCRIPT%" %*
  set "EXIT_CODE=%ERRORLEVEL%"
)

if not "%EXIT_CODE%"=="0" (
  echo.
  echo Subutai owner-network YouTube acceptance did not pass.
  exit /b %EXIT_CODE%
)

:passed
echo.
echo Subutai owner-network YouTube acceptance passed.
exit /b 0
