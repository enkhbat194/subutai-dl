param(
  [string]$AppRoot = "",
  [string]$Url = "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  [string]$Browser = "auto",
  [int]$AttemptsPerRoute = 3,
  [string]$OutputRoot = ""
)

$ErrorActionPreference = "Stop"

function Resolve-AppRoot {
  param([string]$Requested)
  $candidates = New-Object System.Collections.Generic.List[string]
  if ($Requested) { $candidates.Add($Requested) }
  if ($env:SUBUTAI_APP_ROOT) { $candidates.Add($env:SUBUTAI_APP_ROOT) }
  $candidates.Add((Join-Path $PSScriptRoot "..\apps\desktop\release\win-unpacked"))
  if ($env:LOCALAPPDATA) {
    $candidates.Add((Join-Path $env:LOCALAPPDATA "Programs\Subutai Download Manager"))
  }
  foreach ($candidate in $candidates) {
    if (-not $candidate) { continue }
    try { $resolved = (Resolve-Path $candidate -ErrorAction Stop).Path } catch { continue }
    if (Test-Path (Join-Path $resolved "resources\engines\yt-dlp.exe")) { return $resolved }
  }
  throw "Subutai app root was not found. Build win-unpacked, install Subutai, or pass -AppRoot."
}

function Invoke-YtDlp {
  param([string]$Executable, [string[]]$Arguments, [string]$StdoutPath, [string]$StderrPath)
  Remove-Item $StdoutPath, $StderrPath -Force -ErrorAction SilentlyContinue
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & $Executable @Arguments 1> $StdoutPath 2> $StderrPath
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
}

function Test-PlayableMedia {
  param([string]$Path, [string]$Ffprobe)
  if (-not (Test-Path $Path)) { return $false }
  if ((Get-Item $Path).Length -lt 32KB) { return $false }
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $duration = & $Ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 $Path 2>$null
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  if ($exitCode -ne 0) { return $false }
  $parsed = 0.0
  return [double]::TryParse(([string]$duration).Trim(), [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$parsed) -and $parsed -gt 0
}

function Read-Diagnostic {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return "" }
  return [string](Get-Content $Path -Raw -ErrorAction SilentlyContinue)
}

function Test-TransientYouTubeFailure {
  param([string]$Diagnostic)
  if (-not $Diagnostic) { return $false }
  return $Diagnostic -match 'HTTP(?: Response)? Error:? 403|403 Forbidden|page needs to be reloaded|Sign in to confirm|not a bot|LOGIN_REQUIRED|Requested format is not available|fragment.*failed'
}

