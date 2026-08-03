import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const transaction = ['update-journal.ts', 'update-staging.ts', 'update-transaction.ts']
  .map((name) => readFileSync(join(root, 'apps', 'desktop', 'src', 'main', 'system', name), 'utf8'))
  .join('\n');
const updater = readFileSync(join(root, 'apps', 'desktop', 'src', 'main', 'system', 'transactional-updater.ts'), 'utf8');
const health = readFileSync(join(root, 'apps', 'desktop', 'src', 'main', 'system', 'update-health.ts'), 'utf8');
const main = readFileSync(join(root, 'apps', 'desktop', 'src', 'main', 'index.ts'), 'utf8');
const cacheScript = readFileSync(join(root, 'apps', 'desktop', 'resources', 'updater', 'cache-current-installer.ps1'), 'utf8');
const watchdog = readFileSync(join(root, 'apps', 'desktop', 'resources', 'updater', 'update-watchdog.ps1'), 'utf8');
const installer = readFileSync(join(root, 'apps', 'desktop', 'build', 'installer.nsh'), 'utf8');
const desktopPackage = readFileSync(join(root, 'apps', 'desktop', 'package.json'), 'utf8');
const packageJson = readFileSync(join(root, 'package.json'), 'utf8');
const nativeWorkflow = readFileSync(join(root, '.github', 'workflows', 'native-engine.yml'), 'utf8');
const n5Workflow = readFileSync(join(root, '.github', 'workflows', 'n5-production-acceptance.yml'), 'utf8');
const releaseWorkflow = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8');
const twoBuildAcceptance = readFileSync(join(root, 'scripts', 'updater-two-build-acceptance.mjs'), 'utf8');

function requireText(source, expected, label) {
  if (!source.includes(expected)) throw new Error(`${label} is missing required contract: ${expected}`);
}

for (const required of [
  'UPDATE_JOURNAL_SCHEMA_VERSION',
  'atomicWriteText',
  'update-transaction.json',
  'previousInstallerSha256',
  'targetInstallerSha256',
  'watchdogSha256',
  'startupAttemptCount',
  'maxStartupAttempts',
  'rollbackAttemptCount',
  'intentionalExitAt',
  'assertSupportedInstalledExecutable',
  'Cached rollback installer checksum mismatch',
  'Staged update installer checksum mismatch',
  'redactUpdateError',
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
  "stdio: ['ignore', childOutputFile, childOutputFile]",
  'launcher-requested',
  'watchdog-started',
  'watchdog-start-acknowledged',
  'watchdog-start-failed',
  'child.kill()',
  'child.unref()',
]) requireText(transaction, required, 'Transactional updater journal');
const startupTimeout = /WATCHDOG_STARTUP_TIMEOUT_MS\s*=\s*([\d_]+)/u.exec(transaction);
if (!startupTimeout || Number(startupTimeout[1].replaceAll('_', '')) > 10_000) {
  throw new Error('Watchdog startup acknowledgement must fail within 10 seconds.');
}
for (const forbidden of ['-Command', '-EncodedCommand', 'shell: true', 'detached: true', "stdio: 'ignore'", 'quotePowerShellLiteral']) {
  if (transaction.includes(forbidden)) {
    throw new Error(`Watchdog launcher contains forbidden inline-shell behavior: ${forbidden}`);
  }
}

for (const required of [
  'autoUpdater.autoInstallOnAppQuit = false',
  "process.env.PORTABLE_EXECUTABLE_FILE",
  'prepareUpdateTransaction',
  'armUpdateTransaction',
  'launchUpdateWatchdog',
  'originalQuitAndInstall',
  'Downloaded update installer evidence is unavailable',
  'Downloaded update installer changed after staging',
  "autoUpdater.on('update-downloaded'",
]) requireText(updater, required, 'Transactional updater guard');
if (updater.indexOf('prepareUpdateTransaction') > updater.indexOf('originalQuitAndInstall(isSilent')) {
  throw new Error('Update installation must be journaled before quitAndInstall executes.');
}

for (const required of [
  'PRAGMA quick_check(1)',
  "downloads', 'app_state', 'schedules",
  'subutai-engine-host.exe',
  'preload/index.cjs',
  'waitForRendererHealth',
]) requireText(health, required, 'Updated-version startup health');

for (const required of [
  'installTransactionalUpdaterGuard',
  'beginStartupHealthAttempt',
  'verifyUpdatedDesktopHealth',
  'confirmUpdateHealth',
  'recordStartupHealthFailure',
  'recordIntentionalExitSync',
  'healthFailureExit = true',
  'launchUpdateWatchdog(startupTransaction, 0)',
]) requireText(main, required, 'Desktop startup transaction integration');

