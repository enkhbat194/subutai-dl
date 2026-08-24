@echo off
setlocal EnableExtensions
set "SCRIPT_DIR=%~dp0"
set "PS_SCRIPT=%SCRIPT_DIR%owner-youtube-acceptance.ps1"
set "RETRY_SCRIPT=%SCRIPT_DIR%owner-youtube-fresh-url-retry.ps1"
set "PACKAGED_EXE="

rem Prefer the real packaged application path so owner acceptance exercises Electron's
rem resource resolution and packaged media environment before the PowerShell fallback.
if exist "%SCRIPT_DIR%..\..\Subutai Download Manager.exe" set "PACKAGED_EXE=%SCRIPT_DIR%..\..\Subutai Download Manager.exe"
if not defined PACKAGED_EXE if exist "%LOCALAPPDATA%\Programs\Subutai Download Manager\Subutai Download Manager.exe" set "PACKAGED_EXE=%LOCALAPPDATA%\Programs\Subutai Download Manager\Subutai Download Manager.exe"
if not defined PACKAGED_EXE for %%F in ("%SCRIPT_DIR%Subutai-Portable-*.exe") do if exist "%%~fF" if not defined PACKAGED_EXE set "PACKAGED_EXE=%%~fF"

if defined PACKAGED_EXE (
  echo Running owner acceptance through packaged Subutai application:
  echo   %PACKAGED_EXE%
  "%PACKAGED_EXE%" --subutai-owner-youtube-acceptance
  set "EXIT_CODE=%ERRORLEVEL%"
  if "%EXIT_CODE%"=="0" goto :passed
  echo.
  echo Packaged application acceptance did not pass. Falling back to direct packaged scripts for diagnostics...
)

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
