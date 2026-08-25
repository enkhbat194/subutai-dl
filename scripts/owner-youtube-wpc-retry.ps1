param(
  [string]$AppRoot = "",
  [string]$Url = "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  [string]$OutputRoot = ""
)

$ErrorActionPreference = "Stop"

function Resolve-AppRoot {
  param([string]$Requested)
  $candidates = New-Object System.Collections.Generic.List[string]
  if ($Requested) { $candidates.Add($Requested) }
  if ($env:SUBUTAI_APP_ROOT) { $candidates.Add($env:SUBUTAI_APP_ROOT) }
  $candidates.Add((Join-Path $PSScriptRoot "..\apps\desktop\release\win-unpacked"))
  $candidates.Add((Join-Path $PSScriptRoot "..\.."))
  if ($env:LOCALAPPDATA) { $candidates.Add((Join-Path $env:LOCALAPPDATA "Programs\Subutai Download Manager")) }
  foreach ($candidate in $candidates) {
    if (-not $candidate) { continue }
    try { $resolved = (Resolve-Path $candidate -ErrorAction Stop).Path } catch { continue }
    if (Test-Path (Join-Path $resolved "resources\engines\yt-dlp.exe")) { return $resolved }
  }
  throw "Subutai app root was not found. Build win-unpacked, install Subutai, or pass -AppRoot."
}

function Resolve-ChromiumBrowserPath {
  $candidates = New-Object System.Collections.Generic.List[string]
  if ($env:SUBUTAI_WPC_BROWSER_PATH) { $candidates.Add($env:SUBUTAI_WPC_BROWSER_PATH) }

  foreach ($registryPath in @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe",
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe",
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\brave.exe",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\brave.exe",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\brave.exe"
  )) {
    try {
      $value = (Get-ItemProperty -Path $registryPath -ErrorAction Stop).'(default)'
      if ($value) { $candidates.Add([string]$value) }
    } catch {
      # Registry discovery is best-effort; common filesystem locations are checked below.
    }
  }

  if ($env:PROGRAMFILES) {
    $candidates.Add((Join-Path $env:PROGRAMFILES "Google\Chrome\Application\chrome.exe"))
    $candidates.Add((Join-Path $env:PROGRAMFILES "Chromium\Application\chrome.exe"))
    $candidates.Add((Join-Path $env:PROGRAMFILES "Microsoft\Edge\Application\msedge.exe"))
    $candidates.Add((Join-Path $env:PROGRAMFILES "BraveSoftware\Brave-Browser\Application\brave.exe"))
  }
  if (${env:PROGRAMFILES(X86)}) {
    $candidates.Add((Join-Path ${env:PROGRAMFILES(X86)} "Google\Chrome\Application\chrome.exe"))
    $candidates.Add((Join-Path ${env:PROGRAMFILES(X86)} "Chromium\Application\chrome.exe"))
    $candidates.Add((Join-Path ${env:PROGRAMFILES(X86)} "Microsoft\Edge\Application\msedge.exe"))
    $candidates.Add((Join-Path ${env:PROGRAMFILES(X86)} "BraveSoftware\Brave-Browser\Application\brave.exe"))
  }
  if ($env:LOCALAPPDATA) {
    $candidates.Add((Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe"))
    $candidates.Add((Join-Path $env:LOCALAPPDATA "Chromium\Application\chrome.exe"))
    $candidates.Add((Join-Path $env:LOCALAPPDATA "Microsoft\Edge\Application\msedge.exe"))
    $candidates.Add((Join-Path $env:LOCALAPPDATA "BraveSoftware\Brave-Browser\Application\brave.exe"))
  }

  foreach ($candidate in $candidates) {
    if (-not $candidate) { continue }
    $trimmed = ([string]$candidate).Trim().Trim('"')
    if (Test-Path $trimmed -PathType Leaf) {
      try { return (Resolve-Path $trimmed -ErrorAction Stop).Path } catch { return $trimmed }
    }
  }

  foreach ($commandName in @("chrome.exe", "chromium.exe", "msedge.exe", "brave.exe")) {
    $command = Get-Command $commandName -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $command) { continue }
    if ($command.Source -and (Test-Path $command.Source -PathType Leaf)) { return $command.Source }
    if ($command.Path -and (Test-Path $command.Path -PathType Leaf)) { return $command.Path }
  }
  return $null
}

function Invoke-YtDlp {
  param([string]$Executable, [string[]]$Arguments, [string]$StdoutPath, [string]$StderrPath)
  Remove-Item $StdoutPath, $StderrPath -Force -ErrorAction SilentlyContinue
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & $Executable @Arguments 1> $StdoutPath 2> $StderrPath
    return $LASTEXITCODE
  } finally { $ErrorActionPreference = $previous }
}

function Test-PlayableMedia {
  param([string]$Path, [string]$Ffprobe)
  if (-not (Test-Path $Path) -or (Get-Item $Path).Length -lt 32KB) { return $false }
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $duration = & $Ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 $Path 2>$null
    $exitCode = $LASTEXITCODE
  } finally { $ErrorActionPreference = $previous }
  if ($exitCode -ne 0) { return $false }
  $parsed = 0.0
  return [double]::TryParse(([string]$duration).Trim(), [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$parsed) -and $parsed -gt 0
}

