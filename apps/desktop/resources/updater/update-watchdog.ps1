param(
  [Parameter(Mandatory = $true)][string]$TransactionPath,
  [ValidateRange(0, 2147483647)][int]$ParentProcessId = 0,
  [ValidateRange(100, 10000)][int]$PollMilliseconds = 1000,
  [switch]$TestMode,
  [string]$TestAllowedInstallRoot = '',
  [string]$TestRollbackMarker = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-FullPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  return [System.IO.Path]::GetFullPath($Path)
}

function Test-PathInside {
  param([Parameter(Mandatory = $true)][string]$Parent, [Parameter(Mandatory = $true)][string]$Child)
  $parentFull = (Get-FullPath $Parent).TrimEnd('\') + '\'
  $childFull = Get-FullPath $Child
  return $childFull.StartsWith($parentFull, [System.StringComparison]::OrdinalIgnoreCase)
}

function Protect-ErrorText {
  param([Parameter(Mandatory = $true)][string]$Text)
  $value = $Text -replace '([?&](?:token|access_token|auth|authorization|signature|sig|key|password|proxyPassword)=)[^&\s]+', '$1[redacted]'
  $value = $value -replace '(https?://[^\s/@:]+:)[^@\s]+@', '$1[redacted]@'
  $value = $value -replace '(proxy(?:Password)?\s*[=:]\s*)[^\s,;]+', '$1[redacted]'
  if ($value.Length -gt 2000) { return $value.Substring(0, 2000) }
  return $value
}

function Write-AtomicJson {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)]$Value)
  $directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $temporary = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
  $backup = "$Path.bak"
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 12), $utf8NoBom)
  $stream = [System.IO.File]::Open($temporary, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  try { $stream.Flush($true) } finally { $stream.Dispose() }
  if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }
  if (Test-Path -LiteralPath $Path) { Move-Item -LiteralPath $Path -Destination $backup -Force }
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

$transactionFullPath = Get-FullPath $TransactionPath
if ([System.IO.Path]::GetFileName($transactionFullPath) -ne 'update-transaction.json') {
  throw 'Transaction file name is not controlled by Subutai.'
}
$root = Split-Path -Parent $transactionFullPath
$evidencePath = Join-Path $root 'watchdog-evidence.json'

function Write-Evidence {
  param([Parameter(Mandatory = $true)][string]$Outcome, [string]$ErrorText = '')
  $evidence = [ordered]@{
    schemaVersion = 1
    outcome = $Outcome
    recordedAt = [DateTime]::UtcNow.ToString('o')
  }
  if (-not [string]::IsNullOrWhiteSpace($ErrorText)) { $evidence.error = Protect-ErrorText $ErrorText }
  Write-AtomicJson -Path $evidencePath -Value $evidence
}

function Read-Journal {
  if (Test-Path -LiteralPath $transactionFullPath -PathType Leaf) {
    try { return Get-Content -LiteralPath $transactionFullPath -Raw | ConvertFrom-Json }
    catch { throw "Update transaction journal is corrupt: $($_.Exception.Message)" }
  }

  $backup = "$transactionFullPath.bak"
  if (-not (Test-Path -LiteralPath $backup -PathType Leaf)) {
    throw 'Update transaction journal is missing.'
  }
  try { return Get-Content -LiteralPath $backup -Raw | ConvertFrom-Json }
  catch { throw "Update transaction journal recovery failed safely: $($_.Exception.Message)" }
}

function Assert-SafeVersion {
  param([Parameter(Mandatory = $true)][string]$Version)
  if ($Version -notmatch '^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$') { throw 'Transaction version is invalid.' }
}

