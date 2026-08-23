param(
  [string]$EngineDir = "apps/desktop/resources/engines/win32-x64"
)

$ErrorActionPreference = "Stop"

$providerVersion = "1.3.1"
$providerCommit = "7608dd51ee813b48cf9a6d68c6e42cb197ce10e0"
$providerRepository = "https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git"

$tempBase = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$tempRoot = Join-Path $tempBase "SubutaiYouTubePotProvider"
$checkoutRoot = Join-Path $tempRoot "source"
$pluginRoot = Join-Path $EngineDir "yt-dlp-plugins\bgutil-ytdlp-pot-provider"
$runtimeRoot = Join-Path $EngineDir "pot-provider"
$serverRuntime = Join-Path $runtimeRoot "server"
$sourceRuntime = Join-Path $runtimeRoot "source"
$configPath = Join-Path $EngineDir "yt-dlp.conf"

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$FailureMessage
  )

  & $Executable @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$FailureMessage (exit $LASTEXITCODE)."
  }
}

try {
  if (-not (Test-Path $EngineDir)) {
    throw "Subutai media engine directory does not exist: $EngineDir"
  }
  foreach ($binary in @("yt-dlp.exe", "node.exe")) {
    if (-not (Test-Path (Join-Path $EngineDir $binary))) {
      throw "Stage the Subutai media tools before the PO-token provider; missing $binary."
    }
  }

  Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $pluginRoot, $runtimeRoot -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $tempRoot, $pluginRoot, $serverRuntime, $sourceRuntime | Out-Null

  Invoke-Checked -Executable "git" -Arguments @("clone", "--filter=blob:none", "--no-checkout", $providerRepository, $checkoutRoot) -FailureMessage "Unable to clone the pinned YouTube PO-token provider"
  Invoke-Checked -Executable "git" -Arguments @("-C", $checkoutRoot, "checkout", "--detach", $providerCommit) -FailureMessage "Unable to check out the pinned YouTube PO-token provider commit"
  $actualCommit = (& git -C $checkoutRoot rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $actualCommit -ne $providerCommit) {
    throw "YouTube PO-token provider commit verification failed. Expected $providerCommit; received $actualCommit."
  }

  $serverSource = Join-Path $checkoutRoot "server"
  Push-Location $serverSource
  try {
    Invoke-Checked -Executable "npm" -Arguments @("ci", "--no-audit", "--no-fund") -FailureMessage "YouTube PO-token provider dependency installation failed"
    Invoke-Checked -Executable "npx" -Arguments @("tsc") -FailureMessage "YouTube PO-token provider TypeScript build failed"
    Invoke-Checked -Executable "npm" -Arguments @("prune", "--omit=dev", "--no-audit", "--no-fund") -FailureMessage "YouTube PO-token provider production dependency prune failed"
  } finally {
    Pop-Location
  }

  $generateOnce = Join-Path $serverSource "build\generate_once.js"
  if (-not (Test-Path $generateOnce)) {
    throw "Pinned YouTube PO-token provider build did not produce build\generate_once.js."
  }

  Copy-Item (Join-Path $checkoutRoot "plugin\yt_dlp_plugins") $pluginRoot -Recurse -Force
  foreach ($serverItem in @("build", "node_modules", "package.json", "package-lock.json")) {
    $sourcePath = Join-Path $serverSource $serverItem
    if (-not (Test-Path $sourcePath)) {
      throw "Pinned YouTube PO-token provider runtime item is missing: $sourcePath"
    }
    Copy-Item $sourcePath $serverRuntime -Recurse -Force
  }

  # Ship the exact provider source and license beside the runtime so the owner-test
  # package preserves the GPL-3.0 redistribution boundary instead of hiding provenance.
  Copy-Item (Join-Path $checkoutRoot "LICENSE") $runtimeRoot -Force
  Copy-Item (Join-Path $checkoutRoot "README.md") $runtimeRoot -Force
  Copy-Item (Join-Path $checkoutRoot "plugin") $sourceRuntime -Recurse -Force
  Copy-Item (Join-Path $checkoutRoot "server\src") $sourceRuntime -Recurse -Force
  Copy-Item (Join-Path $checkoutRoot "server\package.json") $sourceRuntime -Force
  Copy-Item (Join-Path $checkoutRoot "server\package-lock.json") $sourceRuntime -Force
  @(
    "bgutil-ytdlp-pot-provider",
    "version=$providerVersion",
    "commit=$providerCommit",
    "license=GPL-3.0-only",
    "source=https://github.com/Brainicism/bgutil-ytdlp-pot-provider"
  ) | Set-Content -Path (Join-Path $runtimeRoot "SUBUTAI-PROVENANCE.txt") -Encoding ascii

  $portableConfig = @(
    "--extractor-args youtube:player_client=mweb,default,android_vr,web_embedded,web_safari",
    "--extractor-args youtubepot-bgutilscript:server_home=%SUBUTAI_POT_SERVER_HOME%"
  ) -join "`r`n"
  [System.IO.File]::WriteAllText(
    $configPath,
    $portableConfig + "`r`n",
    (New-Object System.Text.UTF8Encoding($false))
  )

  $required = @(
    (Join-Path $pluginRoot "yt_dlp_plugins\extractor\getpot_bgutil.py"),
    (Join-Path $pluginRoot "yt_dlp_plugins\extractor\getpot_bgutil_script.py"),
    (Join-Path $serverRuntime "build\generate_once.js"),
    (Join-Path $runtimeRoot "LICENSE"),
    $configPath
  )
  foreach ($path in $required) {
    if (-not (Test-Path $path)) {
      throw "Staged YouTube PO-token provider item is missing: $path"
    }
  }

  $configText = Get-Content $configPath -Raw
  if ($configText -notmatch "player_client=mweb,default,android_vr,web_embedded,web_safari" -or
      $configText -notmatch "youtubepot-bgutilscript:server_home=%SUBUTAI_POT_SERVER_HOME%") {
    throw "Subutai yt-dlp configuration does not enable the pinned PO-token provider."
  }

  Write-Host "Pinned YouTube PO-token provider $providerVersion ($providerCommit) staged for Subutai."
  Write-Host "Runtime: $serverRuntime"
  Write-Host "Plugin: $pluginRoot"
} finally {
  Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
