param(
  [string]$EngineDir = "apps/desktop/resources/engines/win32-x64",
  [string[]]$TestUrls = @(
    "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    "https://www.youtube.com/watch?v=ScMzIvxBSi4",
    "https://www.youtube.com/watch?v=aqz-KE-bpKQ"
  )
)

$ErrorActionPreference = "Stop"

# Isolated feasibility audit only. This script intentionally does not modify the packaged
# engine directory or release inputs. GPL-3.0 third-party assets are downloaded into a
# temporary directory, checksum verified, exercised, then removed.
$providerVersion = "v0.8.1"
$providerBinaryUrl = "https://github.com/jim60105/bgutil-ytdlp-pot-provider-rs/releases/download/$providerVersion/bgutil-pot-windows-x86_64.exe"
$providerBinarySha256 = "25d6b05c79176aa792454c3d1727922ca47e56cf11cb1e866615d751819b14a0"
$providerPluginUrl = "https://github.com/jim60105/bgutil-ytdlp-pot-provider-rs/releases/download/$providerVersion/bgutil-ytdlp-pot-provider-rs.zip"
$providerPluginSha256 = "99fd83b98fa93b193d6a3b69dc74410d76e7a2b889868c54d16121cac9060344"

$resolvedEngineDir = (Resolve-Path $EngineDir).Path
$ytDlp = Join-Path $resolvedEngineDir "yt-dlp.exe"
$ffmpeg = Join-Path $resolvedEngineDir "ffmpeg.exe"
$ffprobe = Join-Path $resolvedEngineDir "ffprobe.exe"
$node = Join-Path $resolvedEngineDir "node.exe"
foreach ($path in @($ytDlp, $ffmpeg, $ffprobe, $node)) {
  if (-not (Test-Path $path)) { throw "BgUtil audit dependency is missing: $path" }
}

$tempBase = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$tempRoot = Join-Path $tempBase "SubutaiBgUtilRsAudit"
$providerBinary = Join-Path $tempRoot "bgutil-pot.exe"
$providerPluginArchive = Join-Path $tempRoot "bgutil-ytdlp-pot-provider-rs.zip"
$providerPluginRoot = Join-Path $tempRoot "plugins"
$outputRoot = Join-Path $tempRoot "output"

function Get-VerifiedDownload {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][string]$ExpectedSha256
  )

  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($curl) {
    & $curl.Source -L --fail --silent --show-error --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 240 --output $Destination $Url
    if ($LASTEXITCODE -ne 0) { throw "curl failed downloading $Url with exit code $LASTEXITCODE." }
  } else {
    Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing -TimeoutSec 240
  }

  $actual = (Get-FileHash -Path $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $ExpectedSha256.ToLowerInvariant()) {
    throw "Checksum mismatch for $Url. Expected $ExpectedSha256; received $actual."
  }
}

function Invoke-YtDlpCaptured {
  param(
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$StdoutPath,
    [Parameter(Mandatory = $true)][string]$StderrPath
  )

  Remove-Item $StdoutPath, $StderrPath -Force -ErrorAction SilentlyContinue
  $previousErrorAction = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & $ytDlp @Arguments 1> $StdoutPath 2> $StderrPath
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorAction
  }
}

function Read-BoundedText {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path $Path)) { return "" }
  $lines = @(Get-Content $Path -ErrorAction SilentlyContinue | Where-Object { $_ -and $_.Trim() })
  if ($lines.Count -eq 0) { return "" }
  return ($lines | Select-Object -Last 16) -join " | "
}

function Test-PlayableMedia {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path $Path)) { return $false }
  if ((Get-Item $Path).Length -lt 32KB) { return $false }

  $previousErrorAction = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $duration = & $ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 $Path 2>$null
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorAction
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

