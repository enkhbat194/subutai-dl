import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const resilience = readFileSync(join(root, 'scripts', 'resilience-download-test.mjs'), 'utf8');
const soak = readFileSync(join(root, 'scripts', 'native-soak-benchmark.mjs'), 'utf8');
const soakSummary = readFileSync(join(root, 'scripts', 'publish-native-soak-summary.mjs'), 'utf8');
const acceptance = readFileSync(join(root, 'scripts', 'n5-windows-acceptance.ps1'), 'utf8');
const mediaInstaller = readFileSync(
  join(root, 'scripts', 'install-temporary-media-tools.ps1'),
  'utf8',
);
const releaseWorkflow = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8');
const acceptanceWorkflow = readFileSync(
  join(root, '.github', 'workflows', 'n5-production-acceptance.yml'),
  'utf8',
);

function requireText(source, expected, label) {
  if (!source.includes(expected)) throw new Error(`${label} is missing required contract: ${expected}`);
}

if (/aria2(?:c\.exe)?/iu.test(resilience)) {
  throw new Error('Resilience acceptance must not execute the replaced direct-download engine.');
}
requireText(resilience, "'subutai-engine.exe'", 'Native resilience suite');
requireText(resilience, "'download-segmented'", 'Native resilience suite');
requireText(resilience, 'Process-kill resume passed', 'Native resilience suite');
requireText(resilience, 'Network drop/rebind recovery checksum passed', 'Native resilience suite');

for (const required of [
  'SUBUTAI_SOAK_ITERATIONS',
  'SUBUTAI_SOAK_MAX_WORKING_SET_MIB',
  'SUBUTAI_SOAK_MAX_PRIVATE_MIB',
  'SUBUTAI_SOAK_MAX_HANDLES',
  'native-soak-report.json',
  'assertNoRecoveryFiles',
  'expectedSha256',
]) {
  requireText(soak, required, 'Native soak benchmark');
}
for (const required of [
  'GITHUB_STEP_SUMMARY',
  'SUBUTAI_NATIVE_SOAK_REPORT_BEGIN',
  'Machine-readable JSON report',
]) {
  requireText(soakSummary, required, 'Native soak summary publisher');
}

for (const required of [
  'Portable package launch acceptance passed.',
  'Installed Setup launch and browser bridge registration passed.',
  'Uninstall and browser bridge cleanup acceptance passed.',
  'subutai-engine-host.exe',
  'browser-extension\\chromium\\manifest.json',
  'browser-extension\\firefox\\manifest.json',
]) {
  requireText(acceptance, required, 'Windows acceptance script');
}

for (const required of [
  '2026.06.09',
  '3a48cb955d55c8821b60ccbdbbc6f61bc958f2f3d3b7ad5eaf3d83a543293a27',
  'ffmpeg-N-123778-g3b55818764-win64-gpl',
  '43f9f3491b86264a3b4104935283955002fd8a1413377c7d04a4c484576d6c11',
  'Get-FileHash',
  'aria2c.exe',
]) {
  requireText(mediaInstaller, required, 'Pinned media installer');
}
if (/\bchoco(?:latey)?\b/iu.test(mediaInstaller)) {
  throw new Error('Pinned media provisioning must not depend on Chocolatey.');
}

for (const required of [
  'pnpm test:resilience',
  'pnpm test:native-soak',
  'publish-native-soak-summary.mjs',
  'cargo build --release --manifest-path engines/native/Cargo.toml --bin subutai-engine',
  'pnpm test:production-acceptance',
  './scripts/install-temporary-media-tools.ps1',
  './scripts/n5-windows-acceptance.ps1',
]) {
  requireText(releaseWorkflow, required, 'Stable release workflow');
  requireText(acceptanceWorkflow, required, 'N5 acceptance workflow');
}

requireText(releaseWorkflow, 'SUBUTAI_SOAK_ITERATIONS: 16', 'Stable release extended soak');
requireText(releaseWorkflow, 'SUBUTAI_SOAK_MIB: 32', 'Stable release extended soak');
requireText(acceptanceWorkflow, 'SUBUTAI_SOAK_ITERATIONS: 8', 'N5 acceptance soak');
requireText(acceptanceWorkflow, 'SUBUTAI_SOAK_MIB: 8', 'N5 acceptance soak');

if (/\bchoco(?:latey)?\b/iu.test(releaseWorkflow) || /\bchoco(?:latey)?\b/iu.test(acceptanceWorkflow)) {
  throw new Error('Release and acceptance workflows must use checksum-verified pinned media provisioning.');
}
if (!acceptanceWorkflow.includes('runs-on: [self-hosted, Windows, X64, subutai]')) {
  throw new Error('N5 acceptance must execute on the real Subutai Windows runner.');
}
if (!acceptanceWorkflow.includes('contents: read')) {
  throw new Error('N5 acceptance workflow must be check-only with read repository permissions.');
}
if (acceptanceWorkflow.includes('softprops/action-gh-release')) {
  throw new Error('N5 acceptance workflow must not publish a release.');
}

console.log('Subutai N5 production acceptance policy passed: native soak telemetry, resilience, pinned media tools, Setup/Portable, browser bridge, uninstall and stable release gating.');
