param(
  [string]$ReleaseDir = "apps/desktop/release"
)

$ErrorActionPreference = "Stop"
$releasePath = (Resolve-Path $ReleaseDir).Path
$package = Get-Content "apps/desktop/package.json" -Raw | ConvertFrom-Json
$version = [string]$package.version
$setup = @(Get-ChildItem $releasePath -File -Filter "Subutai-Setup-$version-*.exe")
$portable = @(Get-ChildItem $releasePath -File -Filter "Subutai-Portable-$version-*.exe")

if ($setup.Count -ne 1) { throw "Expected one Setup package; found $($setup.Count)." }
if ($portable.Count -ne 1) { throw "Expected one Portable package; found $($portable.Count)." }

$acceptanceRoot = Join-Path $env:RUNNER_TEMP "SubutaiN5Acceptance"
$installDir = Join-Path $acceptanceRoot "Installed"
$logDir = Join-Path $acceptanceRoot "Logs"
Remove-Item $acceptanceRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $installDir, $logDir | Out-Null

function Invoke-SmokeTest {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$Name,
    [int]$TimeoutMilliseconds = 45000
  )

  if (-not (Test-Path $Executable)) { throw "$Name executable was not found: $Executable" }
  $safeName = $Name -replace '[^A-Za-z0-9_-]', '-'
  $stdoutPath = Join-Path $logDir "$safeName.stdout.log"
  $stderrPath = Join-Path $logDir "$safeName.stderr.log"
  $runtimePath = Join-Path $logDir "$safeName.runtime.log"
  Remove-Item $stdoutPath, $stderrPath, $runtimePath -Force -ErrorAction SilentlyContinue

  $previousSmokeLog = $env:SUBUTAI_SMOKE_LOG
  $previousElectronLogging = $env:ELECTRON_ENABLE_LOGGING
  try {
    $env:SUBUTAI_SMOKE_LOG = $runtimePath
    $env:ELECTRON_ENABLE_LOGGING = "1"
    $process = Start-Process `
      -FilePath $Executable `
      -ArgumentList "--subutai-smoke-test" `
      -RedirectStandardOutput $stdoutPath `
      -RedirectStandardError $stderrPath `
      -PassThru

    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    $completed = $false
    while ([DateTime]::UtcNow -lt $deadline) {
      if (Test-Path $runtimePath) {
        $runtime = Get-Content $runtimePath -Raw -ErrorAction SilentlyContinue
        if ($runtime -match "Launch smoke completed successfully") {
          $completed = $true
          break
        }
      }

      if ($process.HasExited) {
        $process.WaitForExit()
        $process.Refresh()
        if ($null -ne $process.ExitCode -and $process.ExitCode -ne 0) {
          $stderr = if (Test-Path $stderrPath) { Get-Content $stderrPath -Raw } else { "" }
          throw "$Name launcher exited with $($process.ExitCode). $stderr"
        }
      }
      Start-Sleep -Milliseconds 250
    }

    if (-not $completed) {
      if (-not $process.HasExited) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      }
      $exitCode = if ($process.HasExited) {
        $process.WaitForExit()
        $process.Refresh()
        $process.ExitCode
      } else {
        "running"
      }
      $stderr = if (Test-Path $stderrPath) { Get-Content $stderrPath -Raw } else { "" }
      $runtime = if (Test-Path $runtimePath) { Get-Content $runtimePath -Raw } else { "" }
      throw "$Name did not complete its runtime smoke sequence within $TimeoutMilliseconds ms. Launcher exit=$exitCode. Runtime=$runtime Stderr=$stderr"
    }

    if (-not $process.HasExited) {
      $null = $process.WaitForExit(5000)
    }
    if ($process.HasExited) {
      $process.WaitForExit()
      $process.Refresh()
      if ($null -ne $process.ExitCode -and $process.ExitCode -ne 0) {
        $stderr = if (Test-Path $stderrPath) { Get-Content $stderrPath -Raw } else { "" }
        throw "$Name launcher exited with $($process.ExitCode) after runtime success. $stderr"
      }
    }

    $stderr = if (Test-Path $stderrPath) { Get-Content $stderrPath -Raw } else { "" }
    if ($stderr -match "Unable to load preload script|Cannot use import statement outside a module|Uncaught TypeError") {
      throw "$Name completed with a preload or renderer contract failure. $stderr"
    }
  } finally {
    $env:SUBUTAI_SMOKE_LOG = $previousSmokeLog
    $env:ELECTRON_ENABLE_LOGGING = $previousElectronLogging
  }
}

function Assert-PackagedResources {
  param([Parameter(Mandatory = $true)][string]$ApplicationRoot)

  $resources = Join-Path $ApplicationRoot "resources"
  $required = @(
    "engines\subutai-engine-host.exe",
    "engines\yt-dlp.exe",
    "engines\ffmpeg.exe",
    "browser-extension\BUILD_INFO.json",
    "browser-extension\chromium\manifest.json",
    "browser-extension\firefox\manifest.json",
    "native-messaging\register-native-host.ps1",
    "native-messaging\unregister-native-host.ps1"
  )
  foreach ($relativePath in $required) {
    $path = Join-Path $resources $relativePath
    if (-not (Test-Path $path)) { throw "Required packaged resource is missing: $path" }
  }
  if (Test-Path (Join-Path $resources "engines\aria2c.exe")) {
    throw "Legacy direct-download engine entered the production package."
  }

  $buildInfo = Get-Content (Join-Path $resources "browser-extension\BUILD_INFO.json") -Raw | ConvertFrom-Json
  if ($buildInfo.version -ne $version) { throw "Browser extension version does not match app version $version." }
  if ($buildInfo.chromiumExtensionId -ne "bblhcboekmbodhhgfonhggdhejlfgiep") {
    throw "Chromium extension identity changed unexpectedly."
  }
  if ($buildInfo.firefoxExtensionId -ne "subutai-download@subutai.local") {
    throw "Firefox extension identity changed unexpectedly."
  }
}

function Assert-NativeMessagingRegistration {
  param([Parameter(Mandatory = $true)][string]$InstalledExecutable)

  $hostName = "com.subutai.download_manager"
  $keys = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName",
    "HKCU:\Software\Mozilla\NativeMessagingHosts\$hostName"
  )
  foreach ($key in $keys) {
    if (-not (Test-Path $key)) { throw "Native messaging registry key is missing: $key" }
    $manifestPath = (Get-Item $key).GetValue("")
    if (-not $manifestPath -or -not (Test-Path $manifestPath)) {
      throw "Native messaging manifest is missing for $key."
    }
    $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
    if ([System.IO.Path]::GetFullPath([string]$manifest.path) -ne [System.IO.Path]::GetFullPath($InstalledExecutable)) {
      throw "Native messaging manifest points to the wrong executable: $manifestPath"
    }
  }
}

function Assert-NativeMessagingRemoved {
  $hostName = "com.subutai.download_manager"
  $keys = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName",
    "HKCU:\Software\Mozilla\NativeMessagingHosts\$hostName"
  )
  foreach ($key in $keys) {
    if (Test-Path $key) { throw "Native messaging registry key remained after uninstall: $key" }
  }
  $manifestDirectory = Join-Path $env:LOCALAPPDATA "Subutai Download Manager\NativeMessaging"
  if (Test-Path $manifestDirectory) {
    throw "Native messaging manifests remained after uninstall: $manifestDirectory"
  }
}

try {
  Invoke-SmokeTest -Executable $portable[0].FullName -Name "portable-package"
  Write-Host "Portable package launch acceptance passed."

  $installProcess = Start-Process `
    -FilePath $setup[0].FullName `
    -ArgumentList @("/S", "/D=$installDir") `
    -PassThru `
    -Wait
  $installProcess.WaitForExit()
  $installProcess.Refresh()
  if ($null -eq $installProcess.ExitCode -or $installProcess.ExitCode -ne 0) {
    throw "Silent Setup installation failed with exit code $($installProcess.ExitCode)."
  }

  $installedExecutable = Join-Path $installDir "Subutai Download Manager.exe"
  if (-not (Test-Path $installedExecutable)) {
    throw "Installed Subutai executable was not found: $installedExecutable"
  }
  Assert-PackagedResources -ApplicationRoot $installDir
  Assert-NativeMessagingRegistration -InstalledExecutable $installedExecutable
  Invoke-SmokeTest -Executable $installedExecutable -Name "installed-setup"
  Write-Host "Installed Setup launch and browser bridge registration passed."

  $uninstaller = Get-ChildItem $installDir -File -Filter "Uninstall*.exe" | Select-Object -First 1
  if (-not $uninstaller) { throw "Subutai uninstaller was not found in $installDir." }
  $uninstallProcess = Start-Process -FilePath $uninstaller.FullName -ArgumentList "/S" -PassThru -Wait
  $uninstallProcess.WaitForExit()
  $uninstallProcess.Refresh()
  if ($null -eq $uninstallProcess.ExitCode -or $uninstallProcess.ExitCode -ne 0) {
    throw "Silent uninstall failed with exit code $($uninstallProcess.ExitCode)."
  }

  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while ((Test-Path $installedExecutable) -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 250
  }
  if (Test-Path $installedExecutable) { throw "Installed executable remained after uninstall." }
  Assert-NativeMessagingRemoved
  Write-Host "Uninstall and browser bridge cleanup acceptance passed."

  Write-Host "Subutai N5 Windows Setup/Portable acceptance passed."
} finally {
  Get-Process -Name "Subutai Download Manager" -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue
  Remove-Item $acceptanceRoot -Recurse -Force -ErrorAction SilentlyContinue
}
