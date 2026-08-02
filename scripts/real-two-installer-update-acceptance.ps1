param(
  [string]$BaselineVersion = "0.1.0",
  [string]$TargetVersion = "0.2.0",
  [string]$EvidenceDir = "artifacts/real-update-acceptance"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $repoRoot
$evidenceRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $EvidenceDir))
$workRoot = Join-Path $env:RUNNER_TEMP "SubutaiRealUpdateAcceptance"
$buildRoot = Join-Path $workRoot "Builds"
$feedRoot = Join-Path $workRoot "Feed"
$localAppData = Join-Path $workRoot "LocalAppData"
$roamingAppData = Join-Path $workRoot "RoamingAppData"
$installDir = Join-Path $localAppData "Programs\Subutai Download Manager"
$installedExe = Join-Path $installDir "Subutai Download Manager.exe"
$updaterRoot = Join-Path $localAppData "Subutai\Updater"
$acceptanceConfig = Join-Path $updaterRoot "real-two-installer-acceptance.json"
$journalPath = Join-Path $updaterRoot "update-transaction.json"
$serverPortFile = Join-Path $workRoot "feed-port.txt"
$serverStdout = Join-Path $evidenceRoot "loopback-server.stdout.log"
$serverStderr = Join-Path $evidenceRoot "loopback-server.stderr.log"
$serverProcess = $null

$packagePaths = @(
  "package.json",
  "apps/desktop/package.json",
  "apps/extension/package.json"
)
$originalPackages = @{}
foreach ($path in $packagePaths) {
  $originalPackages[$path] = Get-Content $path -Raw
}

function Invoke-Checked {
  param([Parameter(Mandatory = $true)][scriptblock]$Command, [Parameter(Mandatory = $true)][string]$Label)
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE." }
}

function Set-PackageVersion {
  param([Parameter(Mandatory = $true)][string]$Version)
  foreach ($path in $packagePaths) {
    $json = Get-Content $path -Raw | ConvertFrom-Json
    $json.version = $Version
    $json | ConvertTo-Json -Depth 100 | Set-Content $path -Encoding utf8
  }
}

function Build-Setup {
  param(
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$Destination
  )
  Set-PackageVersion -Version $Version
  Remove-Item "apps/desktop/release" -Recurse -Force -ErrorAction SilentlyContinue
  $env:SUBUTAI_REAL_UPDATE_ACCEPTANCE_BUILD = "1"
  Invoke-Checked { pnpm --filter @subutai/extension build } "Extension build $Version"
  Invoke-Checked { pnpm --filter @subutai/desktop build:native-host } "Native host build $Version"
  Invoke-Checked { pnpm --filter @subutai/desktop exec electron-vite build } "Electron build $Version"
  Invoke-Checked { pnpm --filter @subutai/desktop exec electron-builder --win nsis --publish never } "NSIS build $Version"
  New-Item -ItemType Directory -Force $Destination | Out-Null
  Copy-Item "apps/desktop/release/*" $Destination -Recurse -Force
  $setup = @(Get-ChildItem $Destination -File -Filter "Subutai-Setup-$Version-*.exe")
  if ($setup.Count -ne 1) { throw "Expected one Setup installer for $Version; found $($setup.Count)." }
  return $setup[0].FullName
}

