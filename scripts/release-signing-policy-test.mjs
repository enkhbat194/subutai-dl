import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const desktopPackage = JSON.parse(
  readFileSync(join(root, 'apps', 'desktop', 'package.json'), 'utf8'),
);
const releaseWorkflow = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8');
const signatureValidator = readFileSync(
  join(root, 'scripts', 'validate-windows-signatures.ps1'),
  'utf8',
);

function requireText(source, expected, label) {
  if (!source.includes(expected)) {
    throw new Error(`${label} is missing required signing contract: ${expected}`);
  }
}

const signedBuild = desktopPackage.scripts?.['build:win:signed'];
if (typeof signedBuild !== 'string') {
  throw new Error('Desktop package is missing build:win:signed.');
}
requireText(signedBuild, '--config.forceCodeSigning=true', 'Signed Windows build');

if (desktopPackage.build?.win?.verifyUpdateCodeSignature !== true) {
  throw new Error('Windows update installer signature verification must be explicitly enabled.');
}
const signExts = desktopPackage.build?.win?.signExts;
if (!Array.isArray(signExts) || !signExts.includes('subutai-engine-host.exe')) {
  throw new Error('The packaged Rust native host must be included in the Windows signing set.');
}
const signtoolOptions = desktopPackage.build?.win?.signtoolOptions;
if (
  !Array.isArray(signtoolOptions?.signingHashAlgorithms)
  || signtoolOptions.signingHashAlgorithms.length !== 1
  || signtoolOptions.signingHashAlgorithms[0] !== 'sha256'
) {
  throw new Error('Windows release signing must use SHA-256.');
}
if (signtoolOptions?.rfc3161TimeStampServer !== 'http://timestamp.digicert.com') {
  throw new Error('Windows release signing must use the pinned RFC 3161 timestamp service.');
}

for (const required of [
  'WIN_CSC_LINK: ${{ secrets.WIN_CSC_LINK }}',
  'WIN_CSC_KEY_PASSWORD: ${{ secrets.WIN_CSC_KEY_PASSWORD }}',
  'pnpm --filter @subutai/desktop build:win:signed',
  './scripts/validate-windows-signatures.ps1',
  'apps/desktop/release/SIGNATURES.json',
]) {
  requireText(releaseWorkflow, required, 'Release workflow');
}

for (const required of [
  'Get-AuthenticodeSignature',
  "Status -ne 'Valid'",
  'TimeStamperCertificate',
  'Get-FileHash',
  'SIGNATURES.json',
  'subutai-engine-host.exe',
]) {
  requireText(signatureValidator, required, 'Authenticode validator');
}

console.log('Subutai release signing policy passed: production builds require CI secrets, fail closed when unsigned, verify updater signatures and publish timestamped Authenticode evidence.');
