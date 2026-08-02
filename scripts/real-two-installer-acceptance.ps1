param(
  [string]$BaselineVersion = '0.1.0',
  [string]$TargetVersion = '0.2.0',
  [string]$Workspace = 'artifacts/real-update-acceptance',
  [ValidateRange(120, 1800)][int]$ScenarioTimeoutSeconds = 600,
  [switch]$KeepWorkspace
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:OS -ne 'Windows_NT') { throw 'Real two-installer acceptance requires Windows.' }
if ($BaselineVersion -notmatch '^\d+\.\d+\.\d+$' -or $TargetVersion -notmatch '^\d+\.\d+\.\d+$') {
  throw 'Baseline and target versions must be stable semantic versions.'
}
if ([version]$TargetVersion -le [version]$BaselineVersion) {
  throw 'Target version must be greater than baseline version.'
}

$repoRoot = (Resolve-Path '.').Path
$workspacePath = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $Workspace))
$buildsRoot = Join-Path $workspacePath 'builds'
$evidenceRoot = Join-Path $workspacePath 'evidence'
$logsRoot = Join-Path $workspacePath 'logs'
$feedRoot = Join-Path $workspacePath 'feed'
$backupRoot = Join-Path $workspacePath 'pre-existing-state'
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\SubutaiRealUpdateAcceptance'
$userDataDir = Join-Path $env:APPDATA 'Subutai Download Manager'
$downloadsDir = Join-Path $workspacePath 'downloads'
$updaterRoot = Join-Path $env:LOCALAPPDATA 'Subutai\Updater'
$nativeMessagingDir = Join-Path $env:LOCALAPPDATA 'Subutai Download Manager\NativeMessaging'
$installedExecutable = Join-Path $installDir 'Subutai Download Manager.exe'
$journalPath = Join-Path $updaterRoot 'update-transaction.json'
$watchdogEvidencePath = Join-Path $updaterRoot 'watchdog-evidence.json'
$stateProbe = Join-Path $repoRoot 'scripts\real-update-state-probe.mjs'
$feedServerScript = Join-Path $repoRoot 'scripts\real-update-feed-server.mjs'
$registryKeys = @(
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.subutai.download_manager',
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.subutai.download_manager',
  'HKCU:\Software\Mozilla\NativeMessagingHosts\com.subutai.download_manager'
)
$versionedSourceFiles = @(
  'package.json',
  'apps\desktop\package.json',
  'apps\extension\package.json',
  'apps\extension\chromium\manifest.json',
  'apps\extension\firefox\manifest.json'
)
$sourceBackups = @{}
$directoryBackups = @{}
$registryBackup = @()
$serverProcesses = New-Object System.Collections.Generic.List[System.Diagnostics.Process]
$scenarioEvidence = New-Object System.Collections.Generic.List[object]
$buildEvidence = [ordered]@{}

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [string]$WorkingDirectory = $repoRoot
  )
  Push-Location $WorkingDirectory
  try {
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "$FilePath $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
    }
  } finally {
    Pop-Location
  }
}

function Write-Utf8NoBom {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Content)
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Write-JsonFile {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)]$Value)
  Write-Utf8NoBom -Path $Path -Content (($Value | ConvertTo-Json -Depth 40) + "`n")
}

function Get-Sha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-Sha512Base64 {
  param([Parameter(Mandatory = $true)][string]$Path)
  $algorithm = [System.Security.Cryptography.SHA512]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try { return [Convert]::ToBase64String($algorithm.ComputeHash($stream)) }
  finally { $stream.Dispose(); $algorithm.Dispose() }
}

function Get-ExecutableVersion {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Executable is missing: $Path" }
  $information = (Get-Item -LiteralPath $Path).VersionInfo
  foreach ($candidate in @([string]$information.ProductVersion, [string]$information.FileVersion)) {
    if ($candidate -match '(\d+\.\d+\.\d+)') { return $Matches[1] }
  }
  throw "Could not read a semantic version from $Path."
}