function Get-Sha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  return (Get-FileHash $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Stop-SubutaiProcesses {
  Get-Process -Name "Subutai Download Manager" -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
}

function Install-Setup {
  param([Parameter(Mandatory = $true)][string]$Installer)
  Stop-SubutaiProcesses
  $process = Start-Process -FilePath $Installer -ArgumentList @("/S", "/D=$installDir") -PassThru -Wait
  $process.Refresh()
  if ($null -eq $process.ExitCode -or $process.ExitCode -ne 0) {
    throw "Setup failed with exit code $($process.ExitCode): $Installer"
  }
  if (-not (Test-Path $installedExe)) { throw "Installed executable is missing: $installedExe" }
  return $process.ExitCode
}

function Invoke-Smoke {
  param([Parameter(Mandatory = $true)][string]$Name)
  $log = Join-Path $evidenceRoot "$Name.runtime.log"
  $env:SUBUTAI_SMOKE_LOG = $log
  $process = Start-Process -FilePath $installedExe -ArgumentList "--subutai-smoke-test" -PassThru
  if (-not $process.WaitForExit(60000)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "$Name smoke launch timed out."
  }
  $process.Refresh()
  if ($process.ExitCode -ne 0) { throw "$Name smoke launch failed with exit code $($process.ExitCode)." }
  $text = if (Test-Path $log) { Get-Content $log -Raw } else { "" }
  if ($text -notmatch "Launch smoke completed successfully") { throw "$Name smoke success marker is missing." }
}

function Get-RegistryEvidence {
  $hostName = "com.subutai.download_manager"
  $keys = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName",
    "HKCU:\Software\Mozilla\NativeMessagingHosts\$hostName"
  )
  $result = [ordered]@{}
  foreach ($key in $keys) {
    if (-not (Test-Path $key)) { throw "Native messaging registry key is missing: $key" }
    $manifestPath = [string](Get-Item $key).GetValue("")
    if (-not (Test-Path $manifestPath)) { throw "Native messaging manifest is missing: $manifestPath" }
    $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
    $resolvedExecutable = [System.IO.Path]::GetFullPath([string]$manifest.path)
    if ($resolvedExecutable -ne [System.IO.Path]::GetFullPath($installedExe)) {
      throw "Native messaging manifest points to the wrong executable: $resolvedExecutable"
    }
    $result[$key] = [ordered]@{
      manifestPath = $manifestPath
      executablePath = $resolvedExecutable
      manifestSha256 = Get-Sha256 $manifestPath
    }
  }
  return $result
}

function New-PreservationSentinels {
  $root = Join-Path $roamingAppData "Subutai Download Manager\AcceptancePreservation"
  New-Item -ItemType Directory -Force $root | Out-Null
  $files = @(
    (Join-Path $root "settings.sentinel.json"),
    (Join-Path $root "queue.sentinel.json"),
    (Join-Path $root "database.sentinel.sqlite"),
    (Join-Path $root "download.subutai.part"),
    (Join-Path $root "download.subutai.job")
  )
  $counter = 0
  foreach ($file in $files) {
    $counter += 1
    [System.IO.File]::WriteAllText($file, "Subutai acceptance sentinel $counter $([Guid]::NewGuid())")
  }
  $hashes = [ordered]@{}
  foreach ($file in $files) { $hashes[$file] = Get-Sha256 $file }
  return $hashes
}

function Assert-PreservationSentinels {
  param([Parameter(Mandatory = $true)]$Expected)
  foreach ($entry in $Expected.GetEnumerator()) {
    if (-not (Test-Path $entry.Key)) { throw "Preservation sentinel was deleted: $($entry.Key)" }
    $actual = Get-Sha256 $entry.Key
    if ($actual -ne $entry.Value) { throw "Preservation sentinel changed: $($entry.Key)" }
  }
}

function Wait-AcceptanceResult {
  param(
    [Parameter(Mandatory = $true)][string]$ResultPath,
    [Parameter(Mandatory = $true)][string]$ExpectedOutcome,
    [int]$TimeoutSeconds = 420
  )
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-Path $ResultPath) {
      try {
        $result = Get-Content $ResultPath -Raw | ConvertFrom-Json
        if ($result.outcome -eq "failed") { throw "Acceptance reported failure: $($result.error)" }
        if ($result.outcome -eq $ExpectedOutcome) { return $result }
      } catch {
        if ($_.Exception.Message -like "Acceptance reported failure:*") { throw }
      }
    }
    Start-Sleep -Milliseconds 500
  }
  $journal = if (Test-Path $journalPath) { Get-Content $journalPath -Raw } else { "missing" }
  throw "Timed out waiting for $ExpectedOutcome. Journal: $journal"
}

function Start-Acceptance {
  param(
    [Parameter(Mandatory = $true)][ValidateSet("healthy", "rollback")][string]$Mode,
    [Parameter(Mandatory = $true)][string]$FeedUrl,
    [Parameter(Mandatory = $true)][string]$ResultPath
  )
  Remove-Item $ResultPath -Force -ErrorAction SilentlyContinue
  $env:SUBUTAI_REAL_UPDATE_ACCEPTANCE = "1"
  $env:SUBUTAI_REAL_UPDATE_TOKEN = [Guid]::NewGuid().ToString()
  $env:SUBUTAI_REAL_UPDATE_MODE = $Mode
  $env:SUBUTAI_REAL_UPDATE_BASELINE_VERSION = $BaselineVersion
  $env:SUBUTAI_REAL_UPDATE_TARGET_VERSION = $TargetVersion
  $env:SUBUTAI_REAL_UPDATE_FEED_URL = $FeedUrl
  $env:SUBUTAI_REAL_UPDATE_RESULT_PATH = $ResultPath
  Start-Process -FilePath $installedExe | Out-Null
}

