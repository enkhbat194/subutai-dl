param(
  [string]$ReleaseDir = "apps/desktop/release"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $ReleaseDir)) {
  throw "Release directory does not exist: $ReleaseDir"
}

$package = Get-Content -LiteralPath "apps/desktop/package.json" -Raw | ConvertFrom-Json
$version = [string]$package.version
$releasePath = (Resolve-Path -LiteralPath $ReleaseDir).Path
$targets = @(
  Get-Item -LiteralPath (Join-Path $releasePath "Subutai-Setup-$version-x64.exe")
  Get-Item -LiteralPath (Join-Path $releasePath "Subutai-Portable-$version-x64.exe")
  Get-Item -LiteralPath (Join-Path $releasePath "win-unpacked\Subutai Download Manager.exe")
  Get-Item -LiteralPath (Join-Path $releasePath "win-unpacked\resources\engines\subutai-engine-host.exe")
)

$evidence = foreach ($target in $targets) {
  $signature = Get-AuthenticodeSignature -LiteralPath $target.FullName
  if ($signature.Status -ne 'Valid') {
    throw "Authenticode signature is not valid for $($target.Name): $($signature.Status) $($signature.StatusMessage)"
  }
  if ($null -eq $signature.SignerCertificate) {
    throw "Authenticode signer certificate is missing for $($target.Name)."
  }
  if ($null -eq $signature.TimeStamperCertificate) {
    throw "RFC 3161 timestamp certificate is missing for $($target.Name)."
  }

  $hash = Get-FileHash -LiteralPath $target.FullName -Algorithm SHA256
  [ordered]@{
    path = [IO.Path]::GetRelativePath($releasePath, $target.FullName).Replace('\\', '/')
    sha256 = $hash.Hash.ToLowerInvariant()
    signerSubject = $signature.SignerCertificate.Subject
    signerIssuer = $signature.SignerCertificate.Issuer
    signerThumbprint = $signature.SignerCertificate.Thumbprint
    signerNotAfterUtc = $signature.SignerCertificate.NotAfter.ToUniversalTime().ToString('o')
    timestampSubject = $signature.TimeStamperCertificate.Subject
    timestampIssuer = $signature.TimeStamperCertificate.Issuer
    timestampNotAfterUtc = $signature.TimeStamperCertificate.NotAfter.ToUniversalTime().ToString('o')
  }
}

$publisherThumbprints = @($evidence | ForEach-Object { $_.signerThumbprint } | Sort-Object -Unique)
if ($publisherThumbprints.Count -ne 1) {
  throw "Subutai-owned executables were not signed by one publisher certificate: $($publisherThumbprints -join ', ')"
}

$report = [ordered]@{
  schemaVersion = 1
  generatedAtUtc = [DateTime]::UtcNow.ToString('o')
  product = [string]$package.productName
  version = $version
  publisherSubject = [string]$evidence[0].signerSubject
  publisherThumbprint = [string]$evidence[0].signerThumbprint
  files = @($evidence)
}
$evidencePath = Join-Path $releasePath 'SIGNATURES.json'
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $evidencePath -Encoding utf8

Write-Host "Subutai Windows Authenticode validation passed."
Write-Host "Publisher: $($report.publisherSubject)"
Write-Host "Signed files: $($report.files.Count)"
Write-Host "Evidence: $evidencePath"
