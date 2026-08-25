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

function Get-ChromiumPreferredProfiles {
  param([string]$UserDataRoot)
  $result = New-Object System.Collections.Generic.List[string]
  $localState = Join-Path $UserDataRoot 'Local State'
  if (-not (Test-Path $localState)) { return @($result) }
  try {
    $state = Get-Content $localState -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    $lastUsed = [string]$state.profile.last_used
    if ($lastUsed) { Add-UniqueCandidate -List $result -Candidate $lastUsed }
    foreach ($profile in @($state.profile.last_active_profiles)) {
      if ($profile) { Add-UniqueCandidate -List $result -Candidate ([string]$profile) }
    }
  } catch {
    Write-Host "Could not read Chromium profile preference from $localState; falling back to filesystem discovery."
  }
  return @($result)
}

function Add-ChromiumProfileCandidate {
  param(
    [System.Collections.Generic.List[string]]$List,
    [string]$BrowserName,
    [string]$UserDataRoot,
    [string]$ProfileName
  )
  if (-not $ProfileName) { return }
  $profilePath = Join-Path $UserDataRoot $ProfileName
  if (-not (Test-Path $profilePath)) { return }
  Add-UniqueCandidate -List $List -Candidate ("{0}:{1}" -f $BrowserName, $profilePath)
  Add-UniqueCandidate -List $List -Candidate ("{0}:{1}" -f $BrowserName, $ProfileName)
}

function Add-ChromiumProfiles {
  param([System.Collections.Generic.List[string]]$List, [string]$BrowserName, [string]$UserDataRoot)
  if (-not $UserDataRoot -or -not (Test-Path $UserDataRoot)) { return }

  # Prefer the profile Chrome/Edge/Brave recorded as last used/active. This avoids
  # spending the bounded owner retry on a recently touched but unauthenticated profile.
  foreach ($profileName in (Get-ChromiumPreferredProfiles -UserDataRoot $UserDataRoot)) {
    Add-ChromiumProfileCandidate -List $List -BrowserName $BrowserName -UserDataRoot $UserDataRoot -ProfileName $profileName
  }

  Get-ChildItem $UserDataRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq 'Default' -or $_.Name -match '^Profile [0-9]+$' } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 3 |
    ForEach-Object {
      Add-UniqueCandidate -List $List -Candidate ("{0}:{1}" -f $BrowserName, $_.FullName)
      Add-UniqueCandidate -List $List -Candidate ("{0}:{1}" -f $BrowserName, $_.Name)
    }
  Add-UniqueCandidate -List $List -Candidate $BrowserName
}

function Add-OperaProfile {
  param([System.Collections.Generic.List[string]]$List, [string]$ProfileRoot)
  if (-not $ProfileRoot -or -not (Test-Path $ProfileRoot)) { return }
  Add-UniqueCandidate -List $List -Candidate ("opera:{0}" -f $ProfileRoot)
  Add-UniqueCandidate -List $List -Candidate 'opera'
}