function Clear-AcceptanceEnvironment {
  foreach ($name in @(
    "SUBUTAI_REAL_UPDATE_ACCEPTANCE",
    "SUBUTAI_REAL_UPDATE_TOKEN",
    "SUBUTAI_REAL_UPDATE_MODE",
    "SUBUTAI_REAL_UPDATE_BASELINE_VERSION",
    "SUBUTAI_REAL_UPDATE_TARGET_VERSION",
    "SUBUTAI_REAL_UPDATE_FEED_URL",
    "SUBUTAI_REAL_UPDATE_RESULT_PATH"
  )) {
    Remove-Item "Env:$name" -ErrorAction SilentlyContinue
  }
}

function Uninstall-Subutai {
  Stop-SubutaiProcesses
  if (-not (Test-Path $installDir)) { return $null }
  $uninstaller = Get-ChildItem $installDir -File -Filter "Uninstall*.exe" | Select-Object -First 1
  if (-not $uninstaller) { throw "Uninstaller is missing from $installDir" }
  $process = Start-Process -FilePath $uninstaller.FullName -ArgumentList "/S" -PassThru -Wait
  $process.Refresh()
  if ($process.ExitCode -ne 0) { throw "Uninstall failed with exit code $($process.ExitCode)." }
  return $process.ExitCode
}

