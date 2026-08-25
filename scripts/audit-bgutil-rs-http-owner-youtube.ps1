param(
  [string]$EngineDir = "apps/desktop/resources/engines/win32-x64",
  [string[]]$TestUrls = @(
    "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    "https://www.youtube.com/watch?v=ScMzIvxBSi4",
    "https://www.youtube.com/watch?v=aqz-KE-bpKQ"
  )
)

$ErrorActionPreference = "Stop"
$providerVersion = "v0.8.1"
$providerBinaryUrl = "https://github.com/jim60105/bgutil-ytdlp-pot-provider-rs/releases/download/$providerVersion/bgutil-pot-windows-x86_64.exe"
$providerBinarySha256 = "25d6b05c79176aa792454c3d1727922ca47e56cf11cb1e866615d751819b14a0"
$providerPluginUrl = "https://github.com/jim60105/bgutil-ytdlp-pot-provider-rs/releases/download/$providerVersion/bgutil-ytdlp-pot-provider-rs.zip"
$providerPluginSha256 = "99fd83b98fa93b193d6a3b69dc74410d76e7a2b889868c54d16121cac9060344"

$engine = (Resolve-Path $EngineDir).Path
$ytDlp = Join-Path $engine "yt-dlp.exe"
$ffprobe = Join-Path $engine "ffprobe.exe"
$node = Join-Path $engine "node.exe"
foreach ($path in @($ytDlp, $ffprobe, $node)) {
  if (-not (Test-Path $path)) { throw "BgUtil HTTP audit dependency is missing: $path" }
}

$tempBase = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$temp = Join-Path $tempBase "SubutaiBgUtilHttpAudit"
$provider = Join-Path $temp "bgutil-pot.exe"
$pluginZip = Join-Path $temp "plugin.zip"
$pluginContainer = Join-Path $temp "yt-dlp-plugins"
$pluginPackage = Join-Path $pluginContainer "bgutil-ytdlp-pot-provider"
$output = Join-Path $temp "output"
$serverOut = Join-Path $temp "server.stdout.log"
$serverErr = Join-Path $temp "server.stderr.log"
$server = $null

function Get-VerifiedDownload([string]$Url, [string]$Destination, [string]$Sha256) {
  $curl = (Get-Command curl.exe -ErrorAction Stop).Source
  & $curl -L --fail --silent --show-error --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 240 --output $Destination $Url
  if ($LASTEXITCODE -ne 0) { throw "Download failed for $Url with exit $LASTEXITCODE" }
  $actual = (Get-FileHash $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $Sha256.ToLowerInvariant()) { throw "Checksum mismatch for ${Url}: $actual" }
}

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
  Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $temp, $pluginPackage, $output | Out-Null
  Get-VerifiedDownload $providerBinaryUrl $provider $providerBinarySha256
  Get-VerifiedDownload $providerPluginUrl $pluginZip $providerPluginSha256
  Expand-Archive $pluginZip -DestinationPath $pluginPackage -Force

  $version = & $provider --version 2>&1
  if ($LASTEXITCODE -ne 0) { throw "BgUtil provider binary failed version check" }
  Write-Host "BgUtil provider: $($version | Select-Object -First 1)"

  $server = Start-Process -FilePath $provider -ArgumentList @("server", "--host", "127.0.0.1", "--port", "4416") -PassThru -NoNewWindow -RedirectStandardOutput $serverOut -RedirectStandardError $serverErr
  $healthy = $false
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    if ($server.HasExited) { break }
    try {
      $ping = Invoke-RestMethod -Uri "http://127.0.0.1:4416/ping" -TimeoutSec 2
      $healthy = $true
      break
    } catch { }
  }
  if (-not $healthy) {
    $err = if (Test-Path $serverErr) { Get-Content $serverErr -Raw } else { "" }
    throw "BgUtil HTTP provider failed health check. $err"
  }
  Write-Host "BgUtil HTTP provider health check passed."

  $common = @(
    "--ignore-config",
    "--plugin-dirs", $pluginContainer,
    "--js-runtimes", "node:$node",
    "--ffmpeg-location", $engine,
    "--extractor-args", "youtube:player_client=mweb",
    "--extractor-args", "youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416",
    "--no-playlist"
  )

  $probeOut = Join-Path $temp "probe.stdout.log"
  $probeErr = Join-Path $temp "probe.stderr.log"
  $probeCode = Invoke-YtDlp ($common + @("--verbose", "--skip-download", $TestUrls[0])) $probeOut $probeErr
  $probeText = ((Get-Content $probeOut -Raw -ErrorAction SilentlyContinue) + "`n" + (Get-Content $probeErr -Raw -ErrorAction SilentlyContinue))
  Write-Host $probeText
  if ($probeText -notmatch 'PO Token Providers:.*bgutil:http') {
    throw "yt-dlp did not discover bgutil:http from isolated plugin container."
  }
  Write-Host "yt-dlp discovered bgutil:http provider; probe exit=$probeCode"

  $diagnostics = New-Object System.Collections.Generic.List[string]
  foreach ($url in $TestUrls) {
    Get-ChildItem $output -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    $stdout = Join-Path $temp "download.stdout.log"
    $stderr = Join-Path $temp "download.stderr.log"
    $template = Join-Path $output "subutai-bgutil-http.%(ext)s"
    Write-Host "Trying BgUtil HTTP YouTube candidate: $url"
    $code = Invoke-YtDlp ($common + @("--format", "worstvideo*+worstaudio/worst", "--merge-output-format", "mp4", "--output", $template, $url)) $stdout $stderr
    if ($code -ne 0) {
      $tail = if (Test-Path $stderr) { (Get-Content $stderr | Select-Object -Last 14) -join " | " } else { "" }
      $diagnostics.Add("$url => exit ${code}: $tail")
      continue
    }
    $media = Get-ChildItem $output -File | Where-Object { $_.Extension -notin @('.part','.ytdl','.json','.log') } | Sort-Object Length -Descending | Select-Object -First 1
    if ($media -and (Test-Playable $media.FullName)) {
      Write-Host "SUBUTAI_BGUTIL_RS_HTTP_AUDIT=PLAYABLE_PASS"
      Write-Host "Playable media: $($media.Name), $($media.Length) bytes"
      exit 0
    }
    $diagnostics.Add("$url => no playable media output")
  }
  throw "BgUtil HTTP audit produced no playable YouTube result.`n$($diagnostics -join "`n")"
} finally {
  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
}
