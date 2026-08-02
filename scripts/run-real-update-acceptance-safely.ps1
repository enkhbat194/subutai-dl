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
# Keep the production product/executable identity so the real transaction and watchdog
# validate exactly the same controlled executable name used by public builds.
$acceptanceProductName = 'Subutai Download Manager'
# electron-builder one-click per-user installers derive APP_FILENAME from the sanitized package name.
$acceptanceInstallDirectoryName = '@subutaidesktop'
$workspacePath = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $Workspace))
$safetyRoot = Join-Path $env:RUNNER_TEMP ("SubutaiRealUpdateSafety-" + [guid]::NewGuid().ToString('N'))
$installDir = Join-Path $env:LOCALAPPDATA "Programs\$acceptanceInstallDirectoryName"
$userDataDir = Join-Path $env:APPDATA $acceptanceProductName
$electronUpdaterCacheDir = Join-Path $env:LOCALAPPDATA '@subutaidesktop-updater'
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
$harnessOriginal = Get-Content -LiteralPath $harness -Raw

function Write-Utf8NoBom {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Content)
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Replace-ExactlyOnce {
  param(
    [Parameter(Mandatory = $true)][string]$Content,
    [Parameter(Mandatory = $true)][string]$Before,
    [Parameter(Mandatory = $true)][string]$After,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $first = $Content.IndexOf($Before, [System.StringComparison]::Ordinal)
  if ($first -lt 0) { throw "$Label source contract was not found." }
  if ($Content.IndexOf($Before, $first + $Before.Length, [System.StringComparison]::Ordinal) -ge 0) {
    throw "$Label source contract appeared more than once."
  }
  return $Content.Substring(0, $first) + $After + $Content.Substring($first + $Before.Length)
}

function Set-AcceptanceAppIdentity {
  $package = Get-Content -LiteralPath $desktopPackagePath -Raw | ConvertFrom-Json
  if ($null -eq $package.build) { throw 'Desktop package has no electron-builder configuration.' }
  if ($null -eq $package.build.nsis) { throw 'Desktop package has no NSIS configuration.' }
  $package.build.productName = $acceptanceProductName
  $package.build.appId = $acceptanceAppId
  $package.build.nsis.shortcutName = $acceptanceProductName
  $package.build.nsis.oneClick = $true
  $package.build.nsis.allowToChangeInstallationDirectory = $false
  $package.build.nsis | Add-Member -NotePropertyName perMachine -NotePropertyValue $false -Force
  $package.build.nsis | Add-Member -NotePropertyName allowElevation -NotePropertyValue $false -Force
  Write-Utf8NoBom -Path $desktopPackagePath -Content (($package | ConvertTo-Json -Depth 40) + "`n")
}

function Set-AcceptanceHarnessIdentity {
  $content = $harnessOriginal
  $content = Replace-ExactlyOnce -Content $content `
    -Before "`$installDir = Join-Path `$env:LOCALAPPDATA 'Programs\SubutaiRealUpdateAcceptance'" `
    -After "`$installDir = Join-Path `$env:LOCALAPPDATA 'Programs\@subutaidesktop'" `
    -Label 'Acceptance install directory'
  $content = Replace-ExactlyOnce -Content $content `
    -Before "  New-Item -ItemType Directory -Force -Path `$installDir | Out-Null`r`n  `$process = Start-Process -FilePath ([string]`$BaselineBuild.setupPath) -ArgumentList @('/S', `"/D=`$installDir`") -PassThru -Wait" `
    -After "  `$process = Start-Process -FilePath ([string]`$BaselineBuild.setupPath) -ArgumentList @('/S') -PassThru -Wait" `
    -Label 'Acceptance one-click baseline install'
  Write-Utf8NoBom -Path $harness -Content $content
}

function Stop-SubutaiProcesses {
  Get-Process -Name $acceptanceProductName -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue
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
  Capture-Directory -Path $userDataDir -Name 'product-user-data'
  Capture-Directory -Path $electronUpdaterCacheDir -Name 'electron-updater-cache'
  Capture-Directory -Path $updaterRoot -Name 'transactional-updater'
  Capture-Directory -Path $nativeMessagingDir -Name 'native-messaging'
  Set-AcceptanceAppIdentity
  Set-AcceptanceHarnessIdentity

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
  try { Write-Utf8NoBom -Path $harness -Content $harnessOriginal } catch { $restorationFailures.Add("Restore acceptance harness: $($_.Exception.Message)") }
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
