param(
  [string]$EngineDir = "apps/desktop/resources/engines/win32-x64",
  [string[]]$TestUrls = @(
    "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    "https://www.youtube.com/watch?v=ScMzIvxBSi4",
    "https://www.youtube.com/watch?v=aqz-KE-bpKQ"
  )
)

$ErrorActionPreference = "Stop"
$resolvedEngineDir = (Resolve-Path $EngineDir).Path
$ytDlp = Join-Path $resolvedEngineDir "yt-dlp.exe"
$ffprobe = Join-Path $resolvedEngineDir "ffprobe.exe"
$node = Join-Path $resolvedEngineDir "node.exe"

foreach ($path in @($ytDlp, $ffprobe, $node)) {
  if (-not (Test-Path $path)) { throw "YouTube profile smoke dependency is missing: $path" }
}

$profiles = @(
  @{ Name = "default"; ExtractorArgs = $null },
  @{ Name = "android_vr"; ExtractorArgs = "youtube:player_client=android_vr" },
  @{ Name = "web_embedded"; ExtractorArgs = "youtube:player_client=web_embedded" },
  @{ Name = "web_safari"; ExtractorArgs = "youtube:player_client=web_safari" }
)

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "SubutaiYouTubeProfileSmoke"
Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

function Invoke-Profile {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][hashtable]$Profile
  )

  Get-ChildItem $tempRoot -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  $template = Join-Path $tempRoot "youtube-profile.%(ext)s"
  $stderr = Join-Path $tempRoot "stderr.log"
  $args = @(
    "--no-playlist",
    "--socket-timeout", "15",
    "--extractor-retries", "1",
    "--retries", "1",
    "--fragment-retries", "1",
    "--js-runtimes", "node:$node",
    "--ffmpeg-location", $resolvedEngineDir,
    "--format", "worstvideo*+worstaudio/worst",
    "--merge-output-format", "mp4",
    "--output", $template
  )
  if ($Profile.ExtractorArgs) {
    $args += @("--extractor-args", [string]$Profile.ExtractorArgs)
  }
  $args += $Url

  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & $ytDlp @args 1>$null 2>$stderr
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }

  if ($exitCode -ne 0) {
    $detail = if (Test-Path $stderr) { (Get-Content $stderr -Raw -ErrorAction SilentlyContinue).Trim() } else { "" }
    $tail = (($detail -split "`r?`n") | Where-Object { $_ -and $_.Trim() } | Select-Object -Last 4) -join " | "
    Write-Host "PROFILE_FAIL name=$($Profile.Name) url=$Url exit=$exitCode detail=$tail"
    return $false
  }

  $downloaded = Get-ChildItem $tempRoot -File |
    Where-Object { $_.Name -like "youtube-profile.*" -and $_.Extension -notin @(".part", ".ytdl", ".log", ".json") } |
    Sort-Object Length -Descending |
    Select-Object -First 1
  if (-not $downloaded -or $downloaded.Length -lt 32KB) {
    Write-Host "PROFILE_FAIL name=$($Profile.Name) url=$Url detail=no-valid-file"
    return $false
  }

  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $duration = & $ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 $downloaded.FullName 2>$null
    $probeExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  $parsed = 0.0
  $valid = $probeExit -eq 0 -and [double]::TryParse(([string]$duration).Trim(), [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$parsed) -and $parsed -gt 0
  if (-not $valid) {
    Write-Host "PROFILE_FAIL name=$($Profile.Name) url=$Url detail=ffprobe-invalid"
    return $false
  }

  Write-Host "SUBUTAI_YOUTUBE_PROFILE_PASS=$($Profile.Name) url=$Url bytes=$($downloaded.Length) duration=$parsed"
  return $true
}

try {
  foreach ($url in $TestUrls) {
    foreach ($profile in $profiles) {
      Write-Host "Trying YouTube client profile $($profile.Name): $url"
      if (Invoke-Profile -Url $url -Profile $profile) { exit 0 }
    }
  }
  Write-Host "SUBUTAI_YOUTUBE_PROFILE_PASS=NONE"
  exit 2
} finally {
  Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
