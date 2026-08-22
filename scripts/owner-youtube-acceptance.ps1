param(
  [Parameter(Mandatory = $true)][string]$Url,
  [string]$EngineDir = "apps/desktop/resources/engines/win32-x64",
  [string]$OutputDir = "",
  [string[]]$Browsers = @("edge", "chrome", "firefox")
)

$ErrorActionPreference = "Stop"
$resolvedEngineDir = (Resolve-Path $EngineDir).Path
$ytDlp = Join-Path $resolvedEngineDir "yt-dlp.exe"
$ffprobe = Join-Path $resolvedEngineDir "ffprobe.exe"
$node = Join-Path $resolvedEngineDir "node.exe"

foreach ($path in @($ytDlp, $ffprobe, $node)) {
  if (-not (Test-Path $path)) { throw "Packaged media dependency is missing: $path" }
}

if (-not $OutputDir) {
  $OutputDir = Join-Path ([System.IO.Path]::GetTempPath()) "SubutaiOwnerYouTubeAcceptance"
}
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$OutputDir = (Resolve-Path $OutputDir).Path

function Test-PlayableMedia {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path $Path) -or (Get-Item $Path).Length -lt 32KB) { return $false }
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $duration = & $ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 $Path 2>$null
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  if ($exitCode -ne 0) { return $false }
  $parsed = 0.0
  return [double]::TryParse(([string]$duration).Trim(), [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$parsed) -and $parsed -gt 0
}

function Invoke-Attempt {
  param([string]$Browser)
  Get-ChildItem $OutputDir -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "subutai-owner-youtube-*" } |
    Remove-Item -Force -ErrorAction SilentlyContinue

  $suffix = if ($Browser) { $Browser } else { "anonymous" }
  $template = Join-Path $OutputDir "subutai-owner-youtube-$suffix.%(ext)s"
  $stderr = Join-Path $OutputDir "subutai-owner-youtube-$suffix.stderr.log"
  $args = @(
    "--no-playlist",
    "--socket-timeout", "20",
    "--retries", "2",
    "--fragment-retries", "2",
    "--js-runtimes", "node:$node",
    "--ffmpeg-location", $resolvedEngineDir,
    "--format", "worstvideo*+worstaudio/worst",
    "--merge-output-format", "mp4",
    "--output", $template
  )
  if ($Browser) { $args += @("--cookies-from-browser", $Browser) }
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
    $tail = (($detail -split "`r?`n") | Where-Object { $_ -and $_.Trim() } | Select-Object -Last 6) -join " | "
    Write-Host "OWNER_YOUTUBE_ATTEMPT_FAIL browser=$suffix exit=$exitCode detail=$tail"
    return $false
  }

  $media = Get-ChildItem $OutputDir -File |
    Where-Object { $_.Name -like "subutai-owner-youtube-$suffix.*" -and $_.Extension -notin @(".part", ".ytdl", ".log", ".json") } |
    Sort-Object Length -Descending |
    Select-Object -First 1
  if (-not $media -or -not (Test-PlayableMedia -Path $media.FullName)) {
    Write-Host "OWNER_YOUTUBE_ATTEMPT_FAIL browser=$suffix detail=invalid-media"
    return $false
  }

  $hash = (Get-FileHash -Path $media.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  Write-Host "SUBUTAI_OWNER_YOUTUBE_ACCEPTANCE=PASS browser=$suffix file=$($media.Name) bytes=$($media.Length) sha256=$hash"
  return $true
}

Write-Host "Testing packaged Subutai media stack on the current Windows network. Browser cookies never leave this machine except in requests made directly to the target media service by yt-dlp."
if (Invoke-Attempt -Browser "") { exit 0 }
foreach ($browser in $Browsers) {
  Write-Host "Retrying with local $browser browser authentication state."
  if (Invoke-Attempt -Browser $browser) { exit 0 }
}

Write-Host "SUBUTAI_OWNER_YOUTUBE_ACCEPTANCE=FAIL"
exit 2
