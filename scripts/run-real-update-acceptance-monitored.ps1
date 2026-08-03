param(
  [string]$BaselineVersion = '0.1.0',
  [string]$TargetVersion = '0.2.0',
  [string]$Workspace = 'artifacts/real-update-acceptance',
  [ValidateRange(120, 1800)][int]$ScenarioTimeoutSeconds = 240
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:OS -ne 'Windows_NT') { throw 'Monitored real update acceptance requires Windows.' }

$repoRoot = (Resolve-Path '.').Path
$innerScript = Join-Path $repoRoot 'scripts\run-real-update-acceptance-safely.ps1'
$workspacePath = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $Workspace))
$diagnosticRoot = Join-Path $workspacePath 'evidence\live-updater-state'
$updaterRoot = Join-Path $env:LOCALAPPDATA 'Subutai\Updater'
$electronUpdaterCache = Join-Path $env:LOCALAPPDATA '@subutaidesktop-updater'
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\@subutaidesktop'
$installedExecutable = Join-Path $installDir 'Subutai Download Manager.exe'
$stdoutPath = Join-Path $env:RUNNER_TEMP ("subutai-real-update-monitor-" + [guid]::NewGuid().ToString('N') + '.stdout.log')
$stderrPath = Join-Path $env:RUNNER_TEMP ("subutai-real-update-monitor-" + [guid]::NewGuid().ToString('N') + '.stderr.log')
$exitCodePath = Join-Path $env:RUNNER_TEMP ("subutai-real-update-monitor-" + [guid]::NewGuid().ToString('N') + '.exit-code')

function Write-Utf8NoBom {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Content)
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Copy-LiveFile {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$DestinationName
  )
  if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { return }
  $destination = Join-Path $diagnosticRoot $DestinationName
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
  try { Copy-Item -LiteralPath $Source -Destination $destination -Force -ErrorAction Stop } catch { }
}

function Get-InstalledVersion {
  if (-not (Test-Path -LiteralPath $installedExecutable -PathType Leaf)) { return $null }
  $information = (Get-Item -LiteralPath $installedExecutable).VersionInfo
  foreach ($candidate in @([string]$information.ProductVersion, [string]$information.FileVersion)) {
    if ($candidate -match '(\d+\.\d+\.\d+)') { return $Matches[1] }
  }
  return 'unknown'
}

function Capture-LiveState {
  New-Item -ItemType Directory -Force -Path $diagnosticRoot | Out-Null
  Copy-LiveFile -Source (Join-Path $updaterRoot 'update-transaction.json') -DestinationName 'update-transaction.json'
  Copy-LiveFile -Source (Join-Path $updaterRoot 'update-transaction.json.bak') -DestinationName 'update-transaction.json.bak'
  Copy-LiveFile -Source (Join-Path $updaterRoot 'watchdog-evidence.json') -DestinationName 'watchdog-evidence.json'
  Copy-LiveFile -Source (Join-Path $updaterRoot 'watchdog-launcher.log') -DestinationName 'watchdog-launcher.log'
  Copy-LiveFile -Source (Join-Path $updaterRoot 'watchdog-child.log') -DestinationName 'watchdog-child.log'
  Copy-LiveFile -Source (Join-Path $updaterRoot 'real-two-installer-acceptance.json') -DestinationName 'real-two-installer-acceptance.json'
  Copy-LiveFile -Source (Join-Path $updaterRoot 'real-two-installer-acceptance.json.bak') -DestinationName 'real-two-installer-acceptance.json.bak'
  Copy-LiveFile -Source (Join-Path $electronUpdaterCache 'pending\update-info.json') -DestinationName 'electron-updater-update-info.json'

  $processes = @(
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {
        $_.Name -in @('Subutai Download Manager.exe', 'powershell.exe', 'Subutai-Setup-0.1.0-x64.exe', 'Subutai-Setup-0.2.0-x64.exe') -or
        ([string]$_.CommandLine -match 'Subutai|update-watchdog|real-update-acceptance')
      } |
      Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine
  )

  $updaterFiles = @()
  if (Test-Path -LiteralPath $updaterRoot) {
    $updaterFiles = @(
      Get-ChildItem -LiteralPath $updaterRoot -Recurse -File -ErrorAction SilentlyContinue |
        Select-Object @{Name='relativePath';Expression={$_.FullName.Substring($updaterRoot.Length).TrimStart('\')}}, Length, LastWriteTimeUtc
    )
  }

  $snapshot = [ordered]@{
    schemaVersion = 1
    capturedAt = [DateTime]::UtcNow.ToString('o')
    installDirectoryExists = Test-Path -LiteralPath $installDir
    installedExecutableExists = Test-Path -LiteralPath $installedExecutable -PathType Leaf
    installedVersion = Get-InstalledVersion
    updaterRootExists = Test-Path -LiteralPath $updaterRoot
    electronUpdaterCacheExists = Test-Path -LiteralPath $electronUpdaterCache
    processes = $processes
    updaterFiles = $updaterFiles
  }
  Write-Utf8NoBom -Path (Join-Path $diagnosticRoot 'live-snapshot.json') -Content (($snapshot | ConvertTo-Json -Depth 12) + "`n")
}

New-Item -ItemType Directory -Force -Path $diagnosticRoot | Out-Null
$arguments = @(
  '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', $innerScript,
  '-BaselineVersion', $BaselineVersion,
  '-TargetVersion', $TargetVersion,
  '-Workspace', $Workspace,
  '-ScenarioTimeoutSeconds', [string]$ScenarioTimeoutSeconds,
  '-MonitorExitCodePath', $exitCodePath
)

$process = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -PassThru `
  -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
try {
  while (-not $process.HasExited) {
    Capture-LiveState
    Start-Sleep -Milliseconds 250
    $process.Refresh()
  }
  Capture-LiveState
  $process.WaitForExit()
  $process.Refresh()
  $nativeExitCode = $process.ExitCode
  $reportedExitCode = $null
  if (Test-Path -LiteralPath $exitCodePath -PathType Leaf) {
    $parsedExitCode = 0
    $exitCodeText = (Get-Content -LiteralPath $exitCodePath -Raw).Trim()
    if (-not [int]::TryParse($exitCodeText, [ref]$parsedExitCode) -or $parsedExitCode -notin @(0, 1)) {
      throw 'Monitored real update acceptance child wrote an invalid completion code.'
    }
    $reportedExitCode = $parsedExitCode
  }
  if ($null -ne $nativeExitCode -and $null -ne $reportedExitCode -and [int]$nativeExitCode -ne [int]$reportedExitCode) {
    throw "Monitored real update acceptance child exit codes disagreed: process=$nativeExitCode completion=$reportedExitCode."
  }
  $exitCode = if ($null -ne $nativeExitCode) { [int]$nativeExitCode } else { $reportedExitCode }

  if (Test-Path -LiteralPath $stdoutPath) { Get-Content -LiteralPath $stdoutPath | Write-Host }
  if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath | Write-Host }
  if ($null -eq $exitCode) { throw 'Monitored real update acceptance child did not expose an exit code.' }
  if ($exitCode -ne 0) { throw "Monitored real update acceptance child failed with exit code $exitCode." }
} finally {
  try { Capture-LiveState } catch { }
  Remove-Item -LiteralPath $stdoutPath, $stderrPath, $exitCodePath -Force -ErrorAction SilentlyContinue
}
