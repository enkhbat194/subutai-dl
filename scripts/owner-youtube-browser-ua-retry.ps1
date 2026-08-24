param(
  [string]$AppRoot = "",
  [string]$Url = "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  [string]$Browser = "auto",
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

function Add-UniqueCandidate {
  param([System.Collections.Generic.List[string]]$List, [string]$Candidate)
  if ($Candidate -and -not $List.Contains($Candidate)) { $List.Add($Candidate) }
}

function Add-ChromiumProfiles {
  param([System.Collections.Generic.List[string]]$List, [string]$BrowserName, [string]$UserDataRoot)
  if (-not (Test-Path $UserDataRoot)) { return }
  Get-ChildItem $UserDataRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq 'Default' -or $_.Name -match '^Profile [0-9]+$' } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 3 |
    ForEach-Object { Add-UniqueCandidate -List $List -Candidate ("{0}:{1}" -f $BrowserName, $_.Name) }
  Add-UniqueCandidate -List $List -Candidate $BrowserName
}

function Add-FirefoxProfiles {
  param([System.Collections.Generic.List[string]]$List, [string]$ProfilesRoot)
  if (-not (Test-Path $ProfilesRoot)) { return }
  Get-ChildItem $ProfilesRoot -Directory -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 3 |
    ForEach-Object { Add-UniqueCandidate -List $List -Candidate ("firefox:{0}" -f $_.Name) }
  Add-UniqueCandidate -List $List -Candidate 'firefox'
}

