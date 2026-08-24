param(
  [string]$EngineDir = "apps/desktop/resources/engines/win32-x64",
  [string]$Python = "python",
  [string]$Url = "https://www.youtube.com/watch?v=jNQXAC9IVRw"
)

$ErrorActionPreference = "Stop"

$wpcVersion = "1.1.2"
$nodriverVersion = "0.50.3"
$runtimeVersions = [ordered]@{
  "mss" = "10.2.0"
  "websockets" = "16.1.1"
  "deprecated" = "1.3.1"
  "wrapt" = "2.3.0"
}
$expectedTopLevelPackages = @("deprecated", "mss", "nodriver", "websockets", "wrapt", "yt_dlp_plugins")

$engineRoot = (Resolve-Path $EngineDir).Path
$ytDlp = Join-Path $engineRoot "yt-dlp.exe"
if (-not (Test-Path $ytDlp)) { throw "Stage the pinned Subutai media tools first; missing $ytDlp" }

$tempBase = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$tempRoot = Join-Path $tempBase "SubutaiWpcPortableAudit"
$wheelhouse = Join-Path $tempRoot "wheelhouse"
$target = Join-Path $tempRoot "target"
$auditPluginRoot = Join-Path $engineRoot "yt-dlp-plugins\wpc-portable-audit"
$auditPluginPackage = Join-Path $auditPluginRoot "yt_dlp_plugins"
$auditVendorRoot = Join-Path $auditPluginRoot "vendor"
$evidencePath = Join-Path $tempRoot "wpc-portable-audit.json"

function Invoke-Checked {
  param([string]$Executable, [string[]]$Arguments, [string]$FailureMessage)
  & $Executable @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$FailureMessage (exit $LASTEXITCODE)." }
}

function Expand-Wheel {
  param([string]$Wheel, [string]$Destination)
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($Wheel, $Destination)
}

