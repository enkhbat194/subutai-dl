import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');
const wrapper = read('scripts', 'run-real-update-acceptance-safely.ps1');
const monitor = read('scripts', 'run-real-update-acceptance-monitored.ps1');
const harness = read('scripts', 'real-two-installer-acceptance.ps1');
const stateProbe = read('scripts', 'real-update-state-probe.mjs');
const feedServer = read('scripts', 'real-update-feed-server.mjs');
const watchdogSmoke = read('scripts', 'watchdog-process-smoke-test.mjs');
const watchdogElectronParent = read('scripts', 'watchdog-electron-parent-fixture.cjs');
const installerInclude = read('apps', 'desktop', 'build', 'installer.nsh');
const acceptanceRuntime = read(
  'apps', 'desktop', 'src', 'main', 'system', 'real-update-acceptance.ts',
);
const desktopMain = read('apps', 'desktop', 'src', 'main', 'index.ts');
const transactionalUpdater = read(
  'apps', 'desktop', 'src', 'main', 'system', 'transactional-updater.ts',
);
const updateTransaction = read(
  'apps', 'desktop', 'src', 'main', 'system', 'update-transaction.ts',
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

for (const required of [
  'run-real-update-acceptance-safely.ps1',
  "ScenarioTimeoutSeconds = 240",
  "evidence\\live-updater-state",
  "update-transaction.json",
  "watchdog-evidence.json",
  "watchdog-launcher.log",
  "watchdog-child.log",
  "real-two-installer-acceptance.json",
  "@subutaidesktop-updater",
  'Get-CimInstance Win32_Process',
  'Capture-LiveState',
  'Start-Sleep -Milliseconds 250',
  '$process.WaitForExit()',
  '$process.Refresh()',
  "'-MonitorExitCodePath', $exitCodePath",
  '$reportedExitCode',
  'child exit codes disagreed',
  'child wrote an invalid completion code',
  'if ($null -eq $exitCode)',
  'Monitored real update acceptance child failed with exit code',
  'installedVersion',
  'updaterFiles',
]) {
  requireText(monitor, required, 'Real update live-state monitor');
}
for (const required of [
  "[string]$MonitorExitCodePath = ''",
  'function Write-MonitorExitCode',
  'Monitor exit-code path must remain inside RUNNER_TEMP.',
  'Write-MonitorExitCode -ExitCode 0',
  'Write-MonitorExitCode -ExitCode 1',
]) {
  requireText(wrapper, required, 'Real update safety wrapper completion signal');
}
if (monitor.includes('if ($process.ExitCode -ne 0) { exit $process.ExitCode }')) {
  throw new Error('The monitor must not convert an unavailable child exit code into a successful shell exit.');
}

for (const required of [
  'WATCHDOG_STARTUP_TIMEOUT_MS = 5_000',
  'function powerShellExecutablePath()',
  'waitForWatchdogStartup',
  "join(rootPath, 'watchdog-launcher.log')",
  "'-File',",
  'journal.watchdogPath',
  "'-TransactionPath',",
  'updateJournalPath(rootPath)',
  "'-ParentProcessId',",
  'String(parentProcessId)',
  "'-LauncherLogPath',",
  "join(rootPath, 'watchdog-child.log')",
  'detached: false',
  'cwd: rootPath',
  "stdio: ['ignore', childOutputFile, childOutputFile]",
  'launcher-requested',
  'watchdog-started',
  'watchdog-start-acknowledged',
  'watchdog-start-failed',
  "spawned.once('error', reject)",
  "spawned.once('spawn'",
  'child.kill()',
  'child.unref()',
]) {
  requireText(updateTransaction, required, 'Transactional watchdog launcher');
}
const startupTimeout = /WATCHDOG_STARTUP_TIMEOUT_MS\s*=\s*([\d_]+)/u.exec(updateTransaction);
if (!startupTimeout || Number(startupTimeout[1].replaceAll('_', '')) > 10_000) {
  throw new Error('Watchdog startup acknowledgement must fail within 10 seconds.');
}
for (const forbidden of ['-Command', '-EncodedCommand', 'shell: true', 'detached: true', "stdio: 'ignore'", 'quotePowerShellLiteral']) {
  if (updateTransaction.includes(forbidden)) {
    throw new Error(`Transactional watchdog launcher contains forbidden inline-shell behavior: ${forbidden}`);
  }
}

for (const required of [
  "'Local\\SubutaiUpdaterWatchdog'",
  '[System.Threading.Mutex]::new',
  'watchdog-bootstrap-started',
  'watchdog-worker-created',
  '-WorkingDirectory $root',
  'watchdog-bootstrap-finished',
  'watchdog-started',
  'workingDirectory=',
  'mutex-created',
  'transaction-loaded',
  'parent-wait-started',
  'health-deadline-wait',
  'rollback-triggered',
  'previous-installer-path-validated',
  'previous-installer-sha256-verified',
  'target-install-wait',
  'target-install-ready',
  'Target Subutai installation did not become ready within 120 seconds.',
  "'installed-version.txt'",
  'target-process-stop',
  'target-process-tree-closed',
  'Test-PathInside $Directory $processPath',
  'Wait-InstallTreeUnlocked',
  '[System.IO.FileShare]::None',
  'target-file-locked',
  'target-files-unlocked',
  'target-process-closed',
  'rollback-installer-started',
  "@('/S', '--updated')",
  'rollback-installer-exit',
  'browser-registration-restored',
  'rollback-journal-written',
  'baseline-restarted',
  'watchdog-completed',
  'watchdog-error',
  'watchdog-finished',
]) {
  requireText(watchdog, required, 'Script-owned watchdog lifecycle');
}

for (const required of [
  "'-File',",
  'update-watchdog.ps1',
  "'-TransactionPath',",
  "'-LauncherLogPath',",
  "'-WatchdogMutexName',",
  'windowsHide: true',
  'detached: false',
  "stdio: ['ignore', output, output]",
  'watchdog-started',
  'watchdog-error',
  'watchdog-finished',
  'watchdog-electron-parent-fixture.cjs',
  'createRequire',
  'electron-parent-exiting',
  'parent-exited',
  'rollback-journal-written',
  'child.kill()',
  'rmSync(smokeRoot',
]) {
  requireText(watchdogSmoke, required, 'Watchdog process smoke test');
}

for (const required of [
  "require('electron')",
  "'-File'",
  'watchdogPath',
  'detached: false',
  "stdio: ['ignore', output, output]",
  'waitForStartup',
  'electron-parent-exiting',
  'app.exit(0)',
]) {
  requireText(watchdogElectronParent, required, 'Watchdog Electron parent-exit fixture');
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
  'Install pinned Electron watchdog smoke runtime',
  'node apps/desktop/node_modules/electron/install.js',
  'Run watchdog process smoke test',
  'pnpm test:watchdog-process-smoke',
  'scripts/watchdog-electron-parent-fixture.cjs',
  './scripts/run-real-update-acceptance-monitored.ps1',
  '-ScenarioTimeoutSeconds 240',
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

console.log('Subutai real two-installer updater acceptance policy passed: acceptance-only appId with the production controlled executable identity, one-click per-user non-elevating NSIS install, deterministic sanitized-package install path, dynamic packaged executable browser registration, isolated runner state, direct -File watchdog launch with fail-fast acknowledgement and a pre-build process smoke gate, live transaction/watchdog snapshots with strict failure propagation, real A/B builds, loopback feed, healthy update, forced rollback, checksum rejection, durable user state, browser bridge evidence, bounded console diagnostics and read-only execution are locked.');
