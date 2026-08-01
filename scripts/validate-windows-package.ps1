param(
  [string]$ReleaseDir = "apps/desktop/release",
  [switch]$LaunchSmoke
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $ReleaseDir)) {
  throw "Release directory does not exist: $ReleaseDir"
}

$package = Get-Content "apps/desktop/package.json" -Raw | ConvertFrom-Json
$version = [string]$package.version
$releasePath = (Resolve-Path $ReleaseDir).Path

$setupFiles = @(Get-ChildItem $releasePath -File -Filter "Subutai-Setup-$version-*.exe")
$portableFiles = @(Get-ChildItem $releasePath -File -Filter "Subutai-Portable-$version-*.exe")
$latestFile = Join-Path $releasePath "latest.yml"
$blockmaps = @(Get-ChildItem $releasePath -File -Filter "*.blockmap")

if ($setupFiles.Count -ne 1) {
  throw "Expected exactly one Subutai Setup executable for version $version; found $($setupFiles.Count)."
}
if ($portableFiles.Count -ne 1) {
  throw "Expected exactly one Subutai Portable executable for version $version; found $($portableFiles.Count)."
}
if (-not (Test-Path $latestFile)) {
  throw "Updater manifest latest.yml was not generated."
}
if ($blockmaps.Count -lt 1) {
  throw "Expected at least one updater blockmap."
}
if ($setupFiles[0].Length -lt 5MB) {
  throw "Setup executable is unexpectedly small: $($setupFiles[0].Length) bytes."
}
if ($portableFiles[0].Length -lt 5MB) {
  throw "Portable executable is unexpectedly small: $($portableFiles[0].Length) bytes."
}

$latestText = Get-Content $latestFile -Raw
if ($latestText -notmatch "(?m)^version:\s*$([regex]::Escape($version))\s*$") {
  throw "latest.yml version does not match package version $version."
}
if ($latestText -notmatch "(?m)^path:\s*$([regex]::Escape($setupFiles[0].Name))\s*$") {
  throw "latest.yml does not point to $($setupFiles[0].Name)."
}
if ($latestText -notmatch "(?m)^sha512:\s*\S+") {
  throw "latest.yml does not contain a sha512 digest."
}

$unpackedDir = Join-Path $releasePath "win-unpacked"
$appExecutable = Join-Path $unpackedDir "Subutai Download Manager.exe"
$engineDir = Join-Path $unpackedDir "resources\engines"

if (-not (Test-Path $appExecutable)) {
  throw "Unpacked Subutai executable was not found: $appExecutable"
}

foreach ($engine in @("aria2c.exe", "yt-dlp.exe", "ffmpeg.exe")) {
  $enginePath = Join-Path $engineDir $engine
  if (-not (Test-Path $enginePath)) {
    throw "Packaged engine is missing: $enginePath"
  }
}

$checksumTargets = @($setupFiles[0], $portableFiles[0], (Get-Item $latestFile)) + $blockmaps
$checksumLines = foreach ($target in $checksumTargets) {
  $hash = Get-FileHash $target.FullName -Algorithm SHA256
  "$($hash.Hash.ToLowerInvariant())  $($target.Name)"
}
$checksumPath = Join-Path $releasePath "SHA256SUMS.txt"
Set-Content -Path $checksumPath -Value $checksumLines -Encoding ascii

if ($LaunchSmoke) {
  $stdoutPath = Join-Path $releasePath "launch-smoke.stdout.log"
  $stderrPath = Join-Path $releasePath "launch-smoke.stderr.log"
  $diagnosticPath = Join-Path $releasePath "launch-smoke.runtime.log"
  Remove-Item $stdoutPath, $stderrPath, $diagnosticPath -Force -ErrorAction SilentlyContinue

  $env:ELECTRON_ENABLE_LOGGING = "1"
  $env:SUBUTAI_SMOKE_LOG = $diagnosticPath
  $process = Start-Process `
    -FilePath $appExecutable `
    -ArgumentList "--subutai-smoke-test" `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru

  if (-not $process.WaitForExit(25000)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    if (Test-Path $diagnosticPath) { Get-Content $diagnosticPath | Write-Host }
    if (Test-Path $stderrPath) { Get-Content $stderrPath | Write-Host }
    throw "Packaged Subutai app did not finish its launch smoke test within 25 seconds."
  }

  $process.Refresh()
  if (Test-Path $diagnosticPath) {
    Write-Host "Subutai runtime smoke log:"
    Get-Content $diagnosticPath | Write-Host
  }
  if (Test-Path $stdoutPath) {
    $stdout = Get-Content $stdoutPath -Raw
    if ($stdout) { Write-Host "Subutai smoke stdout:`n$stdout" }
  }
  if (Test-Path $stderrPath) {
    $stderr = Get-Content $stderrPath -Raw
    if ($stderr) { Write-Host "Subutai smoke stderr:`n$stderr" }
  }
  if ($process.ExitCode -ne 0) {
    throw "Packaged Subutai app launch smoke failed with exit code $($process.ExitCode)."
  }
  if (-not (Test-Path $diagnosticPath)) {
    throw "Packaged Subutai app did not produce its runtime smoke log."
  }
  $diagnostic = Get-Content $diagnosticPath -Raw
  if ($diagnostic -notmatch "Launch smoke completed successfully") {
    throw "Packaged Subutai app exited without completing its runtime smoke sequence."
  }
}

Write-Host "Subutai Windows package validation passed."
Write-Host "Setup: $($setupFiles[0].Name)"
Write-Host "Portable: $($portableFiles[0].Name)"
Write-Host "Manifest: latest.yml"
Write-Host "Checksums: SHA256SUMS.txt"
