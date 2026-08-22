param(
  [string]$EngineDir = "apps/desktop/resources/engines/win32-x64"
)

$ErrorActionPreference = "Stop"

$ytDlpVersion = "2026.08.19"
$ytDlpUrl = "https://github.com/yt-dlp/yt-dlp/releases/download/$ytDlpVersion/yt-dlp.exe"
$ytDlpSha256 = "66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a"

$ffmpegBuild = "ffmpeg-N-123778-g3b55818764-win64-gpl"
$ffmpegUrl = "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/autobuild-2026-03-31-15-13/$ffmpegBuild.zip"
$ffmpegSha256 = "43f9f3491b86264a3b4104935283955002fd8a1413377c7d04a4c484576d6c11"

$nodeVersion = "22.23.2"
$nodeArchiveName = "node-v$nodeVersion-win-x64.zip"
$nodeUrl = "https://nodejs.org/dist/v$nodeVersion/$nodeArchiveName"
$nodeSha256 = "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97"

$tempBase = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$tempRoot = Join-Path $tempBase "SubutaiTemporaryMediaTools"
$cacheRoot = Join-Path $env:USERPROFILE ".cache\subutai-media-tools"
$ytDlpDownload = Join-Path $cacheRoot "yt-dlp-$ytDlpVersion.exe"
$ffmpegArchive = Join-Path $cacheRoot "$ffmpegBuild.zip"
$nodeArchive = Join-Path $cacheRoot $nodeArchiveName
$ffmpegExtract = Join-Path $tempRoot "ffmpeg"
$nodeExtract = Join-Path $tempRoot "node"

function Test-ExpectedHash {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$ExpectedSha256
  )

  if (-not (Test-Path $Path)) { return $false }
  $actual = (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  return $actual -eq $ExpectedSha256.ToLowerInvariant()
}

function Get-VerifiedDownload {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][string]$ExpectedSha256
  )

  if (Test-ExpectedHash -Path $Destination -ExpectedSha256 $ExpectedSha256) {
    Write-Host "Using checksum-verified cached media asset: $Destination"
    return
  }

  Remove-Item $Destination -Force -ErrorAction SilentlyContinue
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($curl) {
    Write-Host "Downloading media dependency with curl: $Url"
    & $curl.Source -L --fail --silent --show-error --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 240 --output $Destination $Url
    if ($LASTEXITCODE -ne 0) {
      throw "curl failed downloading $Url with exit code $LASTEXITCODE."
    }
  } else {
    Write-Host "curl.exe unavailable; using Invoke-WebRequest for $Url"
    Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing -TimeoutSec 240
  }

  if (-not (Test-ExpectedHash -Path $Destination -ExpectedSha256 $ExpectedSha256)) {
    $actual = if (Test-Path $Destination) {
      (Get-FileHash -Path $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
    } else {
      "missing"
    }
    throw "Downloaded media tool checksum mismatch for $Url. Expected $ExpectedSha256; received $actual."
  }
}

function Get-PathExecutable {
  param([Parameter(Mandatory = $true)][string]$Name)
  $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $command) { return $null }
  if ($command.Source -and (Test-Path $command.Source)) { return $command.Source }
  if ($command.Path -and (Test-Path $command.Path)) { return $command.Path }
  return $null
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
  New-Item -ItemType Directory -Force -Path $tempRoot, $cacheRoot, $EngineDir | Out-Null
  Get-ChildItem $EngineDir -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force

  # yt-dlp must be the standalone executable so the packaged app does not depend on Python.
  Get-VerifiedDownload -Url $ytDlpUrl -Destination $ytDlpDownload -ExpectedSha256 $ytDlpSha256
  Copy-Item $ytDlpDownload (Join-Path $EngineDir "yt-dlp.exe") -Force

  # setup-node already provisions Node on GitHub-hosted Windows. Reuse that executable
  # for the owner-test package to avoid a second large network download; retain the
  # pinned archive fallback for environments without Node on PATH.
  $nodeFromPath = Get-PathExecutable -Name "node.exe"
  if ($nodeFromPath) {
    Write-Host "Using Node.js from the prepared runner: $nodeFromPath"
    Copy-Item $nodeFromPath (Join-Path $EngineDir "node.exe") -Force
  } else {
    Get-VerifiedDownload -Url $nodeUrl -Destination $nodeArchive -ExpectedSha256 $nodeSha256
    Expand-Archive -Path $nodeArchive -DestinationPath $nodeExtract -Force
    $node = Get-ChildItem $nodeExtract -Recurse -File -Filter "node.exe" | Select-Object -First 1
    if (-not $node) { throw "Pinned Node archive did not contain node.exe." }
    Copy-Item $node.FullName (Join-Path $EngineDir "node.exe") -Force
  }

  # Prefer the FFmpeg pair already present on the hosted runner. If either binary is
  # unavailable, fall back to the checksum-pinned archive used by release acceptance.
  $ffmpegFromPath = Get-PathExecutable -Name "ffmpeg.exe"
  $ffprobeFromPath = Get-PathExecutable -Name "ffprobe.exe"
  if ($ffmpegFromPath -and $ffprobeFromPath) {
    Write-Host "Using FFmpeg from the prepared runner: $ffmpegFromPath"
    Copy-Item $ffmpegFromPath (Join-Path $EngineDir "ffmpeg.exe") -Force
    Copy-Item $ffprobeFromPath (Join-Path $EngineDir "ffprobe.exe") -Force
  } else {
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
    Copy-Item $ffmpeg.FullName (Join-Path $EngineDir "ffmpeg.exe") -Force
    Copy-Item $ffprobe.FullName (Join-Path $EngineDir "ffprobe.exe") -Force
  }

  foreach ($binary in @("yt-dlp.exe", "ffmpeg.exe", "ffprobe.exe", "node.exe")) {
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
  Test-ToolVersion -Executable (Join-Path $EngineDir "node.exe") -Arguments @("--version") -Label "Node.js"

  Write-Host "Subutai media tools and JavaScript runtime staged and verified."
} finally {
  Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