function Set-JsonVersion {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Version)
  $json = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  $json.version = $Version
  Write-JsonFile -Path $Path -Value $json
}

function Set-SourceVersion {
  param([Parameter(Mandatory = $true)][string]$Version)
  foreach ($relative in $versionedSourceFiles) {
    Set-JsonVersion -Path (Join-Path $repoRoot $relative) -Version $Version
  }
}

function Restore-VersionedSources {
  foreach ($entry in $sourceBackups.GetEnumerator()) {
    Write-Utf8NoBom -Path ([string]$entry.Key) -Content ([string]$entry.Value)
  }
}

function Build-SetupInstaller {
  param([Parameter(Mandatory = $true)][string]$Version)
  Set-SourceVersion -Version $Version
  $releaseDir = Join-Path $repoRoot 'apps\desktop\release'
  Remove-Item -LiteralPath $releaseDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $repoRoot 'apps\desktop\out') -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $repoRoot 'apps\extension\dist') -Recurse -Force -ErrorAction SilentlyContinue

  $previousFlag = $env:SUBUTAI_REAL_UPDATE_ACCEPTANCE_BUILD
  try {
    $env:SUBUTAI_REAL_UPDATE_ACCEPTANCE_BUILD = '1'
    Invoke-Checked -FilePath 'pnpm' -Arguments @('--filter', '@subutai/extension', 'build')
    Invoke-Checked -FilePath 'pnpm' -Arguments @('--filter', '@subutai/desktop', 'build:native-host')
    Invoke-Checked -FilePath 'pnpm' -Arguments @('--filter', '@subutai/desktop', 'build')
    Invoke-Checked -FilePath 'pnpm' -Arguments @('exec', 'electron-builder', '--win', 'nsis', '--publish', 'never') -WorkingDirectory (Join-Path $repoRoot 'apps\desktop')
  } finally {
    $env:SUBUTAI_REAL_UPDATE_ACCEPTANCE_BUILD = $previousFlag
  }

  $setups = @(Get-ChildItem -LiteralPath $releaseDir -File -Filter "Subutai-Setup-$Version-*.exe")
  if ($setups.Count -ne 1) { throw "Expected exactly one Setup installer for $Version; found $($setups.Count)." }
  $blockmaps = @(Get-ChildItem -LiteralPath $releaseDir -File -Filter "Subutai-Setup-$Version-*.exe.blockmap")
  if ($blockmaps.Count -ne 1) { throw "Expected exactly one Setup blockmap for $Version; found $($blockmaps.Count)." }

  $output = Join-Path $buildsRoot $Version
  Remove-Item -LiteralPath $output -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $output | Out-Null
  $setupCopy = Join-Path $output $setups[0].Name
  $blockmapCopy = Join-Path $output $blockmaps[0].Name
  Copy-Item -LiteralPath $setups[0].FullName -Destination $setupCopy
  Copy-Item -LiteralPath $blockmaps[0].FullName -Destination $blockmapCopy
  return [ordered]@{
    version = $Version
    setupPath = $setupCopy
    setupName = [System.IO.Path]::GetFileName($setupCopy)
    setupSha256 = Get-Sha256 $setupCopy
    setupSha512 = Get-Sha512Base64 $setupCopy
    setupSize = (Get-Item -LiteralPath $setupCopy).Length
    blockmapPath = $blockmapCopy
    blockmapName = [System.IO.Path]::GetFileName($blockmapCopy)
    blockmapSha256 = Get-Sha256 $blockmapCopy
  }
}