function Get-BrowserCandidates {
  param([string]$Requested)
  if ($Requested -and $Requested -ne 'auto') { return @($Requested) }
  $result = New-Object System.Collections.Generic.List[string]
  $result.Add('none')
  if ($env:APPDATA -and (Test-Path (Join-Path $env:APPDATA 'Mozilla\Firefox'))) { $result.Add('firefox') }
  if ($env:LOCALAPPDATA) {
    if (Test-Path (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data')) { $result.Add('chrome') }
    if (Test-Path (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data')) { $result.Add('edge') }
    if (Test-Path (Join-Path $env:LOCALAPPDATA 'BraveSoftware\Brave-Browser\User Data')) { $result.Add('brave') }
  }
  foreach ($fallback in @('firefox','chrome','edge','brave')) {
    if (-not $result.Contains($fallback)) { $result.Add($fallback) }
  }
  return @($result)
}

$app = Resolve-AppRoot -Requested $AppRoot
$engineDir = Join-Path $app 'resources\engines'
$ytDlp = Join-Path $engineDir 'yt-dlp.exe'
$ffmpeg = Join-Path $engineDir 'ffmpeg.exe'
$ffprobe = Join-Path $engineDir 'ffprobe.exe'
$node = Join-Path $engineDir 'node.exe'
foreach ($binary in @($ytDlp, $ffmpeg, $ffprobe, $node)) {
  if (-not (Test-Path $binary)) { throw "Packaged media dependency is missing: $binary" }
}

$providerHome = Join-Path $engineDir 'pot-provider\server'
if (Test-Path (Join-Path $providerHome 'build\generate_once.js')) {
  $env:SUBUTAI_POT_SERVER_HOME = $providerHome
}

if ($AttemptsPerRoute -lt 1) { $AttemptsPerRoute = 1 }
if ($AttemptsPerRoute -gt 5) { $AttemptsPerRoute = 5 }
if (-not $OutputRoot) { $OutputRoot = Join-Path ([System.IO.Path]::GetTempPath()) 'SubutaiOwnerYouTubeFreshUrlRetry' }
Remove-Item $OutputRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null

$routes = @(
  @{ Name = 'default'; Client = ''; NeedsCookies = $false },
  @{ Name = 'mweb-pot'; Client = 'mweb'; NeedsCookies = $false },
  @{ Name = 'cookie-default-web-embedded'; Client = 'default,web_embedded'; NeedsCookies = $true },
  @{ Name = 'web-safari'; Client = 'web_safari'; NeedsCookies = $false },
  @{ Name = 'android-vr'; Client = 'android_vr'; NeedsCookies = $false }
)

$records = New-Object System.Collections.Generic.List[object]
$routeNumber = 0
foreach ($browser in (Get-BrowserCandidates -Requested $Browser)) {
  foreach ($route in $routes) {
    if ($route.NeedsCookies -and $browser -eq 'none') { continue }
    if (-not $route.NeedsCookies -and $browser -ne 'none') { continue }
    $routeNumber++
    $routeDir = Join-Path $OutputRoot (("{0:D2}-{1}-{2}" -f $routeNumber, $browser, $route.Name) -replace '[^A-Za-z0-9._-]', '_')
    New-Item -ItemType Directory -Force -Path $routeDir | Out-Null
    $template = Join-Path $routeDir 'subutai-owner-youtube.%(ext)s'

    for ($attempt = 1; $attempt -le $AttemptsPerRoute; $attempt++) {
      $stdout = Join-Path $routeDir ("attempt-{0:D2}.stdout.log" -f $attempt)
      $stderr = Join-Path $routeDir ("attempt-{0:D2}.stderr.log" -f $attempt)
      $args = @(
        '--no-playlist',
        '--newline',
        '--continue',
        '--part',
        '--socket-timeout', '30',
        '--retries', '3',
        '--fragment-retries', '3',
        '--retry-sleep', 'http:linear=1:5:1',
        '--retry-sleep', 'fragment:linear=1:5:1',
        '--js-runtimes', "node:$node",
        '--ffmpeg-location', $engineDir,
        '--format', 'worstvideo*+worstaudio/worst',
        '--merge-output-format', 'mp4',
        '--output', $template
      )
      if ($route.Client) { $args += @('--extractor-args', "youtube:player_client=$($route.Client)") }
      if ($browser -ne 'none') { $args += @('--cookies-from-browser', $browser) }
      $args += $Url

      Write-Host "Trying fresh-URL owner acceptance; route=$($route.Name) browser=$browser attempt=$attempt/$AttemptsPerRoute"
      $exitCode = Invoke-YtDlp -Executable $ytDlp -Arguments $args -StdoutPath $stdout -StderrPath $stderr
      $diagnostic = Read-Diagnostic -Path $stderr
      $media = Get-ChildItem $routeDir -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like 'subutai-owner-youtube.*' -and $_.Extension -notin @('.part','.ytdl','.log','.json') } |
        Sort-Object Length -Descending |
        Select-Object -First 1
      $playable = $false
      if ($media) { $playable = Test-PlayableMedia -Path $media.FullName -Ffprobe $ffprobe }

      $records.Add([pscustomobject]@{
        route = $route.Name
        browser = $browser
        attempt = $attempt
        exitCode = $exitCode
        playableMedia = $playable
        stderr = $stderr
        stdout = $stdout
      })
      $records | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $OutputRoot 'fresh-url-retry-summary.json') -Encoding UTF8

      if ($exitCode -eq 0 -and $media -and $playable) {
        Write-Host "Playable media: $($media.FullName)"
        Write-Host 'SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PASS'
        exit 0
      }

      if (-not (Test-TransientYouTubeFailure -Diagnostic $diagnostic)) { break }
      if ($attempt -lt $AttemptsPerRoute) {
        Start-Sleep -Seconds ([Math]::Min(5, $attempt * 2))
      }
    }
  }
}

Write-Host "Fresh media URL retry routes did not produce playable YouTube media. Evidence: $OutputRoot"
Write-Host 'SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PENDING'
exit 2