function Get-AllowedInstallRoots {
  if ($TestMode) {
    if ([string]::IsNullOrWhiteSpace($TestAllowedInstallRoot)) { throw 'Test install root is required in test mode.' }
    return @((Get-FullPath $TestAllowedInstallRoot))
  }
  return @(
    (Join-Path $env:LOCALAPPDATA 'Programs'),
    $env:ProgramFiles,
    ${env:ProgramFiles(x86)}
  ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object { Get-FullPath $_ }
}

function Assert-Journal {
  param([Parameter(Mandatory = $true)]$Journal)
  if ([int]$Journal.schemaVersion -ne 1) { throw 'Unsupported update transaction schema.' }
  Assert-SafeVersion ([string]$Journal.currentVersion)
  Assert-SafeVersion ([string]$Journal.targetVersion)
  Assert-SafeVersion ([string]$Journal.previousWorkingVersion)
  if ([string]$Journal.transactionId -notmatch '^[0-9a-f-]{36}$') { throw 'Transaction ID is invalid.' }
  if ([string]$Journal.previousInstallerSha256 -notmatch '^[a-f0-9]{64}$') { throw 'Previous installer hash is invalid.' }
  if ([string]$Journal.targetInstallerSha256 -notmatch '^[a-f0-9]{64}$') { throw 'Target installer hash is invalid.' }
  if ([string]$Journal.watchdogSha256 -notmatch '^[a-f0-9]{64}$') { throw 'Watchdog hash is invalid.' }
  if ([int]$Journal.maxStartupAttempts -lt 1 -or [int]$Journal.maxStartupAttempts -gt 10) { throw 'Maximum startup attempts are invalid.' }
  if ([int]$Journal.startupAttemptCount -lt 0) { throw 'Startup attempt count is invalid.' }
  if ([int]$Journal.rollbackAttemptCount -lt 0 -or [int]$Journal.rollbackAttemptCount -gt 1) { throw 'Rollback attempt count is invalid.' }

  $previousDirectory = Join-Path $root "packages\$([string]$Journal.previousWorkingVersion)"
  $stagedDirectory = Join-Path $root "staged\$([string]$Journal.transactionId)"
  $watchdogDirectory = Join-Path $root 'watchdog'
  if (-not (Test-PathInside $previousDirectory ([string]$Journal.previousInstallerPath))) { throw 'Previous installer path escaped the controlled package cache.' }
  if (-not (Test-PathInside $stagedDirectory ([string]$Journal.targetInstallerPath))) { throw 'Target installer path escaped the controlled staging directory.' }
  if (-not (Test-PathInside $watchdogDirectory ([string]$Journal.watchdogPath))) { throw 'Watchdog path escaped the controlled watchdog directory.' }
  if ([System.IO.Path]::GetExtension([string]$Journal.previousInstallerPath) -ne '.exe') { throw 'Previous installer is not an executable.' }

  $installedExecutable = Get-FullPath ([string]$Journal.installedExecutablePath)
  if ([System.IO.Path]::GetFileName($installedExecutable) -ne 'Subutai Download Manager.exe') { throw 'Installed executable name is invalid.' }
  $allowed = Get-AllowedInstallRoots
  if (-not ($allowed | Where-Object { Test-PathInside $_ $installedExecutable })) {
    throw 'Installed executable is outside supported installation roots.'
  }

  [void][DateTime]::Parse([string]$Journal.createdAt)
  [void][DateTime]::Parse([string]$Journal.updatedAt)
  [void][DateTime]::Parse([string]$Journal.healthDeadline)
}

function Save-Journal {
  param([Parameter(Mandatory = $true)]$Journal)
  $Journal.updatedAt = [DateTime]::UtcNow.ToString('o')
  Assert-Journal $Journal
  Write-AtomicJson -Path $transactionFullPath -Value $Journal
}

function Set-FailedSafe {
  param([Parameter(Mandatory = $true)]$Journal, [Parameter(Mandatory = $true)][string]$Reason)
  $Journal.updateState = 'failed-safe'
  $Journal.rollbackState = 'blocked'
  $Journal.lastError = Protect-ErrorText $Reason
  Save-Journal $Journal
  Write-Evidence -Outcome 'failed-safe' -ErrorText $Reason
}

function Test-BrowserRegistration {
  param([Parameter(Mandatory = $true)][string]$ExecutablePath)
  $hostName = 'com.subutai.download_manager'
  $keys = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName",
    "HKCU:\Software\Mozilla\NativeMessagingHosts\$hostName"
  )
  foreach ($key in $keys) {
    if (-not (Test-Path -LiteralPath $key)) { throw "Browser native-messaging key is missing: $key" }
    $manifestPath = [string](Get-Item -LiteralPath $key).GetValue('')
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'Browser native-messaging manifest is missing.' }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ((Get-FullPath ([string]$manifest.path)) -ne (Get-FullPath $ExecutablePath)) {
      throw 'Browser native-messaging manifest points to the wrong executable.'
    }
  }
}

