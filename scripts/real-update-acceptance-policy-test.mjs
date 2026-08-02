import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');
const wrapper = read('scripts', 'run-real-update-acceptance-safely.ps1');
const harness = read('scripts', 'real-two-installer-acceptance.ps1');
const stateProbe = read('scripts', 'real-update-state-probe.mjs');
const feedServer = read('scripts', 'real-update-feed-server.mjs');
const installerInclude = read('apps', 'desktop', 'build', 'installer.nsh');
const acceptanceRuntime = read(
  'apps', 'desktop', 'src', 'main', 'system', 'real-update-acceptance.ts',
);
const desktopMain = read('apps', 'desktop', 'src', 'main', 'index.ts');
const transactionalUpdater = read(
  'apps', 'desktop', 'src', 'main', 'system', 'transactional-updater.ts',
);
const updateJournal = read(
  'apps', 'desktop', 'src', 'main', 'system', 'update-journal.ts',
);
const watchdog = read('apps', 'desktop', 'resources', 'updater', 'update-watchdog.ps1');
const viteConfig = read('apps', 'desktop', 'electron.vite.config.ts');
const workflow = read('.github', 'workflows', 'real-update-acceptance.yml');

function requireText(source, expected, label) {
  if (!source.includes(expected)) throw new Error(`${label} is missing required contract: ${expected}`);
}

for (const required of [
  'SubutaiRealUpdateSafety-',
  'com.subutai.downloadmanager.real-update-acceptance',
  "acceptanceProductName = 'Subutai Download Manager'",
  "acceptanceInstallDirectoryName = '@subutaidesktop'",
  "electronUpdaterCacheDir = Join-Path $env:LOCALAPPDATA '@subutaidesktop-updater'",
  'Programs\\$acceptanceInstallDirectoryName',
  "-After \"`$installDir = Join-Path `$env:LOCALAPPDATA 'Programs\\@subutaidesktop'\"",
  '$package.build.productName = $acceptanceProductName',
  '$package.build.appId = $acceptanceAppId',
  '$package.build.nsis.shortcutName = $acceptanceProductName',
  '$package.build.nsis.oneClick = $true',
  '$package.build.nsis.allowToChangeInstallationDirectory = $false',
  '-NotePropertyName perMachine -NotePropertyValue $false',
  '-NotePropertyName allowElevation -NotePropertyValue $false',
  "Capture-Directory -Path $userDataDir -Name 'product-user-data'",
  "Capture-Directory -Path $electronUpdaterCacheDir -Name 'electron-updater-cache'",
  "Capture-Directory -Path $updaterRoot -Name 'transactional-updater'",
  "-After \"  `$process = Start-Process -FilePath ([string]`$BaselineBuild.setupPath) -ArgumentList @('/S') -PassThru -Wait\"",
  'Set-AcceptanceAppIdentity',
  'Set-AcceptanceHarnessIdentity',
  'Replace-ExactlyOnce',
  'desktopPackageOriginal',
  'harnessOriginal',
  'Capture-Directory',
  'Restore-DirectoryState',
  'Remove-BrowserRegistration',
  'real-two-installer-acceptance.ps1',
  'pre-existing-state',
]) {
  requireText(wrapper, required, 'Real update runner safety wrapper');
}
if (wrapper.includes('$package | Add-Member -NotePropertyName productName')) {
  throw new Error('Acceptance identity must mutate build.productName, not a shadow top-level package property.');
}
if (wrapper.includes('Subutai Real Update Acceptance.exe')) {
  throw new Error('Real acceptance must retain the production controlled executable filename.');
}

requireText(updateJournal, "'subutai download manager.exe'", 'TypeScript controlled executable validator');
requireText(watchdog, "'Subutai Download Manager.exe'", 'External watchdog controlled executable validator');

for (const required of [
  '${APP_EXECUTABLE_FILENAME}',
  'cache-current-installer.ps1',
  'register-native-host.ps1',
]) {
  requireText(installerInclude, required, 'NSIS installer include');
}
if (installerInclude.includes('$INSTDIR\\Subutai Download Manager.exe')) {
  throw new Error('NSIS browser registration must follow the packaged executable name instead of a hard-coded product filename.');
}

for (const required of [
  "BaselineVersion = '0.1.0'",
  "TargetVersion = '0.2.0'",
  "'Programs\\SubutaiRealUpdateAcceptance'",
  "-ArgumentList @('/S', \"/D=$installDir\")",
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
  'Print bounded acceptance diagnostics',
  "Get-Content -LiteralPath $file.FullName -Tail 400",
  'No real-update diagnostic files were produced.',
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

console.log('Subutai real two-installer updater acceptance policy passed: acceptance-only appId with the production controlled executable identity, one-click per-user non-elevating NSIS install, deterministic sanitized-package install path, dynamic packaged executable browser registration, isolated runner state, real A/B builds, loopback feed, healthy update, forced rollback, checksum rejection, durable user state, browser bridge evidence, bounded console diagnostics and read-only execution are locked.');
