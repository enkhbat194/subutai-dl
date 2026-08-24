@echo off
setlocal EnableExtensions
set "SCRIPT_DIR=%~dp0"
set "PS_SCRIPT=%SCRIPT_DIR%owner-youtube-acceptance.ps1"
set "RETRY_SCRIPT=%SCRIPT_DIR%owner-youtube-fresh-url-retry.ps1"
set "UA_RETRY_SCRIPT=%SCRIPT_DIR%owner-youtube-browser-ua-retry.ps1"
set "WPC_RETRY_SCRIPT=%SCRIPT_DIR%owner-youtube-wpc-retry.ps1"
set "PACKAGED_EXE="

rem Test/diagnostic override. Normal owner use leaves this unset.
if defined SUBUTAI_OWNER_ACCEPTANCE_EXE if exist "%SUBUTAI_OWNER_ACCEPTANCE_EXE%" set "PACKAGED_EXE=%SUBUTAI_OWNER_ACCEPTANCE_EXE%"

rem Prefer the real packaged application path so owner acceptance exercises Electron's
rem resource resolution and packaged media environment before the PowerShell fallback.
if not defined PACKAGED_EXE if exist "%SCRIPT_DIR%..\..\Subutai Download Manager.exe" set "PACKAGED_EXE=%SCRIPT_DIR%..\..\Subutai Download Manager.exe"
if not defined PACKAGED_EXE if exist "%LOCALAPPDATA%\Programs\Subutai Download Manager\Subutai Download Manager.exe" set "PACKAGED_EXE=%LOCALAPPDATA%\Programs\Subutai Download Manager\Subutai Download Manager.exe"
if not defined PACKAGED_EXE for %%F in ("%SCRIPT_DIR%Subutai-Portable-*.exe") do if exist "%%~fF" if not defined PACKAGED_EXE set "PACKAGED_EXE=%%~fF"

if not defined PACKAGED_EXE goto :direct_primary

echo Running owner acceptance through packaged Subutai application:
echo   %PACKAGED_EXE%
"%PACKAGED_EXE%" --subutai-owner-youtube-acceptance
if errorlevel 1 goto :packaged_failed
goto :passed

:packaged_failed
echo.
echo Packaged application acceptance did not pass. Falling back to direct packaged scripts for diagnostics...

:direct_primary
if not exist "%PS_SCRIPT%" goto :missing_primary
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" %*
if errorlevel 1 goto :try_retry
goto :passed

:try_retry
set "EXIT_CODE=%ERRORLEVEL%"
if not exist "%RETRY_SCRIPT%" goto :try_ua_retry
echo.
echo Primary YouTube acceptance did not pass. Trying bounded fresh media URL retry routes...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%RETRY_SCRIPT%" %*
set "EXIT_CODE=%ERRORLEVEL%"
if "%EXIT_CODE%"=="0" goto :passed

:try_ua_retry
if not exist "%UA_RETRY_SCRIPT%" goto :try_wpc_retry
echo.
echo Fresh media URL routes did not pass. Trying browser cookies with matching browser User-Agent...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%UA_RETRY_SCRIPT%" %*
set "EXIT_CODE=%ERRORLEVEL%"
if "%EXIT_CODE%"=="0" goto :passed

:try_wpc_retry
if not exist "%WPC_RETRY_SCRIPT%" goto :failed
echo.
echo Browser cookie routes did not pass. Trying packaged browser-minted WPC PO-token fallback...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%WPC_RETRY_SCRIPT%" %*
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" goto :failed
goto :passed

:missing_primary
echo Subutai owner acceptance script is missing: %PS_SCRIPT%
exit /b 2

:failed
echo.
echo Subutai owner-network YouTube acceptance did not pass.
exit /b %EXIT_CODE%

:passed
echo.
echo Subutai owner-network YouTube acceptance passed.
exit /b 0
