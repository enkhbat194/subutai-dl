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
$ffmpeg = Join-Path $resolvedEngineDir "ffmpeg.exe"
$node = Join-Path $resolvedEngineDir "node.exe"

foreach ($path in @($ytDlp, $ffmpeg, $node)) {
  if (-not (Test-Path $path)) { throw "YouTube smoke dependency is missing: $path" }
}

if (-not $TestUrls -or $TestUrls.Count -eq 0) {
  throw "YouTube smoke requires at least one public test URL."
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "SubutaiYouTubeSmoke"
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
    # Windows PowerShell promotes native stderr to an ErrorRecord when Stop is active.
    # Keep the process alive, then evaluate its real exit code and bounded stderr below.
    $ErrorActionPreference = "Continue"
    & $ytDlp @Arguments 1> $StdoutPath 2> $StderrPath
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorAction
  }
}

function Read-BoundedDiagnostic {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path $Path)) { return "No stderr output." }
  $lines = @(Get-Content $Path -ErrorAction SilentlyContinue | Where-Object { $_ -and $_.Trim() })
  if ($lines.Count -eq 0) { return "No stderr output." }
  return ($lines | Select-Object -Last 8) -join " | "
}

try {
  $runtime = "node:$node"
  $diagnostics = New-Object System.Collections.Generic.List[string]
  $passed = $false

  foreach ($testUrl in $TestUrls) {
    Write-Host "Trying public YouTube acceptance candidate: $testUrl"
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
      "--ffmpeg-location", $resolvedEngineDir,
      $testUrl
    )
    $probeExitCode = Invoke-YtDlp -Arguments $probeArguments -StdoutPath $probePath -StderrPath $probeErrorPath
    if ($probeExitCode -ne 0) {
      $diagnostics.Add("Probe failed for $testUrl (exit $probeExitCode): $(Read-BoundedDiagnostic $probeErrorPath)")
      continue
    }

    try {
      $probe = Get-Content $probePath -Raw | ConvertFrom-Json
    } catch {
      $diagnostics.Add("Probe JSON was invalid for $testUrl: $($_.Exception.Message)")
      continue
    }
    if (-not $probe.id -or -not $probe.title) {
      $diagnostics.Add("Probe returned no id or title for $testUrl.")
      continue
    }
    Write-Host "YouTube probe passed: $($probe.title) [$($probe.id)]"

    $outputTemplate = Join-Path $tempRoot "subutai-youtube-smoke.%(ext)s"
    $downloadOutputPath = Join-Path $tempRoot "download.stdout.log"
    $downloadErrorPath = Join-Path $tempRoot "download.stderr.log"
    $downloadArguments = @(
      "--no-playlist",
      "--js-runtimes", $runtime,
      "--ffmpeg-location", $resolvedEngineDir,
      "--format", "worstvideo*+worstaudio/worst",
      "--merge-output-format", "mp4",
      "--output", $outputTemplate,
      $testUrl
    )
    $downloadExitCode = Invoke-YtDlp -Arguments $downloadArguments -StdoutPath $downloadOutputPath -StderrPath $downloadErrorPath
    if ($downloadExitCode -ne 0) {
      $diagnostics.Add("Download failed for $testUrl (exit $downloadExitCode): $(Read-BoundedDiagnostic $downloadErrorPath)")
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
      $diagnostics.Add("Download produced no media file for $testUrl.")
      continue
    }
    if ($downloaded.Length -lt 32KB) {
      $diagnostics.Add("Download output was unexpectedly small for $testUrl: $($downloaded.Length) bytes.")
      continue
    }

    Write-Host "Subutai YouTube download smoke passed: $($downloaded.Name), $($downloaded.Length) bytes."
    $passed = $true
    break
  }

  if (-not $passed) {
    throw "All public YouTube acceptance candidates failed.`n$($diagnostics -join "`n")"
  }
} finally {
  Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
