import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');
const wrapper = read('scripts', 'run-real-update-acceptance-safely.ps1');
const harness = read('scripts', 'real-two-installer-acceptance.ps1');
const stateProbe = read('scripts', 'real-update-state-probe.mjs');
const feedServer = read('scripts', 'real-update-feed-server.mjs');
const acceptanceRuntime = read(
  'apps', 'desktop', 'src', 'main', 'system', 'real-update-acceptance.ts',
);
const desktopMain = read('apps', 'desktop', 'src', 'main', 'index.ts');
const transactionalUpdater = read(
  'apps', 'desktop', 'src', 'main', 'system', 'transactional-updater.ts',
);
const viteConfig = read('apps', 'desktop', 'electron.vite.config.ts');
const workflow = read('.github', 'workflows', 'real-update-acceptance.yml');

function requireText(source, expected, label) {
  if (!source.includes(expected)) throw new Error(`${label} is missing required contract: ${expected}`);
}

for (const required of [
  'SubutaiRealUpdateSafety-',
  'com.subutai.downloadmanager.real-update-acceptance',
  "acceptanceProductName = 'Subutai Real Update Acceptance'",
  '$package.build.productName = $acceptanceProductName',
  '$package.build.appId = $acceptanceAppId',
  '$package.build.nsis.shortcutName = $acceptanceProductName',
  'Set-AcceptanceAppIdentity',
  'Set-AcceptanceHarnessIdentity',
  'Replace-ExactlyOnce',
  'desktopPackageOriginal',
  'harnessOriginal',
  'Capture-Directory',
  'Restore-DirectoryState',
  'Remove-BrowserRegistration',
  "-ArgumentList @('/S')",
  'real-two-installer-acceptance.ps1',
  'pre-existing-state',
]) {
  requireText(wrapper, required, 'Real update runner safety wrapper');
}
if (wrapper.includes('$package | Add-Member -NotePropertyName productName')) {
  throw new Error('Acceptance identity must mutate build.productName, not a shadow top-level package property.');
}

for (const required of [
  "BaselineVersion = '0.1.0'",
  "TargetVersion = '0.2.0'",
  "'Programs\\SubutaiRealUpdateAcceptance'",
  'electron-builder',
  "'--win', 'nsis'",
  "'--publish', 'never'",
  'SUBUTAI_REAL_UPDATE_ACCEPTANCE_BUILD',
  'latest.yml',
  '.exe.blockmap',
  'SHA256SUMS.txt',
  'Get-Sha512Base64',
  'Get-Sha256',
  "Invoke-Scenario -Mode 'healthy'",
  "Invoke-Scenario -Mode 'rollback'",
  "Invoke-Scenario -Mode 'checksum-mismatch'",
  'stateBeforeSha256',
  'stateAfterSha256',
  'Get-RegistryEvidence',
  'watchdogEvidence',
  'testedCommitSha',
  'noTag = $true',
  'noRelease = $true',
  'noPublish = $true',
  'noDeploy = $true',
]) {
  requireText(harness, required, 'Real two-installer acceptance harness');
}

for (const required of [
  "from 'node:sqlite'",
  'subutai.db',
  'real-update-acceptance-job',
  'acceptance.bin.subutai.part',
  'acceptance.bin.subutai.job',
  'logicalStateSha256',
]) {
  requireText(stateProbe, required, 'Real update state probe');
}

for (const required of [
  "host: '127.0.0.1'",
  'port: 0',
  'Cache-Control',
  'no-store',
  "['GET', 'HEAD']",
]) {
  requireText(feedServer, required, 'Loopback update feed server');
}

for (const required of [
  '__SUBUTAI_REAL_UPDATE_ACCEPTANCE_BUILD__',
  'assertLoopbackFeedUrl',
  "provider: 'generic'",
  'SUBUTAI_REAL_UPDATE_ACCEPTANCE',
  'shouldFailRealUpdateAcceptanceHealth',
  'recordHealthyRealUpdateAcceptance',
  'recordRolledBackRealUpdateAcceptance',
]) {
  requireText(acceptanceRuntime, required, 'Packaged real update acceptance runtime');
}
for (const required of [
  'initializeRealUpdateAcceptance',
  'startRealUpdateAcceptanceDriver',
  'shouldFailRealUpdateAcceptanceHealth',
  'recordHealthyRealUpdateAcceptance',
  'recordRolledBackRealUpdateAcceptance',
]) {
  requireText(desktopMain, required, 'Desktop acceptance wiring');
}
requireText(transactionalUpdater, 'realUpdateAcceptanceTransactionOptions', 'Transactional updater acceptance wiring');
requireText(viteConfig, 'SUBUTAI_REAL_UPDATE_ACCEPTANCE_BUILD', 'Acceptance-only build boundary');

for (const required of [
  'runs-on: [self-hosted, Windows, X64, subutai]',
  'contents: read',
  'pnpm test:real-update-policy',
  './scripts/run-real-update-acceptance-safely.ps1',
  'real-two-installer-acceptance-report.json',
  'if: always()',
]) {
  requireText(workflow, required, 'Real updater acceptance workflow');
}

for (const forbidden of [
  'softprops/action-gh-release',
  'contents: write',
  'git tag',
  'gh release',
  '--publish always',
]) {
  if (workflow.includes(forbidden)) {
    throw new Error(`Real updater acceptance workflow contains forbidden publication behavior: ${forbidden}`);
  }
}
if (!workflow.includes('workflow_dispatch:') || !workflow.includes('pull_request:')) {
  throw new Error('Real updater acceptance must support manual and pull-request execution.');
}

console.log('Subutai real two-installer updater acceptance policy passed: acceptance-only appId/build.productName/default install path, safety-isolated real NSIS A/B builds, loopback feed, healthy update, forced rollback, checksum rejection, durable user state, browser bridge evidence and read-only execution are locked.');
