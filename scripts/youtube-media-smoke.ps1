param(
  [string]$EngineDir = "apps/desktop/resources/engines/win32-x64",
  [string[]]$TestUrls = @(
    "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    "https://www.youtube.com/watch?v=ScMzIvxBSi4",
    "https://www.youtube.com/watch?v=aqz-KE-bpKQ"
  ),
  [string]$FallbackMediaUrl = "https://samplelib.com/mp4/sample-5s-360p.mp4"
)

$ErrorActionPreference = "Stop"

$resolvedEngineDir = (Resolve-Path $EngineDir).Path
$ytDlp = Join-Path $resolvedEngineDir "yt-dlp.exe"
$ffmpeg = Join-Path $resolvedEngineDir "ffmpeg.exe"
$ffprobe = Join-Path $resolvedEngineDir "ffprobe.exe"
$node = Join-Path $resolvedEngineDir "node.exe"

foreach ($path in @($ytDlp, $ffmpeg, $ffprobe, $node)) {
  if (-not (Test-Path $path)) { throw "Media smoke dependency is missing: $path" }
}

if (-not $TestUrls -or $TestUrls.Count -eq 0) {
  throw "YouTube smoke requires at least one public test URL."
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "SubutaiMediaSmoke"
Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

function Invoke-YtDlp {
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

function Read-DiagnosticText {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path $Path)) { return "" }
  return [string](Get-Content $Path -Raw -ErrorAction SilentlyContinue)
}

function Read-BoundedDiagnostic {
  param([Parameter(Mandatory = $true)][string]$Path)
  $text = Read-DiagnosticText -Path $Path
  if (-not $text) { return "No stderr output." }
  $lines = @($text -split "`r?`n" | Where-Object { $_ -and $_.Trim() })
  if ($lines.Count -eq 0) { return "No stderr output." }
  return ($lines | Select-Object -Last 8) -join " | "
}

function Test-HostedYouTubeChallenge {
  param([string]$Diagnostic)
  if (-not $Diagnostic) { return $false }
  return (
    $Diagnostic -match "Sign in to confirm" -or
    $Diagnostic -match "not a bot" -or
    $Diagnostic -match "authentication" -and $Diagnostic -match "cookies" -or
    $Diagnostic -match "YouTube cookies"
  )
}

