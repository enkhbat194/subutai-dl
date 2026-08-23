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
  $candidates.Add((Join-Path $PSScriptRoot "..\.."))
  $candidates.Add((Join-Path $PSScriptRoot "..\apps\desktop\release\win-unpacked"))
  if ($env:LOCALAPPDATA) {
    $candidates.Add((Join-Path $env:LOCALAPPDATA "Programs\Subutai Download Manager"))
  }

  foreach ($candidate in $candidates) {
    if (-not $candidate) { continue }
    try {
      $resolved = (Resolve-Path $candidate -ErrorAction Stop).Path
    } catch {
      continue
    }
    if (Test-Path (Join-Path $resolved "resources\engines\yt-dlp.exe")) {
      return $resolved
    }
  }
  throw "Subutai app root was not found. Build win-unpacked, install Subutai, or pass -AppRoot."
}

function Invoke-YtDlpAttempt {
  param(
    [string]$YtDlp,
    [string[]]$Arguments,
    [string]$StdoutPath,
    [string]$StderrPath
  )

  Remove-Item $StdoutPath, $StderrPath -Force -ErrorAction SilentlyContinue
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & $YtDlp @Arguments 1> $StdoutPath 2> $StderrPath
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
  return [double]::TryParse(
    ([string]$duration).Trim(),
    [Globalization.NumberStyles]::Float,
    [Globalization.CultureInfo]::InvariantCulture,
    [ref]$parsed
  ) -and $parsed -gt 0
}

function Read-Tail {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return "No stderr output." }
  $lines = @(Get-Content $Path -ErrorAction SilentlyContinue | Where-Object { $_ -and $_.Trim() })
  if ($lines.Count -eq 0) { return "No stderr output." }
  return ($lines | Select-Object -Last 10) -join " | "
}

function ConvertTo-SafePathComponent {
  param([string]$Value)
  if (-not $Value) { return "none" }
  $safe = $Value -replace '[^A-Za-z0-9._-]+', '_'
  $safe = $safe.Trim('_')
  if (-not $safe) { return "none" }
  if ($safe.Length -gt 80) { return $safe.Substring(0, 80) }
  return $safe
}

function Get-ToolVersionLine {
  param([string]$Executable, [string[]]$Arguments)
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $output = & $Executable @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) { return "unknown" }
    return [string]($output | Select-Object -First 1)
  } finally {
    $ErrorActionPreference = $previous
  }
}

function Write-AcceptanceSummary {
  param(
    [string]$Path,
    [string]$Result,
    [string]$AppRootValue,
    [string]$TargetUrl,
    [string]$YtDlpVersion,
    [bool]$ProviderPresent,
    [System.Collections.Generic.List[object]]$Attempts,
    [hashtable]$Success
  )

  $summary = [ordered]@{
    schemaVersion = 1
    generatedAtUtc = [DateTime]::UtcNow.ToString("o")
    result = $Result
    appRoot = $AppRootValue
    targetUrl = $TargetUrl
    ytDlpVersion = $YtDlpVersion
    packagedPoTokenProviderPresent = $ProviderPresent
    attempts = @($Attempts)
  }
  if ($Success) { $summary.success = $Success }
  $summary | ConvertTo-Json -Depth 8 | Set-Content -Path $Path -Encoding UTF8
}

function Add-UniqueCandidate {
  param(
    [System.Collections.Generic.List[string]]$List,
    [System.Collections.Generic.HashSet[string]]$Seen,
    [string]$Candidate
  )
  if (-not $Candidate) { return }
  if ($Seen.Add($Candidate)) { $List.Add($Candidate) }
}

function Add-FirefoxProfiles {
  param(
    [System.Collections.Generic.List[string]]$List,
    [System.Collections.Generic.HashSet[string]]$Seen,
    [string]$FirefoxRoot
  )

  Add-UniqueCandidate -List $List -Seen $Seen -Candidate "firefox"
  if (-not $FirefoxRoot -or -not (Test-Path $FirefoxRoot)) { return }

  $profilesIni = Join-Path (Split-Path $FirefoxRoot -Parent) "profiles.ini"
  if (Test-Path $profilesIni) {
    Get-Content $profilesIni -ErrorAction SilentlyContinue |
      ForEach-Object {
        if ($_ -match '^Name=(.+)$') {
          $profileName = $Matches[1].Trim()
          if ($profileName) {
            Add-UniqueCandidate -List $List -Seen $Seen -Candidate "firefox:$profileName"
          }
        }
      }
  }

  Get-ChildItem $FirefoxRoot -Directory -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 20 |
    ForEach-Object {
      Add-UniqueCandidate -List $List -Seen $Seen -Candidate ("firefox:" + $_.FullName)
    }

  foreach ($fallbackName in @("default-release", "default")) {
    Add-UniqueCandidate -List $List -Seen $Seen -Candidate "firefox:$fallbackName"
  }
}