function New-UpdateFeed {
  param(
    [Parameter(Mandatory = $true)]$TargetBuild,
    [Parameter(Mandatory = $true)][string]$Destination,
    [switch]$CorruptInstaller
  )
  Remove-Item -LiteralPath $Destination -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  $setupDestination = Join-Path $Destination ([string]$TargetBuild.setupName)
  Copy-Item -LiteralPath ([string]$TargetBuild.setupPath) -Destination $setupDestination
  Copy-Item -LiteralPath ([string]$TargetBuild.blockmapPath) -Destination (Join-Path $Destination ([string]$TargetBuild.blockmapName))
  if ($CorruptInstaller) {
    $stream = [System.IO.File]::Open($setupDestination, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try { $stream.WriteByte(0x53); $stream.Flush($true) } finally { $stream.Dispose() }
  }
  $releaseDate = [DateTime]::UtcNow.ToString('o')
  $latest = @"
version: $($TargetBuild.version)
files:
  - url: $($TargetBuild.setupName)
    sha512: $($TargetBuild.setupSha512)
    size: $($TargetBuild.setupSize)
path: $($TargetBuild.setupName)
sha512: $($TargetBuild.setupSha512)
releaseDate: '$releaseDate'
"@
  Write-Utf8NoBom -Path (Join-Path $Destination 'latest.yml') -Content $latest
  Write-Utf8NoBom -Path (Join-Path $Destination 'SHA256SUMS.txt') -Content "$($TargetBuild.setupSha256)  $($TargetBuild.setupName)`n$($TargetBuild.blockmapSha256)  $($TargetBuild.blockmapName)`n"
}

function Start-FeedServer {
  param([Parameter(Mandatory = $true)][string]$Directory, [Parameter(Mandatory = $true)][string]$Name)
  $statePath = Join-Path $logsRoot "$Name-server-state.json"
  $logPath = Join-Path $logsRoot "$Name-server.log"
  Remove-Item -LiteralPath $statePath, $logPath -Force -ErrorAction SilentlyContinue
  $arguments = @(
    "`"$feedServerScript`"",
    "`"$Directory`"",
    "`"$statePath`"",
    "`"$logPath`""
  )
  $process = Start-Process -FilePath 'node' -ArgumentList $arguments -WindowStyle Hidden -PassThru
  $serverProcesses.Add($process)
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while (-not (Test-Path -LiteralPath $statePath) -and [DateTime]::UtcNow -lt $deadline) {
    if ($process.HasExited) { throw "Loopback update feed server exited with code $($process.ExitCode)." }
    Start-Sleep -Milliseconds 200
  }
  if (-not (Test-Path -LiteralPath $statePath)) { throw 'Loopback update feed server did not become ready.' }
  $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  if ([string]$state.url -notmatch '^http://127\.0\.0\.1:\d+/$') { throw 'Loopback update feed server returned an unsafe URL.' }
  return $state
}

function Stop-SubutaiProcesses {
  Get-Process -Name 'Subutai Download Manager' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
}

function Remove-BrowserRegistration {
  foreach ($key in $registryKeys) { Remove-Item -LiteralPath $key -Recurse -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $nativeMessagingDir -Recurse -Force -ErrorAction SilentlyContinue
}

function Reset-ScenarioState {
  Stop-SubutaiProcesses
  if (Test-Path -LiteralPath $installDir) {
    $uninstaller = Get-ChildItem -LiteralPath $installDir -File -Filter 'Uninstall*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($uninstaller) {
      $process = Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -PassThru -Wait
      if ($process.ExitCode -ne 0) { throw "Scenario cleanup uninstall failed with exit code $($process.ExitCode)." }
    }
  }
  Stop-SubutaiProcesses
  Remove-Item -LiteralPath $installDir, $userDataDir, $updaterRoot, $downloadsDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-BrowserRegistration
  New-Item -ItemType Directory -Force -Path $downloadsDir | Out-Null
}

function Install-Baseline {
  param([Parameter(Mandatory = $true)]$BaselineBuild)
  New-Item -ItemType Directory -Force -Path $installDir | Out-Null
  $process = Start-Process -FilePath ([string]$BaselineBuild.setupPath) -ArgumentList @('/S', "/D=$installDir") -PassThru -Wait
  if ($null -eq $process.ExitCode -or $process.ExitCode -ne 0) {
    throw "Baseline Setup failed with exit code $($process.ExitCode)."
  }
  if (-not (Test-Path -LiteralPath $installedExecutable -PathType Leaf)) { throw 'Baseline installed executable is missing.' }
  $version = Get-ExecutableVersion $installedExecutable
  if ($version -ne $BaselineVersion) { throw "Baseline installed version is $version instead of $BaselineVersion." }
  return $process.ExitCode
}

function Get-RegistryEvidence {
  $entries = @()
  foreach ($key in $registryKeys) {
    if (-not (Test-Path -LiteralPath $key)) { throw "Native messaging registry key is missing: $key" }
    $manifestPath = [string](Get-Item -LiteralPath $key).GetValue('')
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "Native messaging manifest is missing: $manifestPath" }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $actualExecutable = [System.IO.Path]::GetFullPath([string]$manifest.path)
    if (-not [System.StringComparer]::OrdinalIgnoreCase.Equals($actualExecutable, [System.IO.Path]::GetFullPath($installedExecutable))) {
      throw "Native messaging manifest points to $actualExecutable instead of $installedExecutable."
    }
    $entries += [ordered]@{
      key = $key
      manifestPath = [System.IO.Path]::GetFullPath($manifestPath)
      manifestSha256 = Get-Sha256 $manifestPath
      executablePath = $actualExecutable
    }
  }
  return $entries
}

