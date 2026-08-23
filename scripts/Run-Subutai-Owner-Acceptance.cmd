@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
set "PS_SCRIPT=%SCRIPT_DIR%owner-youtube-acceptance.ps1"

if not exist "%PS_SCRIPT%" (
  echo Subutai owner acceptance script is missing: %PS_SCRIPT%
  exit /b 2
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo Subutai owner-network YouTube acceptance did not pass.
  exit /b %EXIT_CODE%
)

echo.
echo Subutai owner-network YouTube acceptance passed.
exit /b 0