function Add-ChromiumProfiles {
  param(
    [System.Collections.Generic.List[string]]$List,
    [System.Collections.Generic.HashSet[string]]$Seen,
    [string]$BrowserName,
    [string]$UserDataRoot
  )

  Add-UniqueCandidate -List $List -Seen $Seen -Candidate $BrowserName
  if (-not $UserDataRoot -or -not (Test-Path $UserDataRoot)) { return }

  $profileNames = New-Object System.Collections.Generic.List[string]
  if (Test-Path (Join-Path $UserDataRoot "Default")) { $profileNames.Add("Default") }
  Get-ChildItem $UserDataRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^Profile [0-9]+$' } |
    Sort-Object {
      if ($_.Name -match '^Profile ([0-9]+)$') { [int]$Matches[1] } else { [int]::MaxValue }
    } |
    ForEach-Object { $profileNames.Add($_.Name) }

  foreach ($profileName in $profileNames | Select-Object -First 20) {
    Add-UniqueCandidate -List $List -Seen $Seen -Candidate "${BrowserName}:$profileName"
  }
}

function Get-InstalledBrowserCandidates {
  $result = New-Object System.Collections.Generic.List[string]
  $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)

  Add-UniqueCandidate -List $result -Seen $seen -Candidate "none"

  if ($env:APPDATA) {
    Add-FirefoxProfiles -List $result -Seen $seen -FirefoxRoot (Join-Path $env:APPDATA "Mozilla\Firefox\Profiles")
  }

  if ($env:LOCALAPPDATA) {
    Add-ChromiumProfiles -List $result -Seen $seen -BrowserName "chrome" -UserDataRoot (Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data")
    Add-ChromiumProfiles -List $result -Seen $seen -BrowserName "edge" -UserDataRoot (Join-Path $env:LOCALAPPDATA "Microsoft\Edge\User Data")
    Add-ChromiumProfiles -List $result -Seen $seen -BrowserName "brave" -UserDataRoot (Join-Path $env:LOCALAPPDATA "BraveSoftware\Brave-Browser\User Data")
    Add-ChromiumProfiles -List $result -Seen $seen -BrowserName "chromium" -UserDataRoot (Join-Path $env:LOCALAPPDATA "Chromium\User Data")
    Add-ChromiumProfiles -List $result -Seen $seen -BrowserName "vivaldi" -UserDataRoot (Join-Path $env:LOCALAPPDATA "Vivaldi\User Data")
  }

  foreach ($candidate in @(
    "firefox",
    "firefox:default-release",
    "firefox:default",
    "chrome",
    "chrome:Default",
    "chrome:Profile 1",
    "chrome:Profile 2",
    "chrome:Profile 3",
    "chrome:Profile 4",
    "chrome:Profile 5",
    "edge",
    "edge:Default",
    "edge:Profile 1",
    "edge:Profile 2",
    "edge:Profile 3",
    "edge:Profile 4",
    "edge:Profile 5",
    "brave",
    "brave:Default",
    "brave:Profile 1",
    "chromium",
    "vivaldi"
  )) {
    Add-UniqueCandidate -List $result -Seen $seen -Candidate $candidate
  }

  return @($result)
}

$app = Resolve-AppRoot -Requested $AppRoot
$engineDir = Join-Path $app "resources\engines"
$ytDlp = Join-Path $engineDir "yt-dlp.exe"
$ffmpeg = Join-Path $engineDir "ffmpeg.exe"
$ffprobe = Join-Path $engineDir "ffprobe.exe"
$node = Join-Path $engineDir "node.exe"

foreach ($binary in @($ytDlp, $ffmpeg, $ffprobe, $node)) {
  if (-not (Test-Path $binary)) { throw "Packaged media dependency is missing: $binary" }
}

$providerHome = Join-Path $engineDir "pot-provider\server"
$providerScript = Join-Path $providerHome "build\generate_once.js"
$providerPresent = Test-Path $providerScript
if ($providerPresent) {
  $env:SUBUTAI_POT_SERVER_HOME = $providerHome
  Write-Host "Using packaged YouTube PO-token provider runtime."
}

if (-not $OutputRoot) {
  $OutputRoot = Join-Path ([System.IO.Path]::GetTempPath()) "SubutaiOwnerYouTubeAcceptance"
}
Remove-Item $OutputRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null
$attemptsRoot = Join-Path $OutputRoot "attempts"
New-Item -ItemType Directory -Force -Path $attemptsRoot | Out-Null
$summaryPath = Join-Path $OutputRoot "acceptance-summary.json"
$ytDlpVersion = Get-ToolVersionLine -Executable $ytDlp -Arguments @("--version")

$browserCandidates = if ($Browser -and $Browser -ne "auto") {
  @($Browser)
} else {
  @(Get-InstalledBrowserCandidates)
}

$playerProfiles = @(
  @{ Name = "default"; Arguments = @() },
  @{ Name = "mweb-pot"; Arguments = @("--extractor-args", "youtube:player_client=mweb") },
  @{ Name = "android_vr"; Arguments = @("--extractor-args", "youtube:player_client=android_vr") },
  @{ Name = "web_embedded"; Arguments = @("--extractor-args", "youtube:player_client=web_embedded") },
  @{ Name = "web_safari"; Arguments = @("--extractor-args", "youtube:player_client=web_safari") }
)

