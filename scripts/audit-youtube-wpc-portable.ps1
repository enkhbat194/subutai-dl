param(
  [string]$EngineDir = "apps/desktop/resources/engines/win32-x64",
  [string]$Python = "python",
  [string]$Url = "https://www.youtube.com/watch?v=jNQXAC9IVRw"
)

$ErrorActionPreference = "Stop"

$wpcVersion = "1.1.2"
$nodriverVersion = "0.50.3"
$expectedTopLevelPackages = @(
  "deprecated",
  "mss",
  "nodriver",
  "websockets",
  "wrapt",
  "yt_dlp_plugins"
)

$engineRoot = (Resolve-Path $EngineDir).Path
$ytDlp = Join-Path $engineRoot "yt-dlp.exe"
if (-not (Test-Path $ytDlp)) {
  throw "Stage the pinned Subutai media tools first; missing $ytDlp"
}

$tempBase = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$tempRoot = Join-Path $tempBase "SubutaiWpcPortableAudit"
$target = Join-Path $tempRoot "target"
$auditPluginRoot = Join-Path $engineRoot "yt-dlp-plugins\wpc-portable-audit"
$auditPluginPackage = Join-Path $auditPluginRoot "yt_dlp_plugins"
$evidencePath = Join-Path $tempRoot "wpc-portable-audit.json"

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$FailureMessage
  )
  & $Executable @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$FailureMessage (exit $LASTEXITCODE)."
  }
}

try {
  Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $auditPluginRoot -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $target, $auditPluginPackage | Out-Null

  # This is an engineering audit, not release staging. Resolve the exact WPC/nodriver
  # pair into a throw-away target so we can prove whether the standalone yt-dlp
  # interpreter can import the browser provider without adding a second Python runtime.
  Invoke-Checked -Executable $Python -Arguments @(
    "-m", "pip", "install",
    "--disable-pip-version-check",
    "--no-input",
    "--no-cache-dir",
    "--target", $target,
    "yt-dlp-getpot-wpc==$wpcVersion",
    "nodriver==$nodriverVersion"
  ) -FailureMessage "Unable to resolve the pinned WPC audit dependency set"

  $metadata = Get-ChildItem $target -Directory -Filter "*.dist-info" |
    Sort-Object Name |
    ForEach-Object {
      $metadataFile = Join-Path $_.FullName "METADATA"
      $name = ""
      $version = ""
      if (Test-Path $metadataFile) {
        foreach ($line in (Get-Content $metadataFile)) {
          if (-not $name -and $line -match '^Name:\s*(.+)$') { $name = $Matches[1].Trim() }
          if (-not $version -and $line -match '^Version:\s*(.+)$') { $version = $Matches[1].Trim() }
          if ($name -and $version) { break }
        }
      }
      [pscustomobject]@{ name = $name; version = $version; directory = $_.Name }
    }

  $wpc = @($metadata | Where-Object { $_.name -eq 'yt-dlp-getpot-wpc' })
  $nodriver = @($metadata | Where-Object { $_.name -eq 'nodriver' })
  if ($wpc.Count -ne 1 -or $wpc[0].version -ne $wpcVersion) {
    throw "Resolved WPC version does not match the pinned audit version $wpcVersion."
  }
  if ($nodriver.Count -ne 1 -or $nodriver[0].version -ne $nodriverVersion) {
    throw "Resolved nodriver version does not match the pinned audit version $nodriverVersion."
  }

  $topLevel = Get-ChildItem $target -Force |
    Where-Object { $_.Name -notmatch '\.(dist-info|pth)$' -and $_.Name -ne '__pycache__' }
  foreach ($required in $expectedTopLevelPackages) {
    if (-not ($topLevel.Name -contains $required -or $topLevel.Name -contains "$required.py")) {
      throw "Resolved WPC audit target is missing expected runtime package: $required"
    }
  }

  $upstreamPlugin = Join-Path $target "yt_dlp_plugins"
  if (-not (Test-Path $upstreamPlugin)) {
    throw "WPC wheel did not expose yt_dlp_plugins."
  }
  Copy-Item (Join-Path $upstreamPlugin "*") $auditPluginPackage -Recurse -Force

  # yt-dlp's portable plugin loader adds each yt_dlp_plugins directory to its plugin
  # search path. Put the pure-Python dependency modules beside the extractor package
  # in that same directory for this audit, then verify imports using the actual
  # standalone yt-dlp.exe that Subutai packages.
  foreach ($dependency in @('nodriver','websockets','mss','deprecated','wrapt')) {
    $sourceDir = Join-Path $target $dependency
    $sourceFile = Join-Path $target "$dependency.py"
    if (Test-Path $sourceDir) {
      Copy-Item $sourceDir $auditPluginPackage -Recurse -Force
    } elseif (Test-Path $sourceFile) {
      Copy-Item $sourceFile $auditPluginPackage -Force
    } else {
      throw "WPC audit dependency payload is missing: $dependency"
    }
  }

  $stdout = Join-Path $tempRoot "yt-dlp.stdout.log"
  $stderr = Join-Path $tempRoot "yt-dlp.stderr.log"
  $previousErrorAction = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & $ytDlp --verbose --simulate --skip-download --no-playlist --extractor-args "youtube:player_client=mweb" $Url 1> $stdout 2> $stderr
    $probeExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorAction
  }

  $combined = ((Get-Content $stdout -Raw -ErrorAction SilentlyContinue) + "`n" + (Get-Content $stderr -Raw -ErrorAction SilentlyContinue))
  $providerLoaded = $combined -match '(?im)PO Token Providers:.*\bwpc-1\.1\.2\b' -or $combined -match '(?im)\bwpc-1\.1\.2\s*\(external\)'
  $importFailure = $combined -match '(?im)(ModuleNotFoundError|ImportError).*?(nodriver|websockets|mss|deprecated|wrapt)'

  $evidence = [pscustomobject]@{
    wpcVersion = $wpcVersion
    nodriverVersion = $nodriverVersion
    resolvedDistributions = $metadata
    probeExitCode = $probeExitCode
    providerLoaded = $providerLoaded
    dependencyImportFailure = $importFailure
    note = "Probe exit may be nonzero on hosted/datacenter networks; this audit passes only on portable provider discovery/import, not on YouTube owner acceptance."
  }
  $evidence | ConvertTo-Json -Depth 6 | Set-Content -Path $evidencePath -Encoding UTF8

  if ($importFailure) {
    throw "Standalone yt-dlp discovered the audit path but failed importing a WPC dependency. Evidence: $evidencePath"
  }
  if (-not $providerLoaded) {
    throw "Standalone yt-dlp did not report WPC 1.1.2 as an external PO-token provider. Evidence: $evidencePath"
  }

  Write-Host "WPC portable dependency audit passed: standalone yt-dlp loaded wpc-$wpcVersion with nodriver-$nodriverVersion."
  Write-Host "This proves packaging feasibility only; it does not satisfy SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PASS."
} finally {
  Remove-Item $auditPluginRoot -Recurse -Force -ErrorAction SilentlyContinue
}