function Test-MediaFile {
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
  return [double]::TryParse(([string]$duration).Trim(), [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$parsed) -and $parsed -gt 0
}

function Invoke-FallbackMediaStackSmoke {
  param([Parameter(Mandatory = $true)][string]$Url)

  Write-Warning "GitHub-hosted runner could not complete public YouTube acceptance. Running a neutral media-stack fallback; this does NOT count as owner-network YouTube acceptance."
  Get-ChildItem $tempRoot -Force -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

  $fallbackTemplate = Join-Path $tempRoot "subutai-media-fallback.%(ext)s"
  $stdoutPath = Join-Path $tempRoot "fallback.stdout.log"
  $stderrPath = Join-Path $tempRoot "fallback.stderr.log"
  $arguments = @(
    "--no-playlist",
    "--js-runtimes", "node:$node",
    "--ffmpeg-location", $resolvedEngineDir,
    "--output", $fallbackTemplate,
    $Url
  )
  $exitCode = Invoke-YtDlp -Arguments $arguments -StdoutPath $stdoutPath -StderrPath $stderrPath
  if ($exitCode -ne 0) {
    throw "Fallback media-stack download failed (exit $exitCode): $(Read-BoundedDiagnostic $stderrPath)"
  }

  $downloaded = Get-ChildItem $tempRoot -File |
    Where-Object {
      $_.Name -like "subutai-media-fallback.*" -and
      $_.Extension -notin @(".part", ".ytdl", ".log", ".json")
    } |
    Sort-Object Length -Descending |
    Select-Object -First 1
  if (-not $downloaded -or -not (Test-MediaFile -Path $downloaded.FullName)) {
    throw "Fallback media-stack download did not produce a valid playable media file."
  }

  Write-Host "Subutai packaged media stack passed neutral fallback: $($downloaded.Name), $($downloaded.Length) bytes."
  Write-Host "SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PENDING_HOSTED_RUNNER_CHALLENGE"
}

try {
  $runtime = "node:$node"
  $diagnostics = New-Object System.Collections.Generic.List[string]
  $sawHostedChallenge = $false
  $passed = $false
  $playerClientProfiles = @(
    @{ Name = "default"; Arguments = @() },
    @{ Name = "android_vr"; Arguments = @("--extractor-args", "youtube:player_client=android_vr") },
    @{ Name = "web_embedded"; Arguments = @("--extractor-args", "youtube:player_client=web_embedded") },
    @{ Name = "web_safari"; Arguments = @("--extractor-args", "youtube:player_client=web_safari") }
  )

  foreach ($testUrl in $TestUrls) {
    foreach ($profile in $playerClientProfiles) {
      Write-Host "Trying public YouTube acceptance candidate: $testUrl (profile=$($profile.Name))"
      Get-ChildItem $tempRoot -Force -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

      $probePath = Join-Path $tempRoot "probe.json"
      $probeErrorPath = Join-Path $tempRoot "probe.stderr.log"
      $probeArguments = @(
        "--dump-single-json",
        "--skip-download",
        "--no-warnings",
        "--no-playlist",
        "--js-runtimes", $runtime,
        "--ffmpeg-location", $resolvedEngineDir
      )
      $probeArguments += @($profile.Arguments)
      $probeArguments += $testUrl

      $probeExitCode = Invoke-YtDlp -Arguments $probeArguments -StdoutPath $probePath -StderrPath $probeErrorPath
      if ($probeExitCode -ne 0) {
        $diagnosticText = Read-DiagnosticText -Path $probeErrorPath
        if (Test-HostedYouTubeChallenge -Diagnostic $diagnosticText) { $sawHostedChallenge = $true }
        $diagnostics.Add("Probe failed for $testUrl profile=$($profile.Name) (exit $probeExitCode): $(Read-BoundedDiagnostic $probeErrorPath)")
        continue
      }

      try {
        $probe = Get-Content $probePath -Raw | ConvertFrom-Json
      } catch {
        $diagnostics.Add("Probe JSON was invalid for ${testUrl} profile=$($profile.Name): $($_.Exception.Message)")
        continue
      }
      if (-not $probe.id -or -not $probe.title) {
        $diagnostics.Add("Probe returned no id or title for $testUrl profile=$($profile.Name).")
        continue
      }
      Write-Host "YouTube probe passed: $($probe.title) [$($probe.id)] profile=$($profile.Name)"

      $outputTemplate = Join-Path $tempRoot "subutai-youtube-smoke.%(ext)s"
      $downloadOutputPath = Join-Path $tempRoot "download.stdout.log"
      $downloadErrorPath = Join-Path $tempRoot "download.stderr.log"
      $downloadArguments = @(
        "--no-playlist",
        "--js-runtimes", $runtime,
        "--ffmpeg-location", $resolvedEngineDir,
        "--format", "worstvideo*+worstaudio/worst",
        "--merge-output-format", "mp4",
        "--output", $outputTemplate
      )
      $downloadArguments += @($profile.Arguments)
      $downloadArguments += $testUrl

      $downloadExitCode = Invoke-YtDlp -Arguments $downloadArguments -StdoutPath $downloadOutputPath -StderrPath $downloadErrorPath
      if ($downloadExitCode -ne 0) {
        $diagnosticText = Read-DiagnosticText -Path $downloadErrorPath
        if (Test-HostedYouTubeChallenge -Diagnostic $diagnosticText) { $sawHostedChallenge = $true }
        $diagnostics.Add("Download failed for $testUrl profile=$($profile.Name) (exit $downloadExitCode): $(Read-BoundedDiagnostic $downloadErrorPath)")
        continue
      }

      $downloaded = Get-ChildItem $tempRoot -File |
        Where-Object {
          $_.Name -like "subutai-youtube-smoke.*" -and
          $_.Extension -notin @(".part", ".ytdl", ".log", ".json")
        } |
        Sort-Object Length -Descending |
        Select-Object -First 1

      if (-not $downloaded) {
        $diagnostics.Add("Download produced no media file for $testUrl profile=$($profile.Name).")
        continue
      }
      if (-not (Test-MediaFile -Path $downloaded.FullName)) {
        $diagnostics.Add("Download output was not a valid playable media file for ${testUrl} profile=$($profile.Name): $($downloaded.Length) bytes.")
        continue
      }

      Write-Host "Subutai YouTube download smoke passed: $($downloaded.Name), $($downloaded.Length) bytes, profile=$($profile.Name)."
      Write-Host "SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=HOSTED_RUNNER_PASS"
      $passed = $true
      break
    }
    if ($passed) { break }
  }

  if (-not $passed) {
    if ($sawHostedChallenge) {
      Invoke-FallbackMediaStackSmoke -Url $FallbackMediaUrl
    } else {
      throw "All public YouTube acceptance candidates and player-client profiles failed without a hosted-runner authentication challenge.`n$($diagnostics -join "`n")"
    }
  }
} finally {
  Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