try {
  if (-not $TestMode) {
    $expectedRoot = Get-FullPath (Join-Path $env:LOCALAPPDATA 'Subutai\Updater')
    if ($root -ne $expectedRoot) { throw 'Updater root is not the controlled Subutai updater directory.' }
  }

  if ($ParentProcessId -gt 0) {
    try { Wait-Process -Id $ParentProcessId -Timeout 120 -ErrorAction Stop }
    catch {
      if (Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue) {
        throw 'Previous Subutai process did not exit before updater watchdog timeout.'
      }
    }
  }

  $hardDeadline = [DateTime]::UtcNow.AddMinutes(15)
  while ($true) {
    $journal = Read-Journal
    Assert-Journal $journal
    $state = [string]$journal.updateState
    if ($state -in @('committed', 'rolled-back', 'failed-safe')) {
      Write-Evidence -Outcome $state
      exit 0
    }
    if ($state -ne 'awaiting-health') {
      Write-Evidence -Outcome "no-action-$state"
      exit 0
    }
    if (-not [string]::IsNullOrWhiteSpace([string]$journal.intentionalExitAt)) {
      Write-Evidence -Outcome 'intentional-exit-no-rollback'
      exit 0
    }

    $healthDeadline = [DateTime]::Parse([string]$journal.healthDeadline).ToUniversalTime()
    $attemptLimitReached = [int]$journal.startupAttemptCount -ge [int]$journal.maxStartupAttempts
    if ($attemptLimitReached -or [DateTime]::UtcNow -ge $healthDeadline) { break }
    if ([DateTime]::UtcNow -ge $hardDeadline) { throw 'Updater watchdog exceeded its bounded monitoring window.' }
    Start-Sleep -Milliseconds $PollMilliseconds
  }

  if ([int]$journal.rollbackAttemptCount -ge 1 -or [string]$journal.rollbackState -in @('running', 'succeeded', 'blocked')) {
    Set-FailedSafe -Journal $journal -Reason 'Rollback attempt is already consumed; refusing an update/rollback loop.'
    exit 3
  }

  $journal.rollbackAttemptCount = 1
  $journal.rollbackState = 'running'
  $journal.updateState = 'rollback-running'
  $journal.rollbackStartedAt = [DateTime]::UtcNow.ToString('o')
  Save-Journal $journal

  $previousInstaller = Get-FullPath ([string]$journal.previousInstallerPath)
  if (-not (Test-Path -LiteralPath $previousInstaller -PathType Leaf)) {
    Set-FailedSafe -Journal $journal -Reason 'Verified previous installer is missing.'
    exit 4
  }
  $actualHash = (Get-FileHash -LiteralPath $previousInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne [string]$journal.previousInstallerSha256) {
    Set-FailedSafe -Journal $journal -Reason 'Previous installer checksum mismatch; rollback executable was not launched.'
    exit 5
  }

  $installedExecutable = Get-FullPath ([string]$journal.installedExecutablePath)
  if ($TestMode) {
    if ([string]::IsNullOrWhiteSpace($TestRollbackMarker)) { throw 'Rollback marker is required in test mode.' }
    $markerPath = Get-FullPath $TestRollbackMarker
    if (-not (Test-PathInside $root $markerPath)) { throw 'Test rollback marker escaped the fixture root.' }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $markerPath) | Out-Null
    if (-not (Test-Path -LiteralPath $markerPath)) {
      Set-Content -LiteralPath $markerPath -Value ([string]$journal.transactionId) -Encoding UTF8
    }
    $registrationFixture = [ordered]@{
      chrome = $installedExecutable
      edge = $installedExecutable
      firefox = $installedExecutable
    }
    Write-AtomicJson -Path (Join-Path $root 'browser-registration-fixture.json') -Value $registrationFixture
  } else {
    foreach ($process in Get-Process -ErrorAction SilentlyContinue) {
      try {
        if ($process.Path -and (Get-FullPath $process.Path) -eq $installedExecutable) {
          Stop-Process -Id $process.Id -Force -ErrorAction Stop
        }
      } catch {
        if ($_.Exception.Message -notmatch 'access|exited|cannot find') { throw }
      }
    }

    $installerProcess = Start-Process -FilePath $previousInstaller -ArgumentList @('/S', '--updated') -Wait -PassThru
    if ($installerProcess.ExitCode -ne 0) { throw "Rollback installer failed with exit code $($installerProcess.ExitCode)." }
    if (-not (Test-Path -LiteralPath $installedExecutable -PathType Leaf)) { throw 'Previous Subutai executable was not restored.' }

    $registrationScript = Join-Path (Split-Path -Parent $installedExecutable) 'resources\native-messaging\register-native-host.ps1'
    if (-not (Test-PathInside (Split-Path -Parent $installedExecutable) $registrationScript)) { throw 'Registration script path is invalid.' }
    if (-not (Test-Path -LiteralPath $registrationScript -PathType Leaf)) { throw 'Native-messaging registration script is missing after rollback.' }
    & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $registrationScript -ExecutablePath $installedExecutable
    if ($LASTEXITCODE -ne 0) { throw "Browser native-messaging registration failed with exit code $LASTEXITCODE." }
    Test-BrowserRegistration -ExecutablePath $installedExecutable
  }

  $journal = Read-Journal
  Assert-Journal $journal
  $journal.updateState = 'rolled-back'
  $journal.rollbackState = 'succeeded'
  $journal.rollbackCompletedAt = [DateTime]::UtcNow.ToString('o')
  $journal.lastError = 'New version did not pass startup health confirmation; previous verified version restored.'
  Save-Journal $journal
  Write-Evidence -Outcome 'rolled-back'

  if (-not $TestMode) {
    Start-Process -FilePath $installedExecutable | Out-Null
  }
  exit 0
} catch {
  $message = Protect-ErrorText $_.Exception.Message
  try {
    $journal = Read-Journal
    Assert-Journal $journal
    if (([string]$journal.updateState) -notin @('committed', 'rolled-back', 'failed-safe')) {
      Set-FailedSafe -Journal $journal -Reason $message
    } else {
      Write-Evidence -Outcome 'watchdog-error' -ErrorText $message
    }
  } catch {
    Write-Evidence -Outcome 'corrupt-journal-no-action' -ErrorText $message
  }
  Write-Error $message
  exit 2
}
