param(
  [string]$EngineDir = "apps/desktop/resources/engines/win32-x64",
  [string[]]$TestUrls = @(
    "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    "https://www.youtube.com/watch?v=ScMzIvxBSi4",
    "https://www.youtube.com/watch?v=aqz-KE-bpKQ"
  )
)

$ErrorActionPreference = "Stop"
$engine = (Resolve-Path $EngineDir).Path
$ytDlp = Join-Path $engine "yt-dlp.exe"
$ffprobe = Join-Path $engine "ffprobe.exe"
$node = Join-Path $engine "node.exe"
foreach ($path in @($ytDlp, $ffprobe, $node)) {
  if (-not (Test-Path $path)) { throw "Impersonation audit dependency is missing: $path" }
}

$temp = Join-Path ([System.IO.Path]::GetTempPath()) "SubutaiImpersonationAudit"
Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $temp | Out-Null

function Invoke-YtDlp([string[]]$Arguments, [string]$Stdout, [string]$Stderr) {
  Remove-Item $Stdout, $Stderr -Force -ErrorAction SilentlyContinue
  $old = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & $ytDlp @Arguments 1> $Stdout 2> $Stderr
    return $LASTEXITCODE
  } finally { $ErrorActionPreference = $old }
}

function Test-Playable([string]$Path) {
  if (-not (Test-Path $Path) -or (Get-Item $Path).Length -lt 32KB) { return $false }
  $old = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $duration = & $ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 $Path 2>$null
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $old }
  if ($code -ne 0) { return $false }
  $parsed = 0.0
  return [double]::TryParse(([string]$duration).Trim(), [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$parsed) -and $parsed -gt 0
}

try {
  $targetsOut = Join-Path $temp "targets.stdout.log"
  $targetsErr = Join-Path $temp "targets.stderr.log"
  $targetCode = Invoke-YtDlp @("--ignore-config", "--list-impersonate-targets") $targetsOut $targetsErr
  $targetText = ((Get-Content $targetsOut -Raw -ErrorAction SilentlyContinue) + "`n" + (Get-Content $targetsErr -Raw -ErrorAction SilentlyContinue))
  Write-Host $targetText
  if ($targetCode -ne 0) { throw "Packaged yt-dlp could not enumerate impersonation targets." }

  $chromeAvailable = $false
  foreach ($line in ($targetText -split "`r?`n")) {
    if ($line -match '^\s*Chrome\s+' -and $line -notmatch 'unavailable|not available') {
      $chromeAvailable = $true
      break
    }
  }

  if (-not $chromeAvailable) {
    Write-Host "SUBUTAI_YOUTUBE_IMPERSONATION_AUDIT=UNAVAILABLE"
    exit 0
  }

  Write-Host "Packaged yt-dlp exposes an available Chrome impersonation target."
  $diagnostics = New-Object System.Collections.Generic.List[string]
  $hostedChallengeCount = 0
  foreach ($url in $TestUrls) {
    $attempt = Join-Path $temp ([Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $attempt | Out-Null
    $stdout = Join-Path $attempt "stdout.log"
    $stderr = Join-Path $attempt "stderr.log"
    $template = Join-Path $attempt "subutai-impersonation.%(ext)s"
    Write-Host "Trying isolated Chrome impersonation candidate: $url"
    $args = @(
      "--ignore-config",
      "--impersonate", "chrome",
      "--js-runtimes", "node:$node",
      "--ffmpeg-location", $engine,
      "--no-playlist",
      "--format", "worstvideo*+worstaudio/worst",
      "--merge-output-format", "mp4",
      "--output", $template,
      $url
    )
    $code = Invoke-YtDlp $args $stdout $stderr
    $stderrText = [string](Get-Content $stderr -Raw -ErrorAction SilentlyContinue)
    if ($stderrText -match 'Sign in to confirm|not a bot|LOGIN_REQUIRED|authentication[^\r\n]*cookies|YouTube cookies') {
      $hostedChallengeCount++
    }
    if ($code -eq 0) {
      $media = Get-ChildItem $attempt -File | Where-Object { $_.Extension -notin @('.part','.ytdl','.json','.log') } | Sort-Object Length -Descending | Select-Object -First 1
      if ($media -and (Test-Playable $media.FullName)) {
        Write-Host "SUBUTAI_YOUTUBE_IMPERSONATION_AUDIT=PLAYABLE_PASS"
        Write-Host "Playable media: $($media.Name), $($media.Length) bytes"
        exit 0
      }
    }
    $tail = if (Test-Path $stderr) { (Get-Content $stderr | Select-Object -Last 12) -join " | " } else { "" }
    $diagnostics.Add("$url => exit ${code}: $tail")
  }

  if ($hostedChallengeCount -eq $TestUrls.Count) {
    Write-Host "SUBUTAI_YOUTUBE_IMPERSONATION_AUDIT=HOSTED_IP_CHALLENGE"
    $diagnostics | ForEach-Object { Write-Host $_ }
    exit 0
  }

  Write-Host "SUBUTAI_YOUTUBE_IMPERSONATION_AUDIT=NO_PLAYABLE_RESULT"
  $diagnostics | ForEach-Object { Write-Host $_ }
  exit 0
} finally {
  Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
}