try {
  Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $auditPluginRoot -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $wheelhouse, $target, $auditPluginPackage, $auditVendorRoot | Out-Null

  # The official Windows yt-dlp standalone executable embeds CPython 3.10. Resolve
  # native wheels for that ABI, not the runner's Python 3.12. websockets 16.1.1 is
  # the newest Python-3.10-compatible release and satisfies nodriver's >=14 bound.
  $requirements = @(
    "yt-dlp-getpot-wpc==$wpcVersion",
    "nodriver==$nodriverVersion",
    "mss==$($runtimeVersions.mss)",
    "websockets==$($runtimeVersions.websockets)",
    "deprecated==$($runtimeVersions.deprecated)",
    "wrapt==$($runtimeVersions.wrapt)"
  )
  $downloadArgs = @(
    "-m", "pip", "download",
    "--disable-pip-version-check",
    "--no-input",
    "--only-binary=:all:",
    "--platform", "win_amd64",
    "--python-version", "310",
    "--implementation", "cp",
    "--abi", "cp310",
    "--dest", $wheelhouse
  ) + $requirements
  Invoke-Checked -Executable $Python -Arguments $downloadArgs -FailureMessage "Unable to resolve the pinned CPython 3.10 WPC dependency set"

  $wheels = @(Get-ChildItem $wheelhouse -File -Filter "*.whl" | Sort-Object Name)
  if ($wheels.Count -lt 6) { throw "Pinned WPC audit resolved an incomplete wheel set." }
  foreach ($wheel in $wheels) { Expand-Wheel -Wheel $wheel.FullName -Destination $target }

  $metadata = Get-ChildItem $target -Directory -Filter "*.dist-info" |
    Sort-Object Name |
    ForEach-Object {
      $metadataFile = Join-Path $_.FullName "METADATA"
      $name = ""; $version = ""
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
  if ($wpc.Count -ne 1 -or $wpc[0].version -ne $wpcVersion) { throw "Resolved WPC version is not $wpcVersion." }
  if ($nodriver.Count -ne 1 -or $nodriver[0].version -ne $nodriverVersion) { throw "Resolved nodriver version is not $nodriverVersion." }

  $topLevel = Get-ChildItem $target -Force | Where-Object { $_.Name -notmatch '\.(dist-info|data|pth)$' -and $_.Name -ne '__pycache__' }
  foreach ($required in $expectedTopLevelPackages) {
    if (-not ($topLevel.Name -contains $required -or $topLevel.Name -contains "$required.py")) {
      throw "Resolved CPython 3.10 WPC target is missing: $required"
    }
  }

  $upstreamPlugin = Join-Path $target "yt_dlp_plugins"
  Copy-Item (Join-Path $upstreamPlugin "*") $auditPluginPackage -Recurse -Force
  foreach ($dependency in @('nodriver','websockets','mss','deprecated','wrapt')) {
    $sourceDir = Join-Path $target $dependency
    $sourceFile = Join-Path $target "$dependency.py"
    if (Test-Path $sourceDir) { Copy-Item $sourceDir $auditVendorRoot -Recurse -Force }
    elseif (Test-Path $sourceFile) { Copy-Item $sourceFile $auditVendorRoot -Force }
    else { throw "WPC audit dependency payload is missing: $dependency" }
  }

  # yt-dlp deliberately isolates plugin discovery and does not expose sibling modules
  # as normal Python imports. Inject the filesystem vendor root before the provider's
  # first `import nodriver`. Keeping native cp310 .pyd files on disk (not in a zip)
  # also lets CPython load websockets/wrapt extension modules normally.
  $providerPath = Join-Path $auditPluginPackage "extractor\getpot_wpc.py"
  if (-not (Test-Path $providerPath)) { throw "WPC provider source is missing after staging." }
  $providerSource = Get-Content $providerPath -Raw
  if ($providerSource -notmatch '(?m)^import nodriver\s*$') { throw "WPC provider import layout changed; refusing an unverified audit patch." }
  $vendorBootstrap = @'
import sys
from pathlib import Path
_subutai_vendor = Path(__file__).resolve().parents[2] / "vendor"
if str(_subutai_vendor) not in sys.path:
    sys.path.insert(0, str(_subutai_vendor))
'@
  $providerSource = $providerSource -replace '(?m)^import nodriver\s*$', ($vendorBootstrap + "`nimport nodriver")
  [System.IO.File]::WriteAllText($providerPath, $providerSource, (New-Object System.Text.UTF8Encoding($false)))

  $stdout = Join-Path $tempRoot "yt-dlp.stdout.log"
  $stderr = Join-Path $tempRoot "yt-dlp.stderr.log"
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & $ytDlp --verbose --simulate --skip-download --no-playlist --socket-timeout 15 --extractor-args "youtube:player_client=mweb" $Url 1> $stdout 2> $stderr
    $probeExitCode = $LASTEXITCODE
  } finally { $ErrorActionPreference = $previous }

  $stdoutText = [string](Get-Content $stdout -Raw -ErrorAction SilentlyContinue)
  $stderrText = [string](Get-Content $stderr -Raw -ErrorAction SilentlyContinue)
  $combined = $stdoutText + "`n" + $stderrText
  $providerLoaded = $combined -match '(?im)PO Token Providers:.*\bwpc-1\.1\.2\b' -or $combined -match '(?im)\bwpc-1\.1\.2\s*\(external\)'
  $importFailure = $combined -match '(?im)(ModuleNotFoundError|ImportError|DLL load failed).*?(nodriver|websockets|mss|deprecated|wrapt)'
  $diagnostics = @($combined -split "`r?`n" | Where-Object { $_ -match '(?i)(Python |Plugin|PO Token|ImportError|ModuleNotFoundError|DLL load|wpc|nodriver)' } | Select-Object -Last 30)

  $evidence = [pscustomobject]@{
    wpcVersion = $wpcVersion
    nodriverVersion = $nodriverVersion
    targetPythonAbi = "cp310-win_amd64"
    packagingLayout = "external-plugin-with-filesystem-vendor-bootstrap"
    wheels = @($wheels | ForEach-Object { [pscustomobject]@{ name = $_.Name; sha256 = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() } })
    resolvedDistributions = $metadata
    probeExitCode = $probeExitCode
    providerLoaded = $providerLoaded
    dependencyImportFailure = $importFailure
    diagnostics = $diagnostics
    note = "Probe exit may be nonzero on hosted/datacenter networks; pass means portable provider discovery/import only, never owner YouTube acceptance."
  }
  $evidence | ConvertTo-Json -Depth 7 | Set-Content -Path $evidencePath -Encoding UTF8

  if ($diagnostics.Count -gt 0) { $diagnostics | ForEach-Object { Write-Host $_ } }
  if ($importFailure) { throw "Standalone yt-dlp failed importing the filesystem-vendored WPC dependency set. Evidence: $evidencePath" }
  if (-not $providerLoaded) { throw "Standalone yt-dlp did not report WPC 1.1.2 as an external PO-token provider. Evidence: $evidencePath" }

  Write-Host "WPC portable dependency audit passed: standalone yt-dlp loaded wpc-$wpcVersion with nodriver-$nodriverVersion."
  Write-Host "This proves packaging feasibility only; it does not satisfy SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PASS."
} finally {
  Remove-Item $auditPluginRoot -Recurse -Force -ErrorAction SilentlyContinue
}