try {
  Remove-Item $workRoot -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $evidenceRoot -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force $workRoot, $buildRoot, $feedRoot, $localAppData, $roamingAppData, $evidenceRoot | Out-Null
  $env:LOCALAPPDATA = $localAppData
  $env:APPDATA = $roamingAppData

  Invoke-Checked { pnpm install --frozen-lockfile } "Locked dependency installation"
  ./scripts/install-temporary-media-tools.ps1

  $baselineBuild = Join-Path $buildRoot "baseline-$BaselineVersion"
  $targetBuild = Join-Path $buildRoot "target-$TargetVersion"
  $baselineInstaller = Build-Setup -Version $BaselineVersion -Destination $baselineBuild
  $targetInstaller = Build-Setup -Version $TargetVersion -Destination $targetBuild
  Copy-Item "$targetBuild\*" $feedRoot -Recurse -Force

  $baselineInstallerSha256 = Get-Sha256 $baselineInstaller
  $targetInstallerSha256 = Get-Sha256 $targetInstaller
  "$targetInstallerSha256  $([System.IO.Path]::GetFileName($targetInstaller))" |
    Set-Content (Join-Path $feedRoot "SHA256SUMS.txt") -Encoding ascii
  if (-not (Test-Path (Join-Path $feedRoot "latest.yml"))) { throw "Target build did not produce latest.yml." }
  if (@(Get-ChildItem $feedRoot -File -Filter "*.blockmap").Count -lt 1) { throw "Target build did not produce a blockmap." }

  Remove-Item $serverPortFile -Force -ErrorAction SilentlyContinue
  $serverProcess = Start-Process -FilePath "node" `
    -ArgumentList @("scripts/loopback-update-server.mjs", $feedRoot, $serverPortFile) `
    -RedirectStandardOutput $serverStdout `
    -RedirectStandardError $serverStderr `
    -PassThru
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while (-not (Test-Path $serverPortFile) -and [DateTime]::UtcNow -lt $deadline) {
    if ($serverProcess.HasExited) { throw "Loopback update server exited before publishing its port." }
    Start-Sleep -Milliseconds 200
  }
  if (-not (Test-Path $serverPortFile)) { throw "Loopback update server did not start." }
  $port = [int](Get-Content $serverPortFile -Raw)
  $feedUrl = "http://127.0.0.1:$port/"

  $baselineInstallExit = Install-Setup -Installer $baselineInstaller
  Clear-AcceptanceEnvironment
  Invoke-Smoke -Name "baseline-before-healthy"
  $baselineExeSha256 = Get-Sha256 $installedExe
  $sentinels = New-PreservationSentinels
  $registryBefore = Get-RegistryEvidence

  $healthyResultPath = Join-Path $evidenceRoot "healthy-result.json"
  Start-Acceptance -Mode healthy -FeedUrl $feedUrl -ResultPath $healthyResultPath
  $healthyResult = Wait-AcceptanceResult -ResultPath $healthyResultPath -ExpectedOutcome "healthy-update"
  Stop-SubutaiProcesses
  if ([string]$healthyResult.currentVersion -ne $TargetVersion) { throw "Healthy update did not reach $TargetVersion." }
  $targetExeSha256 = Get-Sha256 $installedExe
  if ($targetExeSha256 -eq $baselineExeSha256) { throw "Healthy update did not replace the installed executable." }
  Assert-PreservationSentinels -Expected $sentinels
  $registryAfterHealthy = Get-RegistryEvidence
  $healthyJournal = Get-Content $journalPath -Raw | ConvertFrom-Json
  if ($healthyJournal.updateState -ne "committed") { throw "Healthy update journal was not committed." }
  if (-not (Test-Path $healthyJournal.previousInstallerPath)) { throw "Verified rollback installer cache is missing after healthy update." }

  Clear-AcceptanceEnvironment
  $baselineReinstallExit = Install-Setup -Installer $baselineInstaller
  Invoke-Smoke -Name "baseline-before-rollback"
  if ((Get-Sha256 $installedExe) -ne $baselineExeSha256) { throw "Baseline reinstall did not restore the baseline executable." }
  Assert-PreservationSentinels -Expected $sentinels

  $rollbackResultPath = Join-Path $evidenceRoot "rollback-result.json"
  Start-Acceptance -Mode rollback -FeedUrl $feedUrl -ResultPath $rollbackResultPath
  $rollbackResult = Wait-AcceptanceResult -ResultPath $rollbackResultPath -ExpectedOutcome "rolled-back"
  Stop-SubutaiProcesses
  if ([string]$rollbackResult.currentVersion -ne $BaselineVersion) { throw "Rollback did not return to $BaselineVersion." }
  $rollbackExeSha256 = Get-Sha256 $installedExe
  if ($rollbackExeSha256 -ne $baselineExeSha256) { throw "Rollback executable does not match the verified baseline executable." }
  Assert-PreservationSentinels -Expected $sentinels
  $registryAfterRollback = Get-RegistryEvidence
  $rollbackJournal = Get-Content $journalPath -Raw | ConvertFrom-Json
  if ($rollbackJournal.updateState -ne "rolled-back" -or $rollbackJournal.rollbackState -ne "succeeded") {
    throw "Rollback journal does not record a successful rollback."
  }
  if ([int]$rollbackJournal.rollbackAttemptCount -gt 1) { throw "Rollback loop protection failed." }

  $uninstallExit = Uninstall-Subutai
  $evidence = [ordered]@{
    schemaVersion = 1
    testedCommitSha = $env:GITHUB_SHA
    baselineVersion = $BaselineVersion
    targetVersion = $TargetVersion
    baselineInstaller = $baselineInstaller
    baselineInstallerSha256 = $baselineInstallerSha256
    targetInstaller = $targetInstaller
    targetInstallerSha256 = $targetInstallerSha256
    baselineExecutableSha256 = $baselineExeSha256
    targetExecutableSha256 = $targetExeSha256
    rollbackExecutableSha256 = $rollbackExeSha256
    healthyResult = $healthyResult
    rollbackResult = $rollbackResult
    healthyJournal = $healthyJournal
    rollbackJournal = $rollbackJournal
    preservationSentinels = $sentinels
    registryBefore = $registryBefore
    registryAfterHealthy = $registryAfterHealthy
    registryAfterRollback = $registryAfterRollback
    installerExitCodes = [ordered]@{
      baselineInstall = $baselineInstallExit
      baselineReinstall = $baselineReinstallExit
      uninstall = $uninstallExit
    }
    feedUrl = $feedUrl
    completedAt = [DateTime]::UtcNow.ToString("o")
  }
  $evidence | ConvertTo-Json -Depth 100 | Set-Content (Join-Path $evidenceRoot "evidence.json") -Encoding utf8
  Copy-Item $journalPath (Join-Path $evidenceRoot "final-update-transaction.json") -Force
  Write-Host "Subutai real two-installer healthy update and rollback acceptance passed."
} finally {
  Clear-AcceptanceEnvironment
  Stop-SubutaiProcesses
  if ($serverProcess -and -not $serverProcess.HasExited) {
    Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
  }
  foreach ($path in $packagePaths) {
    [System.IO.File]::WriteAllText((Join-Path $repoRoot $path), [string]$originalPackages[$path])
  }
  Remove-Item Env:SUBUTAI_REAL_UPDATE_ACCEPTANCE_BUILD -ErrorAction SilentlyContinue
  Remove-Item Env:SUBUTAI_SMOKE_LOG -ErrorAction SilentlyContinue
}
