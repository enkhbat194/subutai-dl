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

  & $harness `
    -BaselineVersion $BaselineVersion `
    -TargetVersion $TargetVersion `
    -Workspace $Workspace `
    -ScenarioTimeoutSeconds $ScenarioTimeoutSeconds
} finally {
  Stop-SubutaiProcesses
  if (Test-Path -LiteralPath $installDir) {
    $uninstaller = Get-ChildItem -LiteralPath $installDir -File -Filter 'Uninstall*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($uninstaller) {
      Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -Wait -ErrorAction SilentlyContinue | Out-Null
    }
  }
  Stop-SubutaiProcesses
  Remove-Item -LiteralPath $installDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-BrowserRegistration
  Restore-DirectoryState
  foreach ($entry in $registryState) {
    Remove-Item -LiteralPath ([string]$entry.key) -Recurse -Force -ErrorAction SilentlyContinue
    if ($entry.existed) {
      New-Item -Path ([string]$entry.key) -Force | Out-Null
      (Get-Item -LiteralPath ([string]$entry.key)).SetValue('', [string]$entry.value)
    }
  }
  Remove-Item -LiteralPath (Join-Path $workspacePath 'pre-existing-state') -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $safetyRoot -Recurse -Force -ErrorAction SilentlyContinue
}