for (const required of [
  'Get-FileHash',
  'Rollback package copy checksum mismatch',
  'package.json',
  'RetentionCount = 4',
  'Move-Item -LiteralPath $temporary',
  'OrdinalIgnoreCase.Equals($source, $destination)',
]) requireText(cacheScript, required, 'Previous-version installer cache');

for (const required of [
  'Test-PathInside',
  'Get-AllowedInstallRoots',
  'Get-JournalProperty',
  'Set-JournalProperty',
  'Previous installer checksum mismatch',
  "@('/S', '--updated')",
  'rollbackAttemptCount',
  'intentional-exit-no-rollback',
  'Test-BrowserRegistration',
  'corrupt-journal-no-action',
  'failed-safe',
  'Start-Process -FilePath $installedExecutable',
  "'Local\\SubutaiUpdaterWatchdog'",
  '[System.Threading.Mutex]::new',
  '$mutex = $null',
  'if ($null -ne $mutex)',
  '$mutex.ReleaseMutex()',
  'watchdog-started',
  'mutex-created',
  'transaction-loaded',
  'parent-wait-started',
  'health-deadline-wait',
  'rollback-triggered',
  'previous-installer-path-validated',
  'previous-installer-sha256-verified',
  'target-process-closed',
  'rollback-installer-started',
  'rollback-installer-exit',
  'browser-registration-restored',
  'rollback-journal-written',
  'baseline-restarted',
  'watchdog-completed',
  'watchdog-error',
  'watchdog-finished',
]) requireText(watchdog, required, 'External rollback watchdog');
if (/Restart-Computer|shutdown\.exe|SetSuspendState|rundll32.+powrprof/iu.test(watchdog)) {
  throw new Error('Updater watchdog must never restart, shut down, sleep or hibernate Windows.');
}

for (const required of [
  'fixture-old-installer.rs',
  'fixture-new-app.rs',
  "run('rustc'",
  'runProductionWatchdog',
  'SUBUTAI_FIXTURE_INSTALL_ROOT',
  'installed-version.txt',
  'startup-health-confirmed.txt',
  'rollbackAttemptCount',
  'NativeMessagingHosts',
  'Registry]::CurrentUser.DeleteSubKeyTree',
  'Registry]::CurrentUser.CreateSubKey',
  'RegistryValueKind]::String',
  '$entries = Get-Content -LiteralPath $InputPath -Raw | ConvertFrom-Json',
]) requireText(twoBuildAcceptance, required, 'Local two-build updater acceptance');

for (const required of [
  'cache-current-installer.ps1',
  '$EXEPATH',
  '${VERSION}',
  'register-native-host.ps1',
  'Abort "Subutai rollback package cache failed',
]) requireText(installer, required, 'NSIS transactional installation hook');
requireText(desktopPackage, '"from": "resources/updater"', 'Desktop package updater resources');
requireText(packageJson, '"test:updater-policy"', 'Root updater policy command');
requireText(packageJson, '"test:updater-acceptance"', 'Root updater acceptance command');
requireText(packageJson, 'updater-two-build-acceptance.mjs', 'Root local two-build acceptance command');

requireText(packageJson, 'scripts/system-policy-test.mts && pnpm test:updater-policy && pnpm test:updater-acceptance', 'Native workflow updater gate chain');
requireText(packageJson, 'production-acceptance-policy-test.mjs && pnpm test:updater-policy && pnpm test:updater-acceptance', 'N5/release updater gate chain');
requireText(nativeWorkflow, 'pnpm test:system', 'Native workflow system gate');
requireText(n5Workflow, 'pnpm test:production-acceptance', 'N5 workflow production gate');
requireText(releaseWorkflow, 'pnpm test:production-acceptance', 'Release workflow production gate');
requireText(nativeWorkflow, 'contents: read', 'Native workflow read-only permission');
requireText(n5Workflow, 'contents: read', 'N5 workflow read-only permission');
if (nativeWorkflow.includes('contents: write') || n5Workflow.includes('contents: write')) {
  throw new Error('Final updater validation workflows must remain check-only.');
}

console.log('Subutai updater rollback policy passed: durable journal, verified cache, startup health, direct -File watchdog launch with bounded acknowledgement, script-owned mutex/log phases, bounded rollback and read-only Windows gates.');
