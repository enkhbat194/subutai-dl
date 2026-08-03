param(
  [string]$EngineDir = "apps/desktop/resources/engines/win32-x64",
  [string]$TestUrl = "https://www.youtube.com/watch?v=BaW_jenozKc"
)

$ErrorActionPreference = "Stop"

$resolvedEngineDir = (Resolve-Path $EngineDir).Path
$ytDlp = Join-Path $resolvedEngineDir "yt-dlp.exe"
$ffmpeg = Join-Path $resolvedEngineDir "ffmpeg.exe"
$node = Join-Path $resolvedEngineDir "node.exe"

foreach ($path in @($ytDlp, $ffmpeg, $node)) {
  if (-not (Test-Path $path)) { throw "YouTube smoke dependency is missing: $path" }
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "SubutaiYouTubeSmoke"
Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

try {
  $runtime = "node:$node"
  $probePath = Join-Path $tempRoot "probe.json"
  $probeErrorPath = Join-Path $tempRoot "probe.stderr.log"

  & $ytDlp `
    --dump-single-json `
    --skip-download `
    --no-warnings `
    --no-playlist `
    --js-runtimes $runtime `
    --ffmpeg-location $resolvedEngineDir `
    $TestUrl `
    1> $probePath `
    2> $probeErrorPath

  if ($LASTEXITCODE -ne 0) {
    $detail = if (Test-Path $probeErrorPath) { Get-Content $probeErrorPath -Raw } else { "No stderr output." }
    throw "YouTube probe smoke failed with exit code $LASTEXITCODE.`n$detail"
  }

  $probe = Get-Content $probePath -Raw | ConvertFrom-Json
  if (-not $probe.id -or -not $probe.title) {
    throw "YouTube probe returned no id or title."
  }
  Write-Host "YouTube probe passed: $($probe.title) [$($probe.id)]"

  $outputTemplate = Join-Path $tempRoot "subutai-youtube-smoke.%(ext)s"
  $downloadErrorPath = Join-Path $tempRoot "download.stderr.log"
  & $ytDlp `
    --no-playlist `
    --js-runtimes $runtime `
    --ffmpeg-location $resolvedEngineDir `
    --format "worstvideo*+worstaudio/worst" `
    --merge-output-format mp4 `
    --output $outputTemplate `
    $TestUrl `
    2> $downloadErrorPath

  if ($LASTEXITCODE -ne 0) {
    $detail = if (Test-Path $downloadErrorPath) { Get-Content $downloadErrorPath -Raw } else { "No stderr output." }
    throw "YouTube download smoke failed with exit code $LASTEXITCODE.`n$detail"
  }

  $downloaded = Get-ChildItem $tempRoot -File |
    Where-Object { $_.Name -like "subutai-youtube-smoke.*" -and $_.Extension -notin @(".part", ".ytdl") } |
    Sort-Object Length -Descending |
    Select-Object -First 1

  if (-not $downloaded) { throw "YouTube smoke completed without producing a media file." }
  if ($downloaded.Length -lt 32KB) { throw "YouTube smoke output is unexpectedly small: $($downloaded.Length) bytes." }

  Write-Host "Subutai YouTube download smoke passed: $($downloaded.Name), $($downloaded.Length) bytes."
} finally {
  Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
