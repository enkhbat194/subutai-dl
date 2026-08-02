param(
  [string]$EngineDir = "apps/desktop/resources/engines/win32-x64"
)

$ErrorActionPreference = "Stop"

$ytDlpVersion = "2026.06.09"
$ytDlpUrl = "https://github.com/yt-dlp/yt-dlp/releases/download/$ytDlpVersion/yt-dlp.exe"
$ytDlpSha256 = "3a48cb955d55c8821b60ccbdbbc6f61bc958f2f3d3b7ad5eaf3d83a543293a27"

$ffmpegBuild = "ffmpeg-N-123778-g3b55818764-win64-gpl"
$ffmpegUrl = "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/autobuild-2026-03-31-15-13/$ffmpegBuild.zip"
$ffmpegSha256 = "43f9f3491b86264a3b4104935283955002fd8a1413377c7d04a4c484576d6c11"

$tempBase = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$tempRoot = Join-Path $tempBase "SubutaiTemporaryMediaTools"
$ytDlpDownload = Join-Path $tempRoot "yt-dlp.exe"
$ffmpegArchive = Join-Path $tempRoot "$ffmpegBuild.zip"
$ffmpegExtract = Join-Path $tempRoot "ffmpeg"

function Get-VerifiedDownload {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][string]$ExpectedSha256
  )

  Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing
  $actual = (Get-FileHash -Path $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
  $expected = $ExpectedSha256.ToLowerInvariant()
  if ($actual -ne $expected) {
    throw "Downloaded media tool checksum mismatch for $Url. Expected $expected; received $actual."
  }
}

function Test-ToolVersion {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $output = & $Executable @Arguments 2>&1
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw "$Label version check failed with exit code $exitCode."
  }
  $firstLine = $output | Select-Object -First 1
  if (-not $firstLine) { throw "$Label version check returned no output." }
  Write-Host $firstLine
}

try {
  Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $tempRoot, $EngineDir | Out-Null
  Get-ChildItem $EngineDir -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force

  Get-VerifiedDownload -Url $ytDlpUrl -Destination $ytDlpDownload -ExpectedSha256 $ytDlpSha256
  Get-VerifiedDownload -Url $ffmpegUrl -Destination $ffmpegArchive -ExpectedSha256 $ffmpegSha256

  Expand-Archive -Path $ffmpegArchive -DestinationPath $ffmpegExtract -Force
  $ffmpeg = Get-ChildItem $ffmpegExtract -Recurse -File -Filter "ffmpeg.exe" |
    Where-Object { $_.DirectoryName -match "[\\/]bin$" } |
    Select-Object -First 1
  $ffprobe = Get-ChildItem $ffmpegExtract -Recurse -File -Filter "ffprobe.exe" |
    Where-Object { $_.DirectoryName -match "[\\/]bin$" } |
    Select-Object -First 1

  if (-not $ffmpeg) { throw "Pinned FFmpeg archive did not contain bin\ffmpeg.exe." }
  if (-not $ffprobe) { throw "Pinned FFmpeg archive did not contain bin\ffprobe.exe." }

  Copy-Item $ytDlpDownload (Join-Path $EngineDir "yt-dlp.exe") -Force
  Copy-Item $ffmpeg.FullName (Join-Path $EngineDir "ffmpeg.exe") -Force
  Copy-Item $ffprobe.FullName (Join-Path $EngineDir "ffprobe.exe") -Force

  foreach ($binary in @("yt-dlp.exe", "ffmpeg.exe", "ffprobe.exe")) {
    $path = Join-Path $EngineDir $binary
    if (-not (Test-Path $path)) { throw "Temporary media tool is missing: $path" }
    if ((Get-Item $path).Length -lt 64KB) { throw "Temporary media tool is unexpectedly small: $path" }
  }

  if (Test-Path (Join-Path $EngineDir "aria2c.exe")) {
    throw "Legacy direct-download engine must not enter Subutai resources."
  }

  Test-ToolVersion -Executable (Join-Path $EngineDir "yt-dlp.exe") -Arguments @("--version") -Label "yt-dlp"
  Test-ToolVersion -Executable (Join-Path $EngineDir "ffmpeg.exe") -Arguments @("-version") -Label "FFmpeg"
  Test-ToolVersion -Executable (Join-Path $EngineDir "ffprobe.exe") -Arguments @("-version") -Label "FFprobe"

  Write-Host "Pinned temporary media tools installed and checksum verified."
} finally {
  Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
