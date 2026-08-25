param([string]$EngineDir = "apps/desktop/resources/engines/win32-x64")
$ErrorActionPreference = "Stop"

$zipUrl = "https://github.com/jim60105/bgutil-ytdlp-pot-provider-rs/releases/download/v0.8.1/bgutil-ytdlp-pot-provider-rs.zip"
$zipSha = "99fd83b98fa93b193d6a3b69dc74410d76e7a2b889868c54d16121cac9060344"
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "SubutaiBgUtilPluginInspect"
$zip = Join-Path $tempRoot "plugin.zip"
$extract = Join-Path $tempRoot "extract"
$ytDlp = (Resolve-Path (Join-Path $EngineDir "yt-dlp.exe")).Path

try {
  Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $tempRoot, $extract | Out-Null
  $curl = (Get-Command curl.exe -ErrorAction Stop).Source
  & $curl -L --fail --silent --show-error --max-time 120 --output $zip $zipUrl
  if ($LASTEXITCODE -ne 0) { throw "plugin download failed" }
  $actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $zipSha) { throw "plugin checksum mismatch: $actual" }
  Expand-Archive $zip -DestinationPath $extract -Force

  Write-Host "=== extracted plugin tree ==="
  Get-ChildItem $extract -Recurse -Force | ForEach-Object { Write-Host $_.FullName }

  $pluginFiles = @(Get-ChildItem $extract -Recurse -File -Filter "getpot_bgutil*.py")
  if ($pluginFiles.Count -eq 0) { throw "no getpot plugin files found" }

  $pluginRoots = New-Object System.Collections.Generic.List[string]
  foreach ($file in $pluginFiles) {
    $dir = $file.Directory
    while ($dir -and $dir.Name -ne "yt_dlp_plugins") { $dir = $dir.Parent }
    if ($dir -and $dir.Parent -and -not $pluginRoots.Contains($dir.Parent.FullName)) {
      $pluginRoots.Add($dir.Parent.FullName)
    }
  }
  if ($pluginRoots.Count -eq 0) { throw "could not resolve parent of yt_dlp_plugins" }

  foreach ($root in $pluginRoots) {
    Write-Host "=== testing plugin root: $root ==="
    $previous = $ErrorActionPreference
    try {
      $ErrorActionPreference = "Continue"
      & $ytDlp --ignore-config --verbose --plugin-dirs $root --simulate "https://www.youtube.com/watch?v=jNQXAC9IVRw" 2>&1 | ForEach-Object { Write-Host $_ }
      Write-Host "yt-dlp plugin root probe exit=$LASTEXITCODE"
    } finally {
      $ErrorActionPreference = $previous
    }
  }
} finally {
  Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