try {
  Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $tempRoot, $providerPluginRoot, $outputRoot | Out-Null

  Get-VerifiedDownload -Url $providerBinaryUrl -Destination $providerBinary -ExpectedSha256 $providerBinarySha256
  Get-VerifiedDownload -Url $providerPluginUrl -Destination $providerPluginArchive -ExpectedSha256 $providerPluginSha256
  Expand-Archive -Path $providerPluginArchive -DestinationPath $providerPluginRoot -Force

  $providerVersionOutput = & $providerBinary --version 2>&1
  if ($LASTEXITCODE -ne 0 -or -not $providerVersionOutput) {
    throw "Rust BgUtil provider did not execute successfully."
  }
  Write-Host "Rust BgUtil provider: $($providerVersionOutput | Select-Object -First 1)"

  $pluginProbeOut = Join-Path $tempRoot "plugin-probe.stdout.log"
  $pluginProbeErr = Join-Path $tempRoot "plugin-probe.stderr.log"
  $pluginProbeArgs = @(
    "--ignore-config",
    "--verbose",
    "--skip-download",
    "--no-playlist",
    "--plugin-dirs", $providerPluginRoot,
    "--js-runtimes", "node:$node",
    "--ffmpeg-location", $resolvedEngineDir,
    "--extractor-args", "youtube:player_client=mweb",
    "--extractor-args", "youtubepot-bgutilcli:cli_path=$providerBinary",
    $TestUrls[0]
  )
  $pluginProbeExit = Invoke-YtDlpCaptured -Arguments $pluginProbeArgs -StdoutPath $pluginProbeOut -StderrPath $pluginProbeErr
  $pluginProbeCombined = ((Get-Content $pluginProbeOut -Raw -ErrorAction SilentlyContinue) + "`n" + (Get-Content $pluginProbeErr -Raw -ErrorAction SilentlyContinue))
  if ($pluginProbeCombined -notmatch 'PO Token Providers:.*bgutil:cli') {
    throw "yt-dlp did not load the isolated Rust BgUtil provider. stderr: $(Read-BoundedText $pluginProbeErr)"
  }
  Write-Host "yt-dlp loaded the isolated bgutil:cli provider. Probe exit=$pluginProbeExit"

  $diagnostics = New-Object System.Collections.Generic.List[string]
  foreach ($testUrl in $TestUrls) {
    Get-ChildItem $outputRoot -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    $stdoutPath = Join-Path $tempRoot "download.stdout.log"
    $stderrPath = Join-Path $tempRoot "download.stderr.log"
    $outputTemplate = Join-Path $outputRoot "subutai-bgutil-audit.%(ext)s"
    $arguments = @(
      "--ignore-config",
      "--no-playlist",
      "--plugin-dirs", $providerPluginRoot,
      "--js-runtimes", "node:$node",
      "--ffmpeg-location", $resolvedEngineDir,
      "--extractor-args", "youtube:player_client=mweb",
      "--extractor-args", "youtubepot-bgutilcli:cli_path=$providerBinary",
      "--format", "worstvideo*+worstaudio/worst",
      "--merge-output-format", "mp4",
      "--output", $outputTemplate,
      $testUrl
    )

    Write-Host "Trying isolated Rust BgUtil YouTube candidate: $testUrl"
    $exitCode = Invoke-YtDlpCaptured -Arguments $arguments -StdoutPath $stdoutPath -StderrPath $stderrPath
    if ($exitCode -ne 0) {
      $diagnostics.Add("$testUrl => exit ${exitCode}: $(Read-BoundedText $stderrPath)")
      continue
    }

    $downloaded = Get-ChildItem $outputRoot -File |
      Where-Object { $_.Extension -notin @(".part", ".ytdl", ".log", ".json") } |
      Sort-Object Length -Descending |
      Select-Object -First 1
    if (-not $downloaded -or -not (Test-PlayableMedia -Path $downloaded.FullName)) {
      $diagnostics.Add("$testUrl => no playable media output")
      continue
    }

    Write-Host "Isolated Rust BgUtil produced playable media: $($downloaded.Name), $($downloaded.Length) bytes."
    Write-Host "SUBUTAI_BGUTIL_RS_AUDIT=PLAYABLE_PASS"
    exit 0
  }

  throw "Isolated Rust BgUtil audit did not produce playable YouTube media.`n$($diagnostics -join "`n")"
} finally {
  Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
