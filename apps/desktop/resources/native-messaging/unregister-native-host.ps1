$ErrorActionPreference = 'SilentlyContinue'
$hostName = 'com.subutai.download_manager'
$keys = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName",
  "HKCU:\Software\Mozilla\NativeMessagingHosts\$hostName"
)
foreach ($key in $keys) {
  Remove-Item -Path $key -Recurse -Force
}
$manifestDirectory = Join-Path $env:LOCALAPPDATA 'Subutai Download Manager\NativeMessaging'
Remove-Item -Path $manifestDirectory -Recurse -Force
Write-Output 'Subutai native messaging registration removed.'
