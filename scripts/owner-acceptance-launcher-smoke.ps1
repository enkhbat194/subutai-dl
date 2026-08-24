param(
  [string]$LauncherPath = "scripts/Run-Subutai-Owner-Acceptance.cmd"
)

$ErrorActionPreference = "Stop"

$launcher = (Resolve-Path $LauncherPath).Path
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("SubutaiOwnerLauncherSmoke-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

try {
  $launcherCopy = Join-Path $tempRoot "Run-Subutai-Owner-Acceptance.cmd"
  Copy-Item $launcher $launcherCopy -Force

  $primaryScript = Join-Path $tempRoot "owner-youtube-acceptance.ps1"
  $retryScript = Join-Path $tempRoot "owner-youtube-fresh-url-retry.ps1"
  @'
if ($env:SUBUTAI_PRIMARY_MARKER) {
  Add-Content -LiteralPath $env:SUBUTAI_PRIMARY_MARKER -Value "primary"
}
exit [int]$env:SUBUTAI_PRIMARY_EXIT
'@ | Set-Content -LiteralPath $primaryScript -Encoding UTF8
  @'
if ($env:SUBUTAI_RETRY_MARKER) {
  Add-Content -LiteralPath $env:SUBUTAI_RETRY_MARKER -Value "retry"
}
exit [int]$env:SUBUTAI_RETRY_EXIT
'@ | Set-Content -LiteralPath $retryScript -Encoding UTF8

  $fakeExe = Join-Path $tempRoot "fake-subutai.exe"
  $fakeSource = @'
using System;
using System.IO;
public static class Program {
  public static int Main(string[] args) {
    var marker = Environment.GetEnvironmentVariable("SUBUTAI_PACKAGED_MARKER");
    if (!string.IsNullOrWhiteSpace(marker)) File.AppendAllText(marker, "packaged" + Environment.NewLine);
    var raw = Environment.GetEnvironmentVariable("SUBUTAI_FAKE_PACKAGED_EXIT");
    return int.TryParse(raw, out var code) ? code : 0;
  }
}
'@
  Add-Type -TypeDefinition $fakeSource -Language CSharp -OutputAssembly $fakeExe -OutputType ConsoleApplication

  function Invoke-LauncherCase {
    param(
      [Parameter(Mandatory = $true)][string]$Name,
      [Parameter(Mandatory = $true)][int]$PackagedExit,
      [Parameter(Mandatory = $true)][int]$PrimaryExit,
      [Parameter(Mandatory = $true)][int]$RetryExit,
      [Parameter(Mandatory = $true)][int]$ExpectedExit,
      [Parameter(Mandatory = $true)][bool]$ExpectPrimary,
      [Parameter(Mandatory = $true)][bool]$ExpectRetry
    )

    $packagedMarker = Join-Path $tempRoot "$Name-packaged.marker"
    $primaryMarker = Join-Path $tempRoot "$Name-primary.marker"
    $retryMarker = Join-Path $tempRoot "$Name-retry.marker"
    Remove-Item $packagedMarker, $primaryMarker, $retryMarker -Force -ErrorAction SilentlyContinue

    $env:SUBUTAI_OWNER_ACCEPTANCE_EXE = $fakeExe
    $env:SUBUTAI_FAKE_PACKAGED_EXIT = [string]$PackagedExit
    $env:SUBUTAI_PRIMARY_EXIT = [string]$PrimaryExit
    $env:SUBUTAI_RETRY_EXIT = [string]$RetryExit
    $env:SUBUTAI_PACKAGED_MARKER = $packagedMarker
    $env:SUBUTAI_PRIMARY_MARKER = $primaryMarker
    $env:SUBUTAI_RETRY_MARKER = $retryMarker

    & $env:ComSpec /d /c ('"' + $launcherCopy + '"')
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne $ExpectedExit) {
      throw "$Name returned $exitCode; expected $ExpectedExit."
    }
    if (-not (Test-Path $packagedMarker)) {
      throw "$Name did not invoke the packaged application path."
    }
    if ((Test-Path $primaryMarker) -ne $ExpectPrimary) {
      throw "$Name primary-script execution mismatch. Expected=$ExpectPrimary."
    }
    if ((Test-Path $retryMarker) -ne $ExpectRetry) {
      throw "$Name retry-script execution mismatch. Expected=$ExpectRetry."
    }
    Write-Host "$Name passed. exit=$exitCode primary=$ExpectPrimary retry=$ExpectRetry"
  }

  Invoke-LauncherCase -Name "packaged-pass" -PackagedExit 0 -PrimaryExit 9 -RetryExit 9 -ExpectedExit 0 -ExpectPrimary $false -ExpectRetry $false
  Invoke-LauncherCase -Name "primary-fallback-pass" -PackagedExit 7 -PrimaryExit 0 -RetryExit 9 -ExpectedExit 0 -ExpectPrimary $true -ExpectRetry $false
  Invoke-LauncherCase -Name "retry-fallback-pass" -PackagedExit 7 -PrimaryExit 8 -RetryExit 0 -ExpectedExit 0 -ExpectPrimary $true -ExpectRetry $true
  Invoke-LauncherCase -Name "all-fail" -PackagedExit 7 -PrimaryExit 8 -RetryExit 9 -ExpectedExit 9 -ExpectPrimary $true -ExpectRetry $true

  Write-Host "Owner acceptance CMD launcher control-flow smoke passed."
} finally {
  Remove-Item Env:SUBUTAI_OWNER_ACCEPTANCE_EXE -ErrorAction SilentlyContinue
  Remove-Item Env:SUBUTAI_FAKE_PACKAGED_EXIT -ErrorAction SilentlyContinue
  Remove-Item Env:SUBUTAI_PRIMARY_EXIT -ErrorAction SilentlyContinue
  Remove-Item Env:SUBUTAI_RETRY_EXIT -ErrorAction SilentlyContinue
  Remove-Item Env:SUBUTAI_PACKAGED_MARKER -ErrorAction SilentlyContinue
  Remove-Item Env:SUBUTAI_PRIMARY_MARKER -ErrorAction SilentlyContinue
  Remove-Item Env:SUBUTAI_RETRY_MARKER -ErrorAction SilentlyContinue
  Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
