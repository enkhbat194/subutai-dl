param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$RootPath = '',
  [ValidateRange(2, 10)][int]$RetentionCount = 4
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-AtomicUtf8Json {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)]$Value)
  $directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $temporary = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
  $backup = "$Path.bak"
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 8), $utf8NoBom)
  $stream = [System.IO.File]::Open($temporary, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  try { $stream.Flush($true) } finally { $stream.Dispose() }
  if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }
  if (Test-Path -LiteralPath $Path) { Move-Item -LiteralPath $Path -Destination $backup -Force }
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

if ($Version -notmatch '^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$') {
  throw 'Installer version is invalid.'
}
$source = [System.IO.Path]::GetFullPath($InstallerPath)
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw 'Current Setup installer is unavailable.' }
if ([System.IO.Path]::GetExtension($source) -ne '.exe') { throw 'Rollback package must be a Setup executable.' }

if ([string]::IsNullOrWhiteSpace($RootPath)) {
  $RootPath = Join-Path $env:LOCALAPPDATA 'Subutai\Updater'
}
$root = [System.IO.Path]::GetFullPath($RootPath)
$packageDirectory = Join-Path $root "packages\$Version"
New-Item -ItemType Directory -Force -Path $packageDirectory | Out-Null
$destination = Join-Path $packageDirectory "Subutai-Setup-$Version-rollback.exe"
Copy-Item -LiteralPath $source -Destination $destination -Force

$sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
$destinationHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
if ($sourceHash -ne $destinationHash) {
  Remove-Item -LiteralPath $destination -Force -ErrorAction SilentlyContinue
  throw 'Rollback package copy checksum mismatch.'
}

$manifest = [ordered]@{
  schemaVersion = 1
  version = $Version
  installerPath = [System.IO.Path]::GetFullPath($destination)
  sha256 = $destinationHash
  cachedAt = [DateTime]::UtcNow.ToString('o')
}
Write-AtomicUtf8Json -Path (Join-Path $packageDirectory 'package.json') -Value $manifest

$packagesRoot = Join-Path $root 'packages'
$packageEntries = @(Get-ChildItem -LiteralPath $packagesRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
  $manifestPath = Join-Path $_.FullName 'package.json'
  $cachedAt = [DateTime]::MinValue
  if (Test-Path -LiteralPath $manifestPath) {
    try {
      $metadata = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
      $cachedAt = [DateTime]::Parse([string]$metadata.cachedAt).ToUniversalTime()
    } catch { $cachedAt = [DateTime]::MinValue }
  }
  [pscustomobject]@{ Directory = $_.FullName; Version = $_.Name; CachedAt = $cachedAt }
} | Sort-Object CachedAt -Descending)

$kept = 0
foreach ($entry in $packageEntries) {
  if ($entry.Version -eq $Version -or $kept -lt $RetentionCount) {
    $kept += 1
    continue
  }
  Remove-Item -LiteralPath $entry.Directory -Recurse -Force
}

Write-Output "Subutai rollback package cached for version $Version with SHA-256 $destinationHash."
