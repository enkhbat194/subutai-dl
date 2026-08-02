param(
  [string]$BaselineVersion = '0.1.0',
  [string]$TargetVersion = '0.2.0',
  [string]$Workspace = 'artifacts/real-update-acceptance',
  [ValidateRange(120, 1800)][int]$ScenarioTimeoutSeconds = 600
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:OS -ne 'Windows_NT') { throw 'Real update acceptance safety wrapper requires Windows.' }

$repoRoot = (Resolve-Path '.').Path
$harness = Join-Path $repoRoot 'scripts\real-two-installer-acceptance.ps1'
$desktopPackagePath = Join-Path $repoRoot 'apps\desktop\package.json'
$acceptanceAppId = 'com.subutai.downloadmanager.real-update-acceptance'
$workspacePath = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $Workspace))
$safetyRoot = Join-Path $env:RUNNER_TEMP ("SubutaiRealUpdateSafety-" + [guid]::NewGuid().ToString('N'))
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\SubutaiRealUpdateAcceptance'
$userDataDir = Join-Path $env:APPDATA 'Subutai Download Manager'
$updaterRoot = Join-Path $env:LOCALAPPDATA 'Subutai\Updater'
$nativeMessagingDir = Join-Path $env:LOCALAPPDATA 'Subutai Download Manager\NativeMessaging'
$registryKeys = @(
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.subutai.download_manager',
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.subutai.download_manager',
  'HKCU:\Software\Mozilla\NativeMessagingHosts\com.subutai.download_manager'
)
$directoryState = @()
$registryState = @()
$primaryFailure = $null
$restorationFailures = New-Object System.Collections.Generic.List[string]
$desktopPackageOriginal = Get-Content -LiteralPath $desktopPackagePath -Raw

function Write-Utf8NoBom {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Content)
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Set-AcceptanceAppIdentity {
  $package = Get-Content -LiteralPath $desktopPackagePath -Raw | ConvertFrom-Json
  if ($null -eq $package.build) { throw 'Desktop package has no electron-builder configuration.' }
  $package.build.appId = $acceptanceAppId
  Write-Utf8NoBom -Path $desktopPackagePath -Content (($package | ConvertTo-Json -Depth 40) + "`n")
}

function Stop-SubutaiProcesses {
  Get-Process -Name 'Subutai Download Manager' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
}

function Remove-BrowserRegistration {
  foreach ($key in $registryKeys) { Remove-Item -LiteralPath $key -Recurse -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $nativeMessagingDir -Recurse -Force -ErrorAction SilentlyContinue
}

function Copy-DirectoryContents {
  param([Parameter(Mandatory = $true)][string]$Source, [Parameter(Mandatory = $true)][string]$Destination)
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Get-ChildItem -LiteralPath $Source -Force -ErrorAction Stop |
    Copy-Item -Destination $Destination -Recurse -Force -ErrorAction Stop
}

function Capture-Directory {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Name)
  $existed = Test-Path -LiteralPath $Path
  $backup = Join-Path $safetyRoot $Name
  if ($existed) { Copy-DirectoryContents -Source $Path -Destination $backup }
  $script:directoryState += [ordered]@{ path = $Path; backup = $backup; existed = $existed }
}

function Restore-DirectoryState {
  foreach ($entry in $directoryState) {
    Remove-Item -LiteralPath ([string]$entry.path) -Recurse -Force -ErrorAction SilentlyContinue
    if ($entry.existed) {
      Copy-DirectoryContents -Source ([string]$entry.backup) -Destination ([string]$entry.path)
    }
  }
}

function Restore-RegistryState {
  foreach ($entry in $registryState) {
    Remove-Item -LiteralPath ([string]$entry.key) -Recurse -Force -ErrorAction SilentlyContinue
    if ($entry.existed) {
      New-Item -Path ([string]$entry.key) -Force | Out-Null
      Set-Item -LiteralPath ([string]$entry.key) -Value ([string]$entry.value) -Force
    }
  }
}

try {
  New-Item -ItemType Directory -Force -Path $safetyRoot | Out-Null
  foreach ($key in $registryKeys) {
    $exists = Test-Path -LiteralPath $key
    $registryState += [ordered]@{
      key = $key
      existed = $exists
      value = if ($exists) { [string](Get-Item -LiteralPath $key).GetValue('') } else { '' }
    }
  }
  Stop-SubutaiProcesses
  Capture-Directory -Path $userDataDir -Name 'user-data'
  Capture-Directory -Path $updaterRoot -Name 'updater'
  Capture-Directory -Path $nativeMessagingDir -Name 'native-messaging'
  Set-AcceptanceAppIdentity

  & $harness `
    -BaselineVersion $BaselineVersion `
    -TargetVersion $TargetVersion `
    -Workspace $Workspace `
    -ScenarioTimeoutSeconds $ScenarioTimeoutSeconds
} catch {
  $primaryFailure = $_
} finally {
  try { Stop-SubutaiProcesses } catch { $restorationFailures.Add("Stop processes: $($_.Exception.Message)") }
  try {
    if (Test-Path -LiteralPath $installDir) {
      $uninstaller = Get-ChildItem -LiteralPath $installDir -File -Filter 'Uninstall*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($uninstaller) {
        Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -Wait -ErrorAction SilentlyContinue | Out-Null
      }
    }
  } catch { $restorationFailures.Add("Uninstall acceptance app: $($_.Exception.Message)") }
  try { Stop-SubutaiProcesses } catch { $restorationFailures.Add("Stop post-uninstall processes: $($_.Exception.Message)") }
  try { Remove-Item -LiteralPath $installDir -Recurse -Force -ErrorAction SilentlyContinue } catch { $restorationFailures.Add("Remove acceptance install: $($_.Exception.Message)") }
  try { Remove-BrowserRegistration } catch { $restorationFailures.Add("Remove acceptance browser registration: $($_.Exception.Message)") }
  try { Restore-DirectoryState } catch { $restorationFailures.Add("Restore directories: $($_.Exception.Message)") }
  try { Restore-RegistryState } catch { $restorationFailures.Add("Restore registry: $($_.Exception.Message)") }
  try { Write-Utf8NoBom -Path $desktopPackagePath -Content $desktopPackageOriginal } catch { $restorationFailures.Add("Restore desktop package: $($_.Exception.Message)") }
  try { Remove-Item -LiteralPath (Join-Path $workspacePath 'pre-existing-state') -Recurse -Force -ErrorAction SilentlyContinue } catch { $restorationFailures.Add("Remove nested backup: $($_.Exception.Message)") }
  try { Remove-Item -LiteralPath $safetyRoot -Recurse -Force -ErrorAction SilentlyContinue } catch { $restorationFailures.Add("Remove safety backup: $($_.Exception.Message)") }
}

if ($primaryFailure) {
  if ($restorationFailures.Count -gt 0) {
    Write-Warning ("Runner restoration also reported: " + ($restorationFailures -join ' | '))
  }
  throw $primaryFailure
}
if ($restorationFailures.Count -gt 0) {
  throw "Real update acceptance passed but runner restoration failed: $($restorationFailures -join ' | ')"
}