function Invoke-StateProbe {
  param([Parameter(Mandatory = $true)][ValidateSet('seed', 'snapshot')][string]$Command, [Parameter(Mandatory = $true)][string]$Output)
  Invoke-Checked -FilePath 'node' -Arguments @($stateProbe, $Command, $userDataDir, $downloadsDir, $Output)
  return Get-Content -LiteralPath $Output -Raw | ConvertFrom-Json
}

function Wait-ForResult {
  param([Parameter(Mandatory = $true)][string]$ResultPath, [Parameter(Mandatory = $true)][System.Diagnostics.Process]$InitialProcess)
  $deadline = [DateTime]::UtcNow.AddSeconds($ScenarioTimeoutSeconds)
  while (-not (Test-Path -LiteralPath $ResultPath) -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 500
  }
  if (-not (Test-Path -LiteralPath $ResultPath)) {
    $exit = if ($InitialProcess.HasExited) { $InitialProcess.ExitCode } else { 'running' }
    throw "Real update acceptance did not produce a result within $ScenarioTimeoutSeconds seconds. Initial process=$exit."
  }
  return Get-Content -LiteralPath $ResultPath -Raw | ConvertFrom-Json
}

function Invoke-Scenario {
  param(
    [Parameter(Mandatory = $true)][ValidateSet('healthy', 'rollback', 'checksum-mismatch')][string]$Mode,
    [Parameter(Mandatory = $true)]$BaselineBuild,
    [Parameter(Mandatory = $true)]$TargetBuild,
    [Parameter(Mandatory = $true)]$FeedState
  )
  Reset-ScenarioState
  $scenarioDir = Join-Path $evidenceRoot $Mode
  New-Item -ItemType Directory -Force -Path $scenarioDir | Out-Null
  $baselineInstallExitCode = Install-Baseline $BaselineBuild
  $baselineAppHash = Get-Sha256 (Join-Path $installDir 'resources\app.asar')
  $cachePath = Join-Path $updaterRoot "packages\$BaselineVersion\Subutai-Setup-$BaselineVersion-rollback.exe"
  if (-not (Test-Path -LiteralPath $cachePath -PathType Leaf)) { throw 'Baseline rollback installer was not cached by the real NSIS Setup.' }
  $cacheHash = Get-Sha256 $cachePath
  if ($cacheHash -ne [string]$BaselineBuild.setupSha256) { throw 'Cached baseline installer hash does not match the real baseline Setup.' }

  $beforePath = Join-Path $scenarioDir 'state-before.json'
  $afterPath = Join-Path $scenarioDir 'state-after.json'
  $before = Invoke-StateProbe -Command 'seed' -Output $beforePath
  $registryBefore = Get-RegistryEvidence
  $resultPath = Join-Path $scenarioDir 'result.json'
  $runtimeLog = Join-Path $logsRoot "$Mode-runtime.log"
  $stdoutLog = Join-Path $logsRoot "$Mode-stdout.log"
  $stderrLog = Join-Path $logsRoot "$Mode-stderr.log"
  Remove-Item -LiteralPath $resultPath, $runtimeLog, $stdoutLog, $stderrLog -Force -ErrorAction SilentlyContinue

  $token = [guid]::NewGuid().ToString()
  $effectiveMode = if ($Mode -eq 'rollback') { 'rollback' } else { 'healthy' }
  $environmentNames = @(
    'SUBUTAI_REAL_UPDATE_ACCEPTANCE', 'SUBUTAI_REAL_UPDATE_TOKEN', 'SUBUTAI_REAL_UPDATE_MODE',
    'SUBUTAI_REAL_UPDATE_BASELINE_VERSION', 'SUBUTAI_REAL_UPDATE_TARGET_VERSION',
    'SUBUTAI_REAL_UPDATE_FEED_URL', 'SUBUTAI_REAL_UPDATE_RESULT_PATH', 'SUBUTAI_SMOKE_LOG'
  )
  $previousEnvironment = @{}
  foreach ($name in $environmentNames) { $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
  try {
    $env:SUBUTAI_REAL_UPDATE_ACCEPTANCE = '1'
    $env:SUBUTAI_REAL_UPDATE_TOKEN = $token
    $env:SUBUTAI_REAL_UPDATE_MODE = $effectiveMode
    $env:SUBUTAI_REAL_UPDATE_BASELINE_VERSION = $BaselineVersion
    $env:SUBUTAI_REAL_UPDATE_TARGET_VERSION = $TargetVersion
    $env:SUBUTAI_REAL_UPDATE_FEED_URL = [string]$FeedState.url
    $env:SUBUTAI_REAL_UPDATE_RESULT_PATH = $resultPath
    $env:SUBUTAI_SMOKE_LOG = $runtimeLog
    $initialProcess = Start-Process -FilePath $installedExecutable -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
    $result = Wait-ForResult -ResultPath $resultPath -InitialProcess $initialProcess
  } finally {
    foreach ($name in $environmentNames) { [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process') }
  }

  Stop-SubutaiProcesses
  $after = Invoke-StateProbe -Command 'snapshot' -Output $afterPath
  if ([string]$before.logicalStateSha256 -ne [string]$after.logicalStateSha256) {
    throw "$Mode user data changed across update/rollback. Before=$($before.logicalStateSha256) After=$($after.logicalStateSha256)"
  }
  $registryAfter = Get-RegistryEvidence
  $installedVersionAfter = Get-ExecutableVersion $installedExecutable
  $installedAppHashAfter = Get-Sha256 (Join-Path $installDir 'resources\app.asar')
  $journal = if (Test-Path -LiteralPath $journalPath) { Get-Content -LiteralPath $journalPath -Raw | ConvertFrom-Json } else { $null }
  $watchdogEvidence = if (Test-Path -LiteralPath $watchdogEvidencePath) { Get-Content -LiteralPath $watchdogEvidencePath -Raw | ConvertFrom-Json } else { $null }

  if ($Mode -eq 'healthy') {
    if ([string]$result.outcome -ne 'healthy-update' -or [string]$result.currentVersion -ne $TargetVersion) {
      throw "Healthy update returned outcome=$($result.outcome), version=$($result.currentVersion)."
    }
    if ($installedVersionAfter -ne $TargetVersion) { throw "Healthy update left installed version $installedVersionAfter." }
    if ($null -eq $journal -or [string]$journal.updateState -ne 'committed') { throw 'Healthy update transaction was not committed.' }
    if ($installedAppHashAfter -eq $baselineAppHash) { throw 'Healthy update did not replace the packaged application.' }
  } elseif ($Mode -eq 'rollback') {
    if ([string]$result.outcome -ne 'rolled-back' -or [string]$result.currentVersion -ne $BaselineVersion) {
      throw "Rollback returned outcome=$($result.outcome), version=$($result.currentVersion)."
    }
    if ($installedVersionAfter -ne $BaselineVersion) { throw "Rollback left installed version $installedVersionAfter." }
    if ($null -eq $journal -or [string]$journal.updateState -ne 'rolled-back' -or [string]$journal.rollbackState -ne 'succeeded') {
      throw 'Rollback transaction did not reach rolled-back/succeeded.'
    }
    if ($installedAppHashAfter -ne $baselineAppHash) { throw 'Rollback did not restore the exact baseline packaged application.' }
  } else {
    if ([string]$result.outcome -ne 'failed') { throw "Checksum mismatch scenario unexpectedly returned $($result.outcome)." }
    if ($installedVersionAfter -ne $BaselineVersion) { throw 'Checksum mismatch scenario changed the installed version.' }
    if ($installedAppHashAfter -ne $baselineAppHash) { throw 'Checksum mismatch scenario changed the installed application.' }
    if ($null -ne $journal -and [string]$journal.targetVersion -eq $TargetVersion) {
      throw 'Checksum mismatch scenario armed an update transaction unexpectedly.'
    }
  }

  $evidence = [ordered]@{
    schemaVersion = 1
    scenario = $Mode
    token = $token
    testedCommitSha = if ($env:GITHUB_SHA) { $env:GITHUB_SHA } else { 'local-worktree' }
    baselineVersion = $BaselineVersion
    targetVersion = $TargetVersion
    baselineInstallerSha256 = [string]$BaselineBuild.setupSha256
    targetInstallerSha256 = [string]$TargetBuild.setupSha256
    cachedBaselineInstallerSha256 = $cacheHash
    baselineInstallExitCode = $baselineInstallExitCode
    initialProcessExitCode = if ($initialProcess.HasExited) { $initialProcess.ExitCode } else { $null }
    installedVersionAfter = $installedVersionAfter
    baselineAppAsarSha256 = $baselineAppHash
    installedAppAsarSha256After = $installedAppHashAfter
    stateBeforeSha256 = [string]$before.logicalStateSha256
    stateAfterSha256 = [string]$after.logicalStateSha256
    registryBefore = $registryBefore
    registryAfter = $registryAfter
    result = $result
    transactionJournal = $journal
    watchdogEvidence = $watchdogEvidence
    runtimeLog = $runtimeLog
    stdoutLog = $stdoutLog
    stderrLog = $stderrLog
    recordedAt = [DateTime]::UtcNow.ToString('o')
  }
  Write-JsonFile -Path (Join-Path $scenarioDir 'scenario-evidence.json') -Value $evidence
  $scenarioEvidence.Add($evidence)
}

function Backup-Directory {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Name)
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $destination = Join-Path $backupRoot $Name
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
  Move-Item -LiteralPath $Path -Destination $destination
  $directoryBackups[$Path] = $destination
}

function Restore-PreExistingState {
  Stop-SubutaiProcesses
  Remove-Item -LiteralPath $installDir, $userDataDir, $updaterRoot, $nativeMessagingDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-BrowserRegistration
  foreach ($entry in $directoryBackups.GetEnumerator()) {
    if (Test-Path -LiteralPath ([string]$entry.Value)) {
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent ([string]$entry.Key)) | Out-Null
      Move-Item -LiteralPath ([string]$entry.Value) -Destination ([string]$entry.Key)
    }
  }
  foreach ($entry in $registryBackup) {
    if ($entry.existed) {
      New-Item -Path $entry.key -Force | Out-Null
      (Get-Item -LiteralPath $entry.key).SetValue('', [string]$entry.value)
    }
  }
}

try {
  Remove-Item -LiteralPath $workspacePath -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $buildsRoot, $evidenceRoot, $logsRoot, $feedRoot, $backupRoot | Out-Null
  foreach ($relative in $versionedSourceFiles) {
    $path = Join-Path $repoRoot $relative
    $sourceBackups[$path] = Get-Content -LiteralPath $path -Raw
  }
  foreach ($key in $registryKeys) {
    $registryBackup += [ordered]@{
      key = $key
      existed = Test-Path -LiteralPath $key
      value = if (Test-Path -LiteralPath $key) { [string](Get-Item -LiteralPath $key).GetValue('') } else { '' }
    }
  }
  Stop-SubutaiProcesses
  Backup-Directory -Path $userDataDir -Name 'user-data'
  Backup-Directory -Path $updaterRoot -Name 'updater'
  Backup-Directory -Path $nativeMessagingDir -Name 'native-messaging'
  Remove-BrowserRegistration

  $baselineBuild = Build-SetupInstaller -Version $BaselineVersion
  $targetBuild = Build-SetupInstaller -Version $TargetVersion
  $buildEvidence.baseline = $baselineBuild
  $buildEvidence.target = $targetBuild
  Write-JsonFile -Path (Join-Path $evidenceRoot 'build-evidence.json') -Value $buildEvidence

  $goodFeed = Join-Path $feedRoot 'good'
  $badFeed = Join-Path $feedRoot 'checksum-mismatch'
  New-UpdateFeed -TargetBuild $targetBuild -Destination $goodFeed
  New-UpdateFeed -TargetBuild $targetBuild -Destination $badFeed -CorruptInstaller
  $goodServer = Start-FeedServer -Directory $goodFeed -Name 'good'
  $badServer = Start-FeedServer -Directory $badFeed -Name 'checksum-mismatch'

  Invoke-Scenario -Mode 'healthy' -BaselineBuild $baselineBuild -TargetBuild $targetBuild -FeedState $goodServer
  Invoke-Scenario -Mode 'rollback' -BaselineBuild $baselineBuild -TargetBuild $targetBuild -FeedState $goodServer
  Invoke-Scenario -Mode 'checksum-mismatch' -BaselineBuild $baselineBuild -TargetBuild $targetBuild -FeedState $badServer

  $final = [ordered]@{
    schemaVersion = 1
    outcome = 'passed'
    testedCommitSha = if ($env:GITHUB_SHA) { $env:GITHUB_SHA } else { 'local-worktree' }
    baselineVersion = $BaselineVersion
    targetVersion = $TargetVersion
    scenarios = $scenarioEvidence
    noTag = $true
    noRelease = $true
    noPublish = $true
    noDeploy = $true
    recordedAt = [DateTime]::UtcNow.ToString('o')
  }
  Write-JsonFile -Path (Join-Path $evidenceRoot 'real-two-installer-acceptance-report.json') -Value $final
  Write-Host 'Subutai real two-installer update, rollback and checksum-mismatch acceptance passed.'
} finally {
  Restore-VersionedSources
  foreach ($process in $serverProcesses) {
    try { if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue } } catch { }
  }
  try { Reset-ScenarioState } catch { Write-Warning "Scenario cleanup failed: $($_.Exception.Message)" }
  try { Restore-PreExistingState } catch { Write-Warning "Pre-existing runner state restoration failed: $($_.Exception.Message)" }
  if (-not $KeepWorkspace -and -not $env:GITHUB_ACTIONS) {
    Write-Host "Acceptance evidence retained at $evidenceRoot."
  }
}
