param(
  [Parameter(Mandatory = $true)][string]$TransactionPath,
  [ValidateRange(0, 2147483647)][int]$ParentProcessId = 0,
  [string]$LauncherLogPath = '',
  [string]$WatchdogMutexName = 'Local\SubutaiUpdaterWatchdog',
  [ValidateRange(100, 10000)][int]$PollMilliseconds = 1000,
  [switch]$TestMode,
  [string]$TestAllowedInstallRoot = '',
  [string]$TestRollbackMarker = '',
  [switch]$WorkerMode
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$transactionFullPath = [System.IO.Path]::GetFullPath($TransactionPath)
$root = Split-Path -Parent $transactionFullPath
$script:watchdogLogPath = if ([string]::IsNullOrWhiteSpace($LauncherLogPath)) {
  Join-Path $root 'watchdog-launcher.log'
} else {
  [System.IO.Path]::GetFullPath($LauncherLogPath)
}

function Write-WatchdogLog {
  param([Parameter(Mandatory = $true)][string]$Message)
  $directory = Split-Path -Parent $script:watchdogLogPath
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $line = "{0} {1}`n" -f [DateTime]::UtcNow.ToString('o'), $Message
  [System.IO.File]::AppendAllText($script:watchdogLogPath, $line, (New-Object System.Text.UTF8Encoding($false)))
}

function Quote-ProcessArgument {
  param([Parameter(Mandatory = $true)][string]$Value)
  if ($Value.Contains('"')) { throw 'Watchdog process argument contains an invalid quote.' }
  return '"' + $Value + '"'
}

if (-not $WorkerMode) {
  Write-WatchdogLog "watchdog-bootstrap-started pid=$PID transaction=$transactionFullPath"
  $powerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  if (-not (Test-Path -LiteralPath $powerShellPath -PathType Leaf)) { $powerShellPath = 'powershell.exe' }
  $workerArguments = @(
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', (Quote-ProcessArgument $PSCommandPath),
    '-TransactionPath', (Quote-ProcessArgument $transactionFullPath),
    '-ParentProcessId', [string]$ParentProcessId,
    '-LauncherLogPath', (Quote-ProcessArgument $script:watchdogLogPath),
    '-WatchdogMutexName', (Quote-ProcessArgument $WatchdogMutexName),
    '-PollMilliseconds', [string]$PollMilliseconds,
    '-WorkerMode'
  )
  if ($TestMode) {
    $workerArguments += '-TestMode'
    $workerArguments += @('-TestAllowedInstallRoot', (Quote-ProcessArgument $TestAllowedInstallRoot))
    $workerArguments += @('-TestRollbackMarker', (Quote-ProcessArgument $TestRollbackMarker))
  }

  $startupOffset = if (Test-Path -LiteralPath $script:watchdogLogPath) {
    (Get-Item -LiteralPath $script:watchdogLogPath).Length
  } else { 0 }
  $worker = Start-Process -FilePath $powerShellPath -ArgumentList $workerArguments -WorkingDirectory $root -WindowStyle Hidden -PassThru
  Write-WatchdogLog "watchdog-worker-created pid=$($worker.Id) workingDirectory=$root"
  $startupDeadline = [DateTime]::UtcNow.AddSeconds(5)
  while ([DateTime]::UtcNow -lt $startupDeadline) {
    if (Test-Path -LiteralPath $script:watchdogLogPath) {
      $stream = [System.IO.File]::Open(
        $script:watchdogLogPath,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::ReadWrite
      )
      try {
        $stream.Position = [Math]::Min($startupOffset, $stream.Length)
        $reader = New-Object System.IO.StreamReader($stream, (New-Object System.Text.UTF8Encoding($false)))
        try { $startupLog = $reader.ReadToEnd() } finally { $reader.Dispose() }
      } finally { $stream.Dispose() }
      if ($startupLog.Contains('watchdog-started')) {
        if ($TestMode) {
          $worker.WaitForExit()
          Write-WatchdogLog "watchdog-bootstrap-finished workerPid=$($worker.Id) workerExitCode=$($worker.ExitCode)"
          exit $worker.ExitCode
        }
        Write-WatchdogLog "watchdog-bootstrap-finished workerPid=$($worker.Id)"
        exit 0
      }
    }
    $worker.Refresh()
    if ($worker.HasExited) { throw "Watchdog worker exited before startup acknowledgement with code $($worker.ExitCode)." }
    Start-Sleep -Milliseconds 50
  }
  try { Stop-Process -Id $worker.Id -Force -ErrorAction SilentlyContinue } catch { }
  throw 'Watchdog worker did not acknowledge startup within 5000ms.'
}

Write-WatchdogLog "watchdog-started pid=$PID transaction=$transactionFullPath workingDirectory=$([Environment]::CurrentDirectory)"

$mutex = $null
$mutexCreatedNew = $false
$mutexOwned = $false

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

if ([System.IO.Path]::GetFileName($transactionFullPath) -ne 'update-transaction.json') {
  throw 'Transaction file name is not controlled by Subutai.'
}

function Wait-InstallTreeUnlocked {
  param(
    [Parameter(Mandatory = $true)][string]$Directory,
    [ValidateRange(1, 120)][int]$TimeoutSeconds = 30
  )
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $reportedPaths = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  do {
    $lockedPaths = New-Object System.Collections.Generic.List[string]
    $fileCount = 0
    foreach ($file in Get-ChildItem -LiteralPath $Directory -Recurse -File -Force -ErrorAction Stop) {
      $fileCount++
      $stream = $null
      try {
        $stream = [System.IO.File]::Open(
          $file.FullName,
          [System.IO.FileMode]::Open,
          [System.IO.FileAccess]::Read,
          [System.IO.FileShare]::None
        )
      } catch {
        $lockedPaths.Add($file.FullName)
        if ($reportedPaths.Add($file.FullName)) { Write-WatchdogLog "target-file-locked path=$($file.FullName)" }
      } finally {
        if ($null -ne $stream) { $stream.Dispose() }
      }
    }
    if ($lockedPaths.Count -eq 0) {
      Write-WatchdogLog "target-files-unlocked count=$fileCount"
      return
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Installed Subutai files remained locked after $TimeoutSeconds seconds: $($lockedPaths.Count)."
}
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

function Get-JournalProperty {
  param(
    [Parameter(Mandatory = $true)]$Journal,
    [Parameter(Mandatory = $true)][string]$Name
  )
  $property = $Journal.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

function Set-JournalProperty {
  param(
    [Parameter(Mandatory = $true)]$Journal,
    [Parameter(Mandatory = $true)][string]$Name,
    $Value
  )
  $property = $Journal.PSObject.Properties[$Name]
  if ($null -eq $property) {
    $Journal | Add-Member -MemberType NoteProperty -Name $Name -Value $Value
    return
  }
  $property.Value = $Value
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
  Set-JournalProperty -Journal $Journal -Name 'lastError' -Value (Protect-ErrorText $Reason)
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
  if (-not $TestMode -and $WatchdogMutexName -ne 'Local\SubutaiUpdaterWatchdog') {
    throw 'Production watchdog mutex name cannot be overridden.'
  }
  $mutex = [System.Threading.Mutex]::new($true, $WatchdogMutexName, [ref]$mutexCreatedNew)
  $mutexOwned = $mutexCreatedNew
  Write-WatchdogLog "mutex-created createdNew=$($mutexCreatedNew.ToString().ToLowerInvariant()) name=$WatchdogMutexName"
  if (-not $mutexCreatedNew) {
    Write-WatchdogLog 'already-running'
    exit 0
  }

  if (-not $TestMode) {
    $expectedRoot = Get-FullPath (Join-Path $env:LOCALAPPDATA 'Subutai\Updater')
    if ($root -ne $expectedRoot) { throw 'Updater root is not the controlled Subutai updater directory.' }
  }

  $journal = Read-Journal
  Assert-Journal $journal
  Write-WatchdogLog "transaction-loaded transaction=$([string]$journal.transactionId) state=$([string]$journal.updateState)"

  if ($ParentProcessId -gt 0) {
    Write-WatchdogLog "parent-wait-started pid=$ParentProcessId"
    try { Wait-Process -Id $ParentProcessId -Timeout 120 -ErrorAction Stop }
    catch {
      if (Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue) {
        throw 'Previous Subutai process did not exit before updater watchdog timeout.'
      }
    }
    Write-WatchdogLog "parent-exited pid=$ParentProcessId"
  } else {
    Write-WatchdogLog 'parent-not-running pid=0'
  }

  $hardDeadline = [DateTime]::UtcNow.AddMinutes(15)
  Write-WatchdogLog "health-deadline-wait deadline=$([string]$journal.healthDeadline)"
  while ($true) {
    $journal = Read-Journal
    Assert-Journal $journal
    $state = [string]$journal.updateState
    if ($state -in @('committed', 'rolled-back', 'failed-safe')) {
      Write-Evidence -Outcome $state
      Write-WatchdogLog "watchdog-completed outcome=$state"
      exit 0
    }
    if ($state -ne 'awaiting-health') {
      Write-Evidence -Outcome "no-action-$state"
      Write-WatchdogLog "watchdog-completed outcome=no-action-$state"
      exit 0
    }
    $intentionalExitAt = Get-JournalProperty -Journal $journal -Name 'intentionalExitAt'
    if (-not [string]::IsNullOrWhiteSpace([string]$intentionalExitAt)) {
      Write-Evidence -Outcome 'intentional-exit-no-rollback'
      Write-WatchdogLog 'watchdog-completed outcome=intentional-exit-no-rollback'
      exit 0
    }

    $healthDeadline = [DateTime]::Parse([string]$journal.healthDeadline).ToUniversalTime()
    $attemptLimitReached = [int]$journal.startupAttemptCount -ge [int]$journal.maxStartupAttempts
    if ($attemptLimitReached -or [DateTime]::UtcNow -ge $healthDeadline) { break }
    if ([DateTime]::UtcNow -ge $hardDeadline) { throw 'Updater watchdog exceeded its bounded monitoring window.' }
    Start-Sleep -Milliseconds $PollMilliseconds
  }

  Write-WatchdogLog "rollback-triggered transaction=$([string]$journal.transactionId)"

  if ([int]$journal.rollbackAttemptCount -ge 1 -or [string]$journal.rollbackState -in @('running', 'succeeded', 'blocked')) {
    Set-FailedSafe -Journal $journal -Reason 'Rollback attempt is already consumed; refusing an update/rollback loop.'
    exit 3
  }

  $journal.rollbackAttemptCount = 1
  $journal.rollbackState = 'running'
  $journal.updateState = 'rollback-running'
  Set-JournalProperty -Journal $journal -Name 'rollbackStartedAt' -Value ([DateTime]::UtcNow.ToString('o'))
  Save-Journal $journal

  $previousInstaller = Get-FullPath ([string]$journal.previousInstallerPath)
  if (-not (Test-Path -LiteralPath $previousInstaller -PathType Leaf)) {
    Set-FailedSafe -Journal $journal -Reason 'Verified previous installer is missing.'
    exit 4
  }
  Write-WatchdogLog "previous-installer-path-validated path=$previousInstaller"
  $actualHash = (Get-FileHash -LiteralPath $previousInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne [string]$journal.previousInstallerSha256) {
    Set-FailedSafe -Journal $journal -Reason 'Previous installer checksum mismatch; rollback executable was not launched.'
    exit 5
  }
  Write-WatchdogLog "previous-installer-sha256-verified sha256=$actualHash"

  $installedExecutable = Get-FullPath ([string]$journal.installedExecutablePath)
  $installedDirectory = Split-Path -Parent $installedExecutable
  $processExitDeadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    $installedProcessesFound = $false
    foreach ($process in Get-Process -ErrorAction SilentlyContinue) {
      try { $processPath = if ($process.Path) { Get-FullPath $process.Path } else { '' } } catch { continue }
      if (-not [string]::IsNullOrWhiteSpace($processPath) -and (Test-PathInside $installedDirectory $processPath)) {
        $installedProcessesFound = $true
        Write-WatchdogLog "target-process-stop pid=$($process.Id) path=$processPath"
        try { Stop-Process -Id $process.Id -Force -ErrorAction Stop } catch {
          if ($_.Exception.Message -notmatch 'exited|cannot find') { throw }
        }
      }
    }
    if (-not $installedProcessesFound) { break }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $processExitDeadline)
  if ($installedProcessesFound) { throw 'Installed Subutai processes did not exit within 15 seconds.' }
  Write-WatchdogLog "target-process-tree-closed directory=$installedDirectory"
  Wait-InstallTreeUnlocked -Directory $installedDirectory -TimeoutSeconds 30

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
    Write-WatchdogLog "target-process-closed executable=$installedExecutable"

    Write-WatchdogLog "rollback-installer-started path=$previousInstaller"
    # Keep the rollback non-interactive and preserve application data. The baseline
    # is restarted explicitly only after registration and the journal are restored.
    $installerProcess = Start-Process -FilePath $previousInstaller -ArgumentList @('/S', '--updated') -Wait -PassThru
    Write-WatchdogLog "rollback-installer-exit code=$($installerProcess.ExitCode)"
    if ($installerProcess.ExitCode -ne 0) { throw "Rollback installer failed with exit code $($installerProcess.ExitCode)." }
    if (-not (Test-Path -LiteralPath $installedExecutable -PathType Leaf)) { throw 'Previous Subutai executable was not restored.' }

    $registrationScript = Join-Path (Split-Path -Parent $installedExecutable) 'resources\native-messaging\register-native-host.ps1'
    if (-not (Test-PathInside (Split-Path -Parent $installedExecutable) $registrationScript)) { throw 'Registration script path is invalid.' }
    if (-not (Test-Path -LiteralPath $registrationScript -PathType Leaf)) { throw 'Native-messaging registration script is missing after rollback.' }
    & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $registrationScript -ExecutablePath $installedExecutable
    if ($LASTEXITCODE -ne 0) { throw "Browser native-messaging registration failed with exit code $LASTEXITCODE." }
    Test-BrowserRegistration -ExecutablePath $installedExecutable
    Write-WatchdogLog 'browser-registration-restored'
  }

  $journal = Read-Journal
  Assert-Journal $journal
  $journal.updateState = 'rolled-back'
  $journal.rollbackState = 'succeeded'
  Set-JournalProperty -Journal $journal -Name 'rollbackCompletedAt' -Value ([DateTime]::UtcNow.ToString('o'))
  Set-JournalProperty -Journal $journal -Name 'lastError' -Value 'New version did not pass startup health confirmation; previous verified version restored.'
  Save-Journal $journal
  Write-WatchdogLog 'rollback-journal-written state=rolled-back rollbackState=succeeded'
  Write-Evidence -Outcome 'rolled-back'

  if (-not $TestMode) {
    Start-Process -FilePath $installedExecutable | Out-Null
    Write-WatchdogLog "baseline-restarted executable=$installedExecutable"
  }
  Write-WatchdogLog 'watchdog-completed outcome=rolled-back'
  exit 0
} catch {
  $message = Protect-ErrorText $_.Exception.Message
  $errorType = Protect-ErrorText $_.Exception.GetType().FullName
  Write-WatchdogLog "watchdog-error type=$errorType message=$message"
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
  Write-Error $message -ErrorAction Continue
  exit 2
} finally {
  if ($null -ne $mutex) {
    if ($mutexOwned) {
      try { $mutex.ReleaseMutex() } catch { }
    }
    $mutex.Dispose()
  }
  try { Write-WatchdogLog 'watchdog-finished' } catch { }
}