function Get-BrowserCandidates {
  param([string]$Requested)
  if ($Requested -and $Requested -ne 'auto') { return @($Requested) }
  $result = New-Object System.Collections.Generic.List[string]
  if ($env:APPDATA) {
    Add-FirefoxProfiles -List $result -ProfilesRoot (Join-Path $env:APPDATA 'Mozilla\Firefox\Profiles')
  }
  if ($env:LOCALAPPDATA) {
    Add-ChromiumProfiles -List $result -BrowserName 'chrome' -UserDataRoot (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data')
    Add-ChromiumProfiles -List $result -BrowserName 'edge' -UserDataRoot (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data')
    Add-ChromiumProfiles -List $result -BrowserName 'brave' -UserDataRoot (Join-Path $env:LOCALAPPDATA 'BraveSoftware\Brave-Browser\User Data')
  }
  foreach ($fallback in @('firefox','chrome','edge','brave')) { Add-UniqueCandidate -List $result -Candidate $fallback }
  return @($result)
}

function Get-BrowserBaseName {
  param([string]$Candidate)
  if (-not $Candidate) { return '' }
  return ($Candidate -split ':', 2)[0].ToLowerInvariant()
}

function Get-BrowserExecutable {
  param([string]$BrowserName)
  $paths = switch ($BrowserName) {
    'chrome' { @(
      (Join-Path ${env:ProgramFiles} 'Google\Chrome\Application\chrome.exe'),
      (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
      (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
    ) }
    'edge' { @(
      (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
      (Join-Path ${env:ProgramFiles} 'Microsoft\Edge\Application\msedge.exe')
    ) }
    'brave' { @(
      (Join-Path ${env:ProgramFiles} 'BraveSoftware\Brave-Browser\Application\brave.exe'),
      (Join-Path ${env:ProgramFiles(x86)} 'BraveSoftware\Brave-Browser\Application\brave.exe'),
      (Join-Path $env:LOCALAPPDATA 'BraveSoftware\Brave-Browser\Application\brave.exe')
    ) }
    'firefox' { @(
      (Join-Path ${env:ProgramFiles} 'Mozilla Firefox\firefox.exe'),
      (Join-Path ${env:ProgramFiles(x86)} 'Mozilla Firefox\firefox.exe')
    ) }
    default { @() }
  }
  foreach ($path in $paths) {
    if ($path -and (Test-Path $path)) { return $path }
  }
  return $null
}

function Get-BrowserUserAgent {
  param([string]$Candidate)
  $name = Get-BrowserBaseName -Candidate $Candidate
  $exe = Get-BrowserExecutable -BrowserName $name
  if (-not $exe) { return $null }
  try {
    $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($exe).ProductVersion
  } catch {
    return $null
  }
  if (-not $version -or $version -notmatch '^(\d+)') { return $null }
  $major = [int]$Matches[1]
  if ($name -eq 'firefox') {
    return "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:$major.0) Gecko/20100101 Firefox/$major.0"
  }
  $chromeUa = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/$major.0.0.0 Safari/537.36"
  if ($name -eq 'edge') { return "$chromeUa Edg/$version" }
  return $chromeUa
}

$app = Resolve-AppRoot -Requested $AppRoot
$engineDir = Join-Path $app 'resources\engines'
$ytDlp = Join-Path $engineDir 'yt-dlp.exe'
$ffprobe = Join-Path $engineDir 'ffprobe.exe'
$node = Join-Path $engineDir 'node.exe'
foreach ($binary in @($ytDlp, $ffprobe, $node)) {
  if (-not (Test-Path $binary)) { throw "Packaged media dependency is missing: $binary" }
}

$providerHome = Join-Path $engineDir 'pot-provider\server'
if (Test-Path (Join-Path $providerHome 'build\generate_once.js')) {
  $env:SUBUTAI_POT_SERVER_HOME = $providerHome
}

if (-not $OutputRoot) { $OutputRoot = Join-Path ([System.IO.Path]::GetTempPath()) 'SubutaiOwnerYouTubeBrowserUaRetry' }
Remove-Item $OutputRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null

$routes = @(
  @{ Name = 'default-web-embedded'; Client = 'default,web_embedded'; Format = 'worstvideo*+worstaudio/worst' },
  @{ Name = 'mweb-pot-cookie'; Client = 'mweb'; Format = 'worstvideo*+worstaudio/worst' },
  @{ Name = 'web-creator'; Client = 'web_creator'; Format = 'worstvideo*+worstaudio/worst' },
  @{ Name = 'tv-cookie'; Client = 'tv'; Format = 'worstvideo*+worstaudio/worst' },
  @{ Name = 'tv-embedded'; Client = 'tv_embedded'; Format = 'worstvideo*+worstaudio/worst' },
  @{ Name = 'web-safari-hls'; Client = 'web_safari'; Format = 'best[protocol^=m3u8]' }
)

$records = New-Object System.Collections.Generic.List[object]
$routeNumber = 0
foreach ($candidate in (Get-BrowserCandidates -Requested $Browser)) {
  $userAgent = Get-BrowserUserAgent -Candidate $candidate
  if (-not $userAgent) { continue }
  foreach ($route in $routes) {
    $routeNumber++
    $safeCandidate = $candidate -replace '[^A-Za-z0-9._-]', '_'
    $routeDir = Join-Path $OutputRoot ("{0:D2}-{1}-{2}" -f $routeNumber, $safeCandidate, $route.Name)
    New-Item -ItemType Directory -Force -Path $routeDir | Out-Null
    $stdout = Join-Path $routeDir 'youtube.stdout.log'
    $stderr = Join-Path $routeDir 'youtube.stderr.log'
    $template = Join-Path $routeDir 'subutai-owner-youtube.%(ext)s'
    $args = @(
      '--no-playlist',
      '--newline',
      '--continue',
      '--part',
      '--socket-timeout', '30',
      '--retries', '3',
      '--fragment-retries', '3',
      '--js-runtimes', "node:$node",
      '--ffmpeg-location', $engineDir,
      '--cookies-from-browser', $candidate,
      '--user-agent', $userAgent,
      '--extractor-args', "youtube:player_client=$($route.Client)",
      '--format', $route.Format,
      '--merge-output-format', 'mp4',
      '--output', $template,
      $Url
    )

    Write-Host "Trying browser-matched owner acceptance; browser=$candidate route=$($route.Name)"
    $exitCode = Invoke-YtDlp -Executable $ytDlp -Arguments $args -StdoutPath $stdout -StderrPath $stderr
    $media = Get-ChildItem $routeDir -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -like 'subutai-owner-youtube.*' -and $_.Extension -notin @('.part','.ytdl','.log','.json') } |
      Sort-Object Length -Descending |
      Select-Object -First 1
    $playable = $false
    if ($media) { $playable = Test-PlayableMedia -Path $media.FullName -Ffprobe $ffprobe }
    $records.Add([pscustomobject]@{
      browser = $candidate
      route = $route.Name
      exitCode = $exitCode
      playableMedia = $playable
      userAgent = $userAgent
      stdout = $stdout
      stderr = $stderr
    })
    $records | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $OutputRoot 'browser-ua-retry-summary.json') -Encoding UTF8

    if ($exitCode -eq 0 -and $media -and $playable) {
      Write-Host "Playable media: $($media.FullName)"
      Write-Host 'SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PASS'
      exit 0
    }
  }
}

Write-Host "Browser-matched User-Agent retry routes did not produce playable YouTube media. Evidence: $OutputRoot"
Write-Host 'SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PENDING'
exit 2