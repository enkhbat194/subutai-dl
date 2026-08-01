param(
  [Parameter(Mandatory = $true)][string]$ExecutablePath
)

$ErrorActionPreference = 'Stop'
$hostName = 'com.subutai.download_manager'
$chromiumExtensionId = 'bblhcboekmbodhhgfonhggdhejlfgiep'
$firefoxExtensionId = 'subutai-download@subutai.local'
$manifestDirectory = Join-Path $env:LOCALAPPDATA 'Subutai Download Manager\NativeMessaging'
New-Item -ItemType Directory -Force -Path $manifestDirectory | Out-Null

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$chromiumManifestPath = Join-Path $manifestDirectory "$hostName.chromium.json"
$firefoxManifestPath = Join-Path $manifestDirectory "$hostName.firefox.json"

$chromiumManifest = [ordered]@{
  name = $hostName
  description = 'Subutai Download Manager native messaging host'
  path = [System.IO.Path]::GetFullPath($ExecutablePath)
  type = 'stdio'
  allowed_origins = @("chrome-extension://$chromiumExtensionId/")
} | ConvertTo-Json -Depth 4

$firefoxManifest = [ordered]@{
  name = $hostName
  description = 'Subutai Download Manager native messaging host'
  path = [System.IO.Path]::GetFullPath($ExecutablePath)
  type = 'stdio'
  allowed_extensions = @($firefoxExtensionId)
} | ConvertTo-Json -Depth 4

[System.IO.File]::WriteAllText($chromiumManifestPath, $chromiumManifest, $utf8NoBom)
[System.IO.File]::WriteAllText($firefoxManifestPath, $firefoxManifest, $utf8NoBom)

$registrations = @(
  @{ Key = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"; Manifest = $chromiumManifestPath },
  @{ Key = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"; Manifest = $chromiumManifestPath },
  @{ Key = "HKCU:\Software\Mozilla\NativeMessagingHosts\$hostName"; Manifest = $firefoxManifestPath }
)

foreach ($registration in $registrations) {
  New-Item -Path $registration.Key -Force | Out-Null
  Set-Item -Path $registration.Key -Value $registration.Manifest
}

Write-Output "Subutai native messaging registered for Chrome, Edge and Firefox."
