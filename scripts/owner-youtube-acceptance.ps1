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

$app = Resolve-AppRoot -Requested $AppRoot
$engineDir = Join-Path $app "resources\engines"
$ytDlp = Join-Path $engineDir "yt-dlp.exe"
$ffmpeg = Join-Path $engineDir "ffmpeg.exe"
$ffprobe = Join-Path $engineDir "ffprobe.exe"
$node = Join-Path $engineDir "node.exe"

foreach ($binary in @($ytDlp, $ffmpeg, $ffprobe, $node)) {
  if (-not (Test-Path $binary)) { throw "Packaged media dependency is missing: $binary" }
}

if (-not $OutputRoot) {
  $OutputRoot = Join-Path ([System.IO.Path]::GetTempPath()) "SubutaiOwnerYouTubeAcceptance"
}
Remove-Item $OutputRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null

$browserCandidates = if ($Browser -and $Browser -ne "auto") {
  @($Browser)
} else {
  @("none", "chrome", "edge", "firefox")
}

$playerProfiles = @(
  @{ Name = "default"; Arguments = @() },
  @{ Name = "android_vr"; Arguments = @("--extractor-args", "youtube:player_client=android_vr") },
  @{ Name = "web_embedded"; Arguments = @("--extractor-args", "youtube:player_client=web_embedded") },
  @{ Name = "web_safari"; Arguments = @("--extractor-args", "youtube:player_client=web_safari") }
)

$failures = New-Object System.Collections.Generic.List[string]
foreach ($candidate in $browserCandidates) {
  foreach ($profile in $playerProfiles) {
    Get-ChildItem $OutputRoot -Force -ErrorAction SilentlyContinue |
      Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

    $stdout = Join-Path $OutputRoot "youtube.stdout.log"
    $stderr = Join-Path $OutputRoot "youtube.stderr.log"
    $template = Join-Path $OutputRoot "subutai-owner-youtube.%(ext)s"

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
    $exitCode = Invoke-YtDlpAttempt -YtDlp $ytDlp -Arguments $arguments -StdoutPath $stdout -StderrPath $stderr
    if ($exitCode -ne 0) {
      $failures.Add("browser=$candidate profile=$($profile.Name) exit=$exitCode :: $(Read-Tail $stderr)")
      continue
    }

    $media = Get-ChildItem $OutputRoot -File |
      Where-Object {
        $_.Name -like "subutai-owner-youtube.*" -and
        $_.Extension -notin @(".part", ".ytdl", ".log", ".json")
      } |
      Sort-Object Length -Descending |
      Select-Object -First 1

    if (-not $media -or -not (Test-PlayableMedia -Path $media.FullName -Ffprobe $ffprobe)) {
      $failures.Add("browser=$candidate profile=$($profile.Name) produced no valid playable media output")
      continue
    }

    $sha256 = (Get-FileHash -Path $media.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Host "Subutai owner-network YouTube acceptance passed."
    Write-Host "browser=$candidate"
    Write-Host "profile=$($profile.Name)"
    Write-Host "file=$($media.FullName)"
    Write-Host "bytes=$($media.Length)"
    Write-Host "sha256=$sha256"
    Write-Host "SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PASS"
    exit 0
  }
}

throw "Subutai owner-network YouTube acceptance failed for all browser/profile combinations.`n$($failures -join "`n")"