function Get-BrowserCandidates {
  $result = New-Object System.Collections.Generic.List[string]
  if ($env:LOCALAPPDATA) {
    Add-ChromiumProfiles -List $result -BrowserName 'chrome' -UserDataRoot (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data')
    Add-ChromiumProfiles -List $result -BrowserName 'chrome' -UserDataRoot (Join-Path $env:LOCALAPPDATA 'Google\Chrome Beta\User Data')
    Add-ChromiumProfiles -List $result -BrowserName 'chrome' -UserDataRoot (Join-Path $env:LOCALAPPDATA 'Google\Chrome Dev\User Data')
    Add-ChromiumProfiles -List $result -BrowserName 'chrome' -UserDataRoot (Join-Path $env:LOCALAPPDATA 'Google\Chrome SxS\User Data')

    Add-ChromiumProfiles -List $result -BrowserName 'edge' -UserDataRoot (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data')
    Add-ChromiumProfiles -List $result -BrowserName 'edge' -UserDataRoot (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge Beta\User Data')
    Add-ChromiumProfiles -List $result -BrowserName 'edge' -UserDataRoot (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge Dev\User Data')
    Add-ChromiumProfiles -List $result -BrowserName 'edge' -UserDataRoot (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge SxS\User Data')

    Add-ChromiumProfiles -List $result -BrowserName 'brave' -UserDataRoot (Join-Path $env:LOCALAPPDATA 'BraveSoftware\Brave-Browser\User Data')
    Add-ChromiumProfiles -List $result -BrowserName 'brave' -UserDataRoot (Join-Path $env:LOCALAPPDATA 'BraveSoftware\Brave-Browser-Beta\User Data')
    Add-ChromiumProfiles -List $result -BrowserName 'brave' -UserDataRoot (Join-Path $env:LOCALAPPDATA 'BraveSoftware\Brave-Browser-Nightly\User Data')

    Add-ChromiumProfiles -List $result -BrowserName 'vivaldi' -UserDataRoot (Join-Path $env:LOCALAPPDATA 'Vivaldi\User Data')
    Add-ChromiumProfiles -List $result -BrowserName 'chromium' -UserDataRoot (Join-Path $env:LOCALAPPDATA 'Chromium\User Data')
  }
  if ($env:APPDATA) {
    Add-OperaProfile -List $result -ProfileRoot (Join-Path $env:APPDATA 'Opera Software\Opera Stable')
    Add-OperaProfile -List $result -ProfileRoot (Join-Path $env:APPDATA 'Opera Software\Opera GX Stable')
  }
  foreach ($fallback in @('chrome','chromium','edge','brave','vivaldi','opera')) { Add-UniqueCandidate -List $result -Candidate $fallback }
  return @($result)
}

$app = Resolve-AppRoot -Requested $AppRoot
$engineDir = Join-Path $app 'resources\engines'
$ytDlp = Join-Path $engineDir 'yt-dlp.exe'
$ffprobe = Join-Path $engineDir 'ffprobe.exe'
$node = Join-Path $engineDir 'node.exe'
foreach ($binary in @($ytDlp, $ffprobe, $node)) {
  if (-not (Test-Path $binary)) { throw "Packaged media dependency is missing: $binary" }
}

if (-not $OutputRoot) { $OutputRoot = Join-Path ([System.IO.Path]::GetTempPath()) 'SubutaiOwnerYouTubeImpersonationRetry' }
Remove-Item $OutputRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null

$targetsOut = Join-Path $OutputRoot 'targets.stdout.log'
$targetsErr = Join-Path $OutputRoot 'targets.stderr.log'
$targetCode = Invoke-YtDlp -Executable $ytDlp -Arguments @('--ignore-config','--list-impersonate-targets') -StdoutPath $targetsOut -StderrPath $targetsErr
if ($targetCode -ne 0) {
  Write-Host 'Packaged yt-dlp could not enumerate impersonation targets.'
  exit 1
}
$targetText = ([string](Get-Content $targetsOut -Raw -ErrorAction SilentlyContinue)) + "`n" + ([string](Get-Content $targetsErr -Raw -ErrorAction SilentlyContinue))
$chromeTargets = New-Object System.Collections.Generic.List[object]
foreach ($line in ($targetText -split "`r?`n")) {
  if ($line -match '^\s*(Chrome-[^\s]+)\s+([^\s]+)\s+([^\s]+)\s*$' -and $line -notmatch 'unavailable|not available') {
    $chromeTargets.Add([pscustomobject]@{ Client = $Matches[1]; OS = $Matches[2]; Source = $Matches[3] })
  }
}
if ($chromeTargets.Count -eq 0) {
  Write-Host 'No packaged Chrome impersonation target is available.'
  exit 1
}
$selected = $chromeTargets |
  Sort-Object @{ Expression = { if ($_.OS -match '^Windows-') { 0 } else { 1 } } }, @{ Expression = {
    $version = 0
    if ($_.Client -match '^Chrome-(\d+)') { $version = [int]$Matches[1] }
    -$version
  } } |
  Select-Object -First 1
$impersonateTarget = "$($selected.Client):$($selected.OS)".ToLowerInvariant()
Write-Host "Trying packaged browser impersonation target: $impersonateTarget"

$attempts = New-Object System.Collections.Generic.List[object]
$attempts.Add([pscustomobject]@{ Name = 'impersonation-only'; Browser = ''; Client = 'default,web_embedded' })
foreach ($browser in (Get-BrowserCandidates)) {
  $attempts.Add([pscustomobject]@{ Name = ('cookie-' + ($browser -replace '[^A-Za-z0-9._-]','_')); Browser = $browser; Client = 'default,web_embedded' })
  $attempts.Add([pscustomobject]@{ Name = ('mweb-' + ($browser -replace '[^A-Za-z0-9._-]','_')); Browser = $browser; Client = 'mweb' })
}

$index = 0
foreach ($attempt in $attempts) {
  $index++
  $attemptDir = Join-Path $OutputRoot ("{0:D2}-{1}" -f $index, $attempt.Name)
  New-Item -ItemType Directory -Force -Path $attemptDir | Out-Null
  $stdout = Join-Path $attemptDir 'youtube.stdout.log'
  $stderr = Join-Path $attemptDir 'youtube.stderr.log'
  $template = Join-Path $attemptDir 'subutai-owner-youtube.%(ext)s'
  $args = @(
    '--ignore-config',
    '--impersonate', $impersonateTarget,
    '--no-playlist',
    '--newline',
    '--continue',
    '--part',
    '--socket-timeout', '30',
    '--retries', '3',
    '--fragment-retries', '3',
    '--js-runtimes', "node:$node",
    '--ffmpeg-location', $engineDir,
    '--extractor-args', "youtube:player_client=$($attempt.Client)",
    '--format', 'worstvideo*+worstaudio/worst',
    '--merge-output-format', 'mp4',
    '--output', $template
  )
  if ($attempt.Browser) { $args += @('--cookies-from-browser', $attempt.Browser) }
  $args += $Url

  Write-Host "Impersonation owner retry: $($attempt.Name)"
  $exitCode = Invoke-YtDlp -Executable $ytDlp -Arguments $args -StdoutPath $stdout -StderrPath $stderr
  $media = Get-ChildItem $attemptDir -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'subutai-owner-youtube.*' -and $_.Extension -notin @('.part','.ytdl','.log','.json') } |
    Sort-Object Length -Descending |
    Select-Object -First 1
  if ($exitCode -eq 0 -and $media -and (Test-PlayableMedia -Path $media.FullName -Ffprobe $ffprobe)) {
    Write-Host "SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PASS"
    Write-Host "SUBUTAI_YOUTUBE_OWNER_ROUTE=impersonation:${impersonateTarget}:$($attempt.Name)"
    Write-Host "Playable media: $($media.Name), $($media.Length) bytes"
    exit 0
  }
}

Write-Host 'Packaged browser impersonation routes did not produce playable YouTube media.'
exit 1
