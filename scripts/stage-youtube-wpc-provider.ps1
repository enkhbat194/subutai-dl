param(
  [string]$EngineDir = "apps/desktop/resources/engines/win32-x64",
  [string]$Python = "python"
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

$engineRoot = (Resolve-Path $EngineDir).Path
$ytDlp = Join-Path $engineRoot "yt-dlp.exe"
if (-not (Test-Path $ytDlp)) { throw "Stage the pinned Subutai media tools first; missing $ytDlp" }

$tempBase = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$tempRoot = Join-Path $tempBase "SubutaiWpcProviderStage"
$wheelhouse = Join-Path $tempRoot "wheelhouse"
$target = Join-Path $tempRoot "target"
$pluginRoot = Join-Path $engineRoot "yt-dlp-plugins\subutai-wpc"
$pluginPackage = Join-Path $pluginRoot "yt_dlp_plugins"
$vendorRoot = Join-Path $pluginRoot "vendor"
$manifestPath = Join-Path $pluginRoot "subutai-wpc-manifest.json"

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
  Remove-Item $pluginRoot -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $wheelhouse, $target, $pluginPackage, $vendorRoot | Out-Null

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
  if ($wheels.Count -lt 6) { throw "Pinned WPC provider resolved an incomplete wheel set." }
  foreach ($wheel in $wheels) { Expand-Wheel -Wheel $wheel.FullName -Destination $target }

  $upstreamPlugin = Join-Path $target "yt_dlp_plugins"
  $providerPath = Join-Path $upstreamPlugin "extractor\getpot_wpc.py"
  if (-not (Test-Path $providerPath)) { throw "WPC provider source is missing after dependency staging." }
  Copy-Item (Join-Path $upstreamPlugin "*") $pluginPackage -Recurse -Force

  foreach ($dependency in @("nodriver", "websockets", "mss", "deprecated", "wrapt")) {
    $sourceDir = Join-Path $target $dependency
    $sourceFile = Join-Path $target "$dependency.py"
    if (Test-Path $sourceDir) { Copy-Item $sourceDir $vendorRoot -Recurse -Force }
    elseif (Test-Path $sourceFile) { Copy-Item $sourceFile $vendorRoot -Force }
    else { throw "WPC runtime dependency payload is missing: $dependency" }
  }

  $packagedProviderPath = Join-Path $pluginPackage "extractor\getpot_wpc.py"
  $providerSource = Get-Content $packagedProviderPath -Raw
  if ($providerSource -notmatch '(?m)^import nodriver\s*$') {
    throw "WPC provider import layout changed; refusing an unverified packaging patch."
  }
  $vendorBootstrap = @'
import sys
from pathlib import Path
_subutai_vendor = Path(__file__).resolve().parents[2] / "vendor"
if str(_subutai_vendor) not in sys.path:
    sys.path.insert(0, str(_subutai_vendor))
'@
  $providerSource = $providerSource -replace '(?m)^import nodriver\s*$', ($vendorBootstrap + "`nimport nodriver")
  [System.IO.File]::WriteAllText($packagedProviderPath, $providerSource, (New-Object System.Text.UTF8Encoding($false)))

  $manifest = [ordered]@{
    schemaVersion = 1
    provider = "yt-dlp-getpot-wpc"
    providerVersion = $wpcVersion
    nodriverVersion = $nodriverVersion
    targetPythonAbi = "cp310-win_amd64"
    packagingLayout = "external-plugin-with-filesystem-vendor-bootstrap"
    wheels = @($wheels | ForEach-Object {
      [ordered]@{
        name = $_.Name
        sha256 = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      }
    })
  }
  $manifest | ConvertTo-Json -Depth 6 | Set-Content -Path $manifestPath -Encoding UTF8

  foreach ($required in @(
    $packagedProviderPath,
    (Join-Path $vendorRoot "nodriver"),
    (Join-Path $vendorRoot "websockets"),
    (Join-Path $vendorRoot "mss"),
    (Join-Path $vendorRoot "deprecated"),
    (Join-Path $vendorRoot "wrapt"),
    $manifestPath
  )) {
    if (-not (Test-Path $required)) { throw "Packaged WPC provider component is missing: $required" }
  }

  Write-Host "Packaged browser-minted YouTube WPC provider staged: wpc-$wpcVersion / nodriver-$nodriverVersion."
} finally {
  Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