$failures = New-Object System.Collections.Generic.List[string]
$attemptRecords = New-Object System.Collections.Generic.List[object]
$attemptNumber = 0
foreach ($candidate in $browserCandidates) {
  foreach ($profile in $playerProfiles) {
    $attemptNumber++
    $candidateLabel = ConvertTo-SafePathComponent -Value $candidate
    $profileLabel = ConvertTo-SafePathComponent -Value $profile.Name
    $attemptDir = Join-Path $attemptsRoot (("{0:D3}-{1}-{2}" -f $attemptNumber, $candidateLabel, $profileLabel))
    New-Item -ItemType Directory -Force -Path $attemptDir | Out-Null

    $stdout = Join-Path $attemptDir "youtube.stdout.log"
    $stderr = Join-Path $attemptDir "youtube.stderr.log"
    $template = Join-Path $attemptDir "subutai-owner-youtube.%(ext)s"

    $arguments = @(
      "--no-playlist",
      "--newline",
      "--continue",
      "--part",
      "--js-runtimes", "node:$node",
      "--ffmpeg-location", $engineDir,
      "--format", "worstvideo*+worstaudio/worst",
      "--merge-output-format", "mp4",
      "--output", $template
    )
    $arguments += @($profile.Arguments)
    if ($candidate -ne "none") {
      $arguments += @("--cookies-from-browser", $candidate)
    }
    $arguments += $Url

    Write-Host "Trying owner-network YouTube acceptance; browser=$candidate profile=$($profile.Name)"
    $startedAt = [DateTime]::UtcNow
    $exitCode = Invoke-YtDlpAttempt -YtDlp $ytDlp -Arguments $arguments -StdoutPath $stdout -StderrPath $stderr
    $finishedAt = [DateTime]::UtcNow
    $diagnostic = if ($exitCode -ne 0) { Read-Tail $stderr } else { "" }

    $media = Get-ChildItem $attemptDir -File |
      Where-Object {
        $_.Name -like "subutai-owner-youtube.*" -and
        $_.Extension -notin @(".part", ".ytdl", ".log", ".json")
      } |
      Sort-Object Length -Descending |
      Select-Object -First 1
    $playable = $false
    if ($media) { $playable = Test-PlayableMedia -Path $media.FullName -Ffprobe $ffprobe }

    $attemptRecord = [ordered]@{
      attempt = $attemptNumber
      browser = $candidate
      profile = $profile.Name
      startedAtUtc = $startedAt.ToString("o")
      finishedAtUtc = $finishedAt.ToString("o")
      exitCode = $exitCode
      playableMedia = $playable
      stdout = (Resolve-Path $stdout -ErrorAction SilentlyContinue).Path
      stderr = (Resolve-Path $stderr -ErrorAction SilentlyContinue).Path
      diagnosticTail = $diagnostic
    }
    $attemptRecords.Add([pscustomobject]$attemptRecord)

    if ($exitCode -ne 0) {
      $failures.Add("browser=$candidate profile=$($profile.Name) exit=$exitCode :: $diagnostic")
      Write-AcceptanceSummary -Path $summaryPath -Result "RUNNING" -AppRootValue $app -TargetUrl $Url -YtDlpVersion $ytDlpVersion -ProviderPresent $providerPresent -Attempts $attemptRecords -Success $null
      continue
    }

    if (-not $media -or -not $playable) {
      $failures.Add("browser=$candidate profile=$($profile.Name) produced no valid playable media output")
      Write-AcceptanceSummary -Path $summaryPath -Result "RUNNING" -AppRootValue $app -TargetUrl $Url -YtDlpVersion $ytDlpVersion -ProviderPresent $providerPresent -Attempts $attemptRecords -Success $null
      continue
    }

    $sha256 = (Get-FileHash -Path $media.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $success = @{
      browser = $candidate
      profile = $profile.Name
      file = $media.FullName
      bytes = $media.Length
      sha256 = $sha256
    }
    Write-AcceptanceSummary -Path $summaryPath -Result "PASS" -AppRootValue $app -TargetUrl $Url -YtDlpVersion $ytDlpVersion -ProviderPresent $providerPresent -Attempts $attemptRecords -Success $success
    Write-Host "Subutai owner-network YouTube acceptance passed."
    Write-Host "browser=$candidate"
    Write-Host "profile=$($profile.Name)"
    Write-Host "file=$($media.FullName)"
    Write-Host "bytes=$($media.Length)"
    Write-Host "sha256=$sha256"
    Write-Host "summary=$summaryPath"
    Write-Host "SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PASS"
    exit 0
  }
}

Write-AcceptanceSummary -Path $summaryPath -Result "FAIL" -AppRootValue $app -TargetUrl $Url -YtDlpVersion $ytDlpVersion -ProviderPresent $providerPresent -Attempts $attemptRecords -Success $null
throw "Subutai owner-network YouTube acceptance failed for all browser/profile combinations. Preserved diagnostics: $summaryPath`n$($failures -join "`n")"