$app = Resolve-AppRoot -Requested $AppRoot
$engineDir = Join-Path $app "resources\engines"
$ytDlp = Join-Path $engineDir "yt-dlp.exe"
$ffprobe = Join-Path $engineDir "ffprobe.exe"
$node = Join-Path $engineDir "node.exe"
$providerPath = Join-Path $engineDir "yt-dlp-plugins\subutai-wpc\yt_dlp_plugins\extractor\getpot_wpc.py"
$manifestPath = Join-Path $engineDir "yt-dlp-plugins\subutai-wpc\subutai-wpc-manifest.json"
foreach ($required in @($ytDlp, $ffprobe, $node, $providerPath, $manifestPath)) {
  if (-not (Test-Path $required)) { throw "Packaged WPC owner retry dependency is missing: $required" }
}

$providerHome = Join-Path $engineDir "pot-provider\server"
if (Test-Path (Join-Path $providerHome "build\generate_once.js")) { $env:SUBUTAI_POT_SERVER_HOME = $providerHome }

$browserPath = Resolve-ChromiumBrowserPath
if ($browserPath) {
  Write-Host "Using Chromium-family browser for WPC token minting: $browserPath"
} else {
  Write-Warning "Chrome/Chromium/Edge/Brave was not resolved explicitly. WPC will use its own browser discovery. Set SUBUTAI_WPC_BROWSER_PATH to override."
}

if (-not $OutputRoot) { $OutputRoot = Join-Path ([System.IO.Path]::GetTempPath()) "SubutaiOwnerYouTubeWpcRetry" }
Remove-Item $OutputRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null

$routes = @(
  @{ Name = "mweb-wpc"; Client = "mweb"; Format = "worstvideo*+worstaudio/worst" },
  @{ Name = "mweb-wpc-hls"; Client = "mweb"; Format = "best[protocol^=m3u8]/worst" }
)
$records = New-Object System.Collections.Generic.List[object]
$routeNumber = 0
foreach ($route in $routes) {
  $routeNumber++
  $routeDir = Join-Path $OutputRoot ("{0:D2}-{1}" -f $routeNumber, $route.Name)
  New-Item -ItemType Directory -Force -Path $routeDir | Out-Null
  $stdout = Join-Path $routeDir "youtube.stdout.log"
  $stderr = Join-Path $routeDir "youtube.stderr.log"
  $template = Join-Path $routeDir "subutai-owner-youtube.%(ext)s"
  $args = @(
    "--verbose",
    "--no-playlist",
    "--newline",
    "--continue",
    "--part",
    "--socket-timeout", "45",
    "--retries", "3",
    "--fragment-retries", "3",
    "--js-runtimes", "node:$node",
    "--ffmpeg-location", $engineDir,
    "--extractor-args", "youtube:player_client=$($route.Client)",
    "--format", $route.Format,
    "--merge-output-format", "mp4",
    "--output", $template
  )
  if ($browserPath) {
    $args += @("--extractor-args", "youtubepot-wpc:browser_path=$browserPath")
  }
  $args += $Url

  Write-Host "Trying packaged browser-minted WPC owner route: $($route.Name)"
  $exitCode = Invoke-YtDlp -Executable $ytDlp -Arguments $args -StdoutPath $stdout -StderrPath $stderr
  $combined = ([string](Get-Content $stdout -Raw -ErrorAction SilentlyContinue)) + "`n" + ([string](Get-Content $stderr -Raw -ErrorAction SilentlyContinue))
  $providerLoaded = $combined -match '(?im)PO Token Providers:.*\bwpc-1\.1\.2\b' -or $combined -match '(?im)\bwpc-1\.1\.2\s*\(external\)'
  $media = Get-ChildItem $routeDir -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "subutai-owner-youtube.*" -and $_.Extension -notin @(".part", ".ytdl", ".log", ".json") } |
    Sort-Object Length -Descending |
    Select-Object -First 1
  $playable = $false
  if ($media) { $playable = Test-PlayableMedia -Path $media.FullName -Ffprobe $ffprobe }
  $records.Add([pscustomobject]@{
    route = $route.Name
    exitCode = $exitCode
    providerLoaded = $providerLoaded
    playableMedia = $playable
    browserPath = $browserPath
    stdout = $stdout
    stderr = $stderr
  })
  $records | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $OutputRoot "wpc-retry-summary.json") -Encoding UTF8

  if (-not $providerLoaded) {
    throw "Packaged yt-dlp did not load the browser-minted WPC provider. Evidence: $OutputRoot"
  }
  if ($exitCode -eq 0 -and $media -and $playable) {
    Write-Host "Playable media: $($media.FullName)"
    Write-Host "SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PASS"
    exit 0
  }
}

Write-Host "Packaged WPC routes did not produce playable YouTube media. Evidence: $OutputRoot"
Write-Host "SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PENDING"
exit 2
