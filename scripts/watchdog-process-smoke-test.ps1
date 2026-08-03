param(
  [ValidateRange(3, 10)][int]$TimeoutSeconds = 8
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:OS -ne 'Windows_NT') { throw 'Watchdog process smoke test requires Windows.' }

$repoRoot = (Resolve-Path '.').Path
$sourceWatchdog = Join-Path $repoRoot 'apps\desktop\resources\updater\update-watchdog.ps1'
$smokeRoot = Join-Path $repoRoot ("artifacts\watchdog-process-smoke\" + [guid]::NewGuid().ToString('N'))
$stagedWatchdog = Join-Path $smokeRoot 'watchdog\update-watchdog.ps1'
$transactionPath = Join-Path $smokeRoot 'update-transaction.json'
$launcherLogPath = Join-Path $smokeRoot 'watchdog-launcher.log'
$stdoutPath = Join-Path $smokeRoot 'stdout.log'
$stderrPath = Join-Path $smokeRoot 'stderr.log'
$rollbackMarker = Join-Path $smokeRoot 'rollback-marker.txt'
$mutexName = 'Local\SubutaiUpdaterWatchdog-Smoke-' + [guid]::NewGuid().ToString('N')
$process = $null

try {
  if (-not (Test-Path -LiteralPath $sourceWatchdog -PathType Leaf)) {
    throw 'Version-controlled watchdog source is missing.'
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $stagedWatchdog) | Out-Null
  Copy-Item -LiteralPath $sourceWatchdog -Destination $stagedWatchdog

  $arguments = @(
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    $stagedWatchdog,
    '-TransactionPath',
    $transactionPath,
    '-ParentProcessId',
    '0',
    '-LauncherLogPath',
    $launcherLogPath,
    '-WatchdogMutexName',
    $mutexName,
    '-TestMode',
    '-TestAllowedInstallRoot',
    $smokeRoot,
    '-TestRollbackMarker',
    $rollbackMarker
  )
  $nativeArguments = @($arguments | ForEach-Object {
    $value = [string]$_
    if ($value -match '[\s"]') { '"' + $value.Replace('"', '\"') + '"' } else { $value }
  }) -join ' '
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = 'powershell.exe'
  $startInfo.Arguments = $nativeArguments
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { throw 'Watchdog smoke process could not be started.' }

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while (-not $process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 100
    $process.Refresh()
  }
  if (-not $process.HasExited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "Watchdog process smoke test hung beyond $TimeoutSeconds seconds."
  }
  $process.WaitForExit()
  $process.Refresh()
  [System.IO.File]::WriteAllText($stdoutPath, $process.StandardOutput.ReadToEnd())
  [System.IO.File]::WriteAllText($stderrPath, $process.StandardError.ReadToEnd())

  if (-not (Test-Path -LiteralPath $launcherLogPath -PathType Leaf)) {
    throw 'Watchdog process did not create its startup log.'
  }
  $log = Get-Content -LiteralPath $launcherLogPath -Raw
  foreach ($phase in @('watchdog-started', 'watchdog-error', 'watchdog-finished')) {
    if (-not $log.Contains($phase)) { throw "Watchdog process log is missing phase: $phase" }
  }
  if ($process.ExitCode -ne 2) {
    throw "Controlled missing-journal watchdog process exited with code $($process.ExitCode) instead of 2."
  }

  Write-Host 'Subutai watchdog process smoke test passed: direct -File launch acknowledged startup, reported a controlled error, finished, and left no orphan process.'
} catch {
  if (Test-Path -LiteralPath $launcherLogPath) { Get-Content -LiteralPath $launcherLogPath | Write-Host }
  if (Test-Path -LiteralPath $stdoutPath) { Get-Content -LiteralPath $stdoutPath | Write-Host }
  if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath | Write-Host }
  throw
} finally {
  if ($null -ne $process) {
    try {
      $process.Refresh()
      if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
    } catch { }
    $process.Dispose()
  }
  Remove-Item -LiteralPath $smokeRoot -Recurse -Force -ErrorAction SilentlyContinue
}
