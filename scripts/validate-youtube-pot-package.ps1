param(
  [string]$AppRoot = "apps/desktop/release/win-unpacked"
)

$ErrorActionPreference = "Stop"

$resolvedAppRoot = (Resolve-Path $AppRoot).Path
$engineDir = Join-Path $resolvedAppRoot "resources\engines"
$configPath = Join-Path $engineDir "yt-dlp.conf"
$providerRoot = Join-Path $engineDir "pot-provider"
$serverHome = Join-Path $providerRoot "server"
$pluginRoot = Join-Path $engineDir "yt-dlp-plugins\bgutil-ytdlp-pot-provider\yt_dlp_plugins\extractor"

$required = @(
  (Join-Path $serverHome "build\generate_once.js"),
  (Join-Path $serverHome "node_modules"),
  (Join-Path $pluginRoot "getpot_bgutil.py"),
  (Join-Path $pluginRoot "getpot_bgutil_script.py"),
  (Join-Path $providerRoot "LICENSE"),
  (Join-Path $providerRoot "README.md"),
  (Join-Path $providerRoot "SUBUTAI-PROVENANCE.txt"),
  (Join-Path $providerRoot "source\plugin"),
  (Join-Path $providerRoot "source\src"),
  $configPath
)
foreach ($path in $required) {
  if (-not (Test-Path $path)) {
    throw "Packaged YouTube PO-token provider item is missing: $path"
  }
}

$provenance = Get-Content (Join-Path $providerRoot "SUBUTAI-PROVENANCE.txt") -Raw
if ($provenance -notmatch "version=1\.3\.1" -or
    $provenance -notmatch "commit=495a47f7e9d442addc7b7f03c2751001558bb983" -or
    $provenance -notmatch "upstream-fix=PR-243-homepage-challenge-ytcfg" -or
    $provenance -notmatch "license=GPL-3\.0-only") {
  throw "Packaged YouTube PO-token provider provenance is incomplete or unexpected."
}

$config = Get-Content $configPath -Raw
if ($config -notmatch "player_client=default,web_embedded(?:\r?\n|$)") {
  throw "Packaged yt-dlp config is missing the compatible default/web_embedded YouTube path."
}
if ($config -match "player_client=default,web_embedded,") {
  throw "Packaged yt-dlp global config must not combine android_vr/web_safari or other fallback clients after web_embedded."
}
if ($config -match "player_client=mweb,default") {
  throw "Packaged yt-dlp config must not force mweb ahead of current stable clients."
}
if ($config -notmatch "youtubepot-bgutilscript:server_home=%SUBUTAI_POT_SERVER_HOME%") {
  throw "Packaged yt-dlp config is missing the local PO-token script provider binding."
}

$node = Join-Path $engineDir "node.exe"
$providerScript = Join-Path $serverHome "build\generate_once.js"
$versionOutput = & $node $providerScript --version 2>&1 | Select-Object -Last 1
if ($LASTEXITCODE -ne 0 -or ([string]$versionOutput).Trim() -ne "1.3.1") {
  throw "Packaged YouTube PO-token provider runtime version check failed; received: $versionOutput"
}

Write-Host "Packaged YouTube PO-token provider validation passed."
Write-Host "Provider runtime: bgutil-ytdlp-pot-provider 1.3.1"
Write-Host "Pinned upstream commit: 495a47f7e9d442addc7b7f03c2751001558bb983 (merged PR #243 homepage challenge + ytcfg fix)"
Write-Host "Default YouTube clients: default,web_embedded only; isolated mweb/web_embedded/tv_embedded/web_safari/android_vr remain bounded owner fallbacks."
