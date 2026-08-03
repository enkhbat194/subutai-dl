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
  '[System.Threading.Mutex]::new',
  '$mutex = $null',
  'if ($null -ne $mutex)',
  'try { $mutex.ReleaseMutex() } catch {}',
  "join(rootPath, 'watchdog-launcher.log')",
  "Buffer.from(singleInstanceCommand, 'utf16le')",
  "'-EncodedCommand', encodedCommand",
  "stdio: ['ignore', launcherLogFile, launcherLogFile]",
  'launcher-requested',
  'launcher-started',
]) requireText(transaction, required, 'Transactional updater journal');
if (!/const mutexScope = 'Local\\\\SubutaiUpdaterWatchdog';/u.test(transaction)) {
  throw new Error('Watchdog launcher must use the Local\\SubutaiUpdaterWatchdog mutex namespace with a correctly escaped TypeScript source literal.');
}
if (transaction.includes('New-Object System.Threading.Mutex(')) {
  throw new Error('Watchdog launcher must use the typed Mutex constructor so constructor failures are caught and logged.');
}
if (transaction.includes("'-Command', singleInstanceCommand") || transaction.includes("stdio: 'ignore'")) {
  throw new Error('Watchdog launcher must use an encoded PowerShell command and preserve child stdout/stderr diagnostics.');
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

console.log('Subutai updater rollback policy passed: durable journal, verified cache, startup health, encoded and durably logged external watchdog launcher, bounded rollback and read-only Windows gates.');
