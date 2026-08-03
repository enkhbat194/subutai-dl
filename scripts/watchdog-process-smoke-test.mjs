import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

if (process.platform !== 'win32') throw new Error('Watchdog process smoke test requires Windows.');

const root = process.cwd();
const smokeRoot = mkdtempSync(join(process.env.RUNNER_TEMP?.trim() || tmpdir(), 'subutai-watchdog-process-smoke-'));
const sourceWatchdog = resolve(root, 'apps', 'desktop', 'resources', 'updater', 'update-watchdog.ps1');
const electronParentFixture = resolve(root, 'scripts', 'watchdog-electron-parent-fixture.cjs');

function powerShellExecutablePath() {
  const windowsRoot = process.env.SystemRoot?.trim() || process.env.WINDIR?.trim();
  if (windowsRoot) {
    const candidate = join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (existsSync(candidate)) return candidate;
  }
  return 'powershell.exe';
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function waitForExit(child, timeoutMs, label) {
  return new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${label} hung beyond ${timeoutMs}ms.`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (signal) reject(new Error(`${label} exited by signal ${signal}.`));
      else resolveExit(code);
    });
  });
}

async function waitForLogPhases(path, phases, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (phases.every((phase) => text.includes(phase))) return text;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  throw new Error(`Watchdog process log is missing phases: ${phases.filter((phase) => !text.includes(phase)).join(', ')}\n${text}`);
}

async function runDirectFileErrorSmoke() {
  const fixtureRoot = join(smokeRoot, 'direct-file-error');
  const watchdogPath = join(fixtureRoot, 'watchdog', 'update-watchdog.ps1');
  const transactionPath = join(fixtureRoot, 'update-transaction.json');
  const launcherLogPath = join(fixtureRoot, 'watchdog-launcher.log');
  const childOutputPath = join(fixtureRoot, 'watchdog-child.log');
  const rollbackMarker = join(fixtureRoot, 'rollback-marker.txt');
  mkdirSync(dirname(watchdogPath), { recursive: true });
  copyFileSync(sourceWatchdog, watchdogPath);
  const output = openSync(childOutputPath, 'a');
  let child;
  try {
    child = spawn(powerShellExecutablePath(), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', watchdogPath,
      '-TransactionPath', transactionPath,
      '-ParentProcessId', '0',
      '-LauncherLogPath', launcherLogPath,
      '-WatchdogMutexName', `Local\\SubutaiUpdaterWatchdog-Smoke-${randomUUID()}`,
      '-TestMode',
      '-TestAllowedInstallRoot', fixtureRoot,
      '-TestRollbackMarker', rollbackMarker,
    ], {
      windowsHide: true,
      detached: false,
      stdio: ['ignore', output, output],
    });
    const exitCode = await waitForExit(child, 8_000, 'Direct -File watchdog smoke');
    const log = await waitForLogPhases(launcherLogPath, [
      'watchdog-bootstrap-started',
      'watchdog-started',
      'watchdog-error',
      'watchdog-finished',
      'watchdog-bootstrap-finished',
    ], 2_000);
    if (exitCode !== 2) throw new Error(`Controlled missing-journal watchdog exited ${exitCode} instead of 2.\n${log}`);
  } finally {
    if (child?.exitCode === null) child.kill();
    closeSync(output);
  }
}

async function runElectronParentExitSmoke() {
  const fixtureRoot = join(smokeRoot, 'electron-parent-exit');
  const watchdogPath = join(fixtureRoot, 'watchdog', 'update-watchdog.ps1');
  const transactionPath = join(fixtureRoot, 'update-transaction.json');
  const launcherLogPath = join(fixtureRoot, 'watchdog-launcher.log');
  const childOutputPath = join(fixtureRoot, 'watchdog-child.log');
  const rollbackMarker = join(fixtureRoot, 'rollback-marker.txt');
  const transactionId = randomUUID();
  const previousInstallerPath = join(fixtureRoot, 'packages', '1.0.0', 'Subutai-Setup-1.0.0-rollback.exe');
  const targetInstallerPath = join(fixtureRoot, 'staged', transactionId, 'target-installer.exe');
  const installedExecutablePath = join(fixtureRoot, 'Programs', 'Subutai Download Manager.exe');
  const installedHelperPath = join(dirname(installedExecutablePath), 'resources', 'installed-helper.exe');
  for (const path of [watchdogPath, previousInstallerPath, targetInstallerPath, installedExecutablePath, installedHelperPath]) {
    mkdirSync(dirname(path), { recursive: true });
  }
  copyFileSync(sourceWatchdog, watchdogPath);
  const previousInstaller = Buffer.from('verified-previous-installer');
  const targetInstaller = Buffer.from('target-installer');
  writeFileSync(previousInstallerPath, previousInstaller);
  writeFileSync(targetInstallerPath, targetInstaller);
  writeFileSync(installedExecutablePath, 'installed-new-version');
  copyFileSync(process.execPath, installedHelperPath);
  const installedHelper = spawn(installedHelperPath, ['-e', 'setTimeout(() => {}, 60_000)'], {
    windowsHide: true,
    stdio: 'ignore',
  });
  try {
  const now = Date.now();
  writeFileSync(transactionPath, `${JSON.stringify({
    schemaVersion: 1,
    transactionId,
    currentVersion: '1.0.0',
    targetVersion: '1.1.0',
    previousWorkingVersion: '1.0.0',
    updateState: 'awaiting-health',
    rollbackState: 'ready',
    createdAt: new Date(now - 1_000).toISOString(),
    updatedAt: new Date(now).toISOString(),
    previousInstallerPath,
    previousInstallerSha256: sha256(previousInstaller),
    targetInstallerPath,
    targetInstallerSha256: sha256(targetInstaller),
    watchdogPath,
    watchdogSha256: sha256(readFileSync(watchdogPath)),
    installedExecutablePath,
    startupAttemptCount: 0,
    maxStartupAttempts: 1,
    rollbackAttemptCount: 0,
    healthDeadline: new Date(now + 1_500).toISOString(),
  }, null, 2)}\n`);

  const requireFromDesktop = createRequire(resolve(root, 'apps', 'desktop', 'package.json'));
  const electronExecutable = requireFromDesktop('electron');
  const configPath = join(fixtureRoot, 'electron-parent-config.json');
  writeFileSync(configPath, `${JSON.stringify({
    powerShellPath: powerShellExecutablePath(),
    watchdogPath,
    transactionPath,
    launcherLogPath,
    childOutputPath,
    mutexName: `Local\\SubutaiUpdaterWatchdog-Smoke-${randomUUID()}`,
    allowedInstallRoot: fixtureRoot,
    rollbackMarker,
  }, null, 2)}\n`);

  const electron = spawn(electronExecutable, [electronParentFixture, configPath], {
    cwd: dirname(installedExecutablePath),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  electron.stdout.on('data', (chunk) => { output += chunk; });
  electron.stderr.on('data', (chunk) => { output += chunk; });
  let exitCode;
  try {
    exitCode = await waitForExit(electron, 15_000, 'Electron watchdog parent fixture');
  } catch (error) {
    const log = existsSync(launcherLogPath) ? readFileSync(launcherLogPath, 'utf8') : '';
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output}\n${log}`);
  }
  if (exitCode !== 0) throw new Error(`Electron watchdog parent fixture exited ${exitCode}.\n${output}`);
  const log = await waitForLogPhases(launcherLogPath, [
    'watchdog-bootstrap-started',
    'watchdog-started',
    'electron-parent-exiting',
    'parent-exited',
    'previous-installer-sha256-verified',
    'target-process-stop',
    'target-process-tree-closed',
    'rollback-journal-written',
    'watchdog-completed outcome=rolled-back',
    'watchdog-finished',
  ], 10_000);
  const expectedWorkerDirectory = `workingDirectory=${fixtureRoot}`.toLowerCase();
  const workerStart = log.split(/\r?\n/u).find((line) => line.includes('watchdog-started'))?.toLowerCase() ?? '';
  if (!workerStart.includes(expectedWorkerDirectory)) {
    throw new Error(`Watchdog worker inherited the installed application directory instead of relocating to updater state.\n${log}`);
  }
  if (!existsSync(rollbackMarker)) throw new Error(`Watchdog worker did not survive Electron exit to perform rollback.\n${log}`);
  const helperExitDeadline = Date.now() + 2_000;
  while (installedHelper.exitCode === null && Date.now() < helperExitDeadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  if (installedHelper.exitCode === null) {
    installedHelper.kill();
    throw new Error(`Watchdog worker did not close an installed helper process before rollback.\n${log}`);
  }
  const journal = JSON.parse(readFileSync(transactionPath, 'utf8'));
  if (journal.updateState !== 'rolled-back' || journal.rollbackState !== 'succeeded') {
    throw new Error(`Watchdog worker left the transaction incomplete after Electron exit.\n${JSON.stringify(journal, null, 2)}`);
  }
  } finally {
    if (installedHelper.exitCode === null) installedHelper.kill();
  }
}

try {
  await runDirectFileErrorSmoke();
  await runElectronParentExitSmoke();
  console.log('Subutai watchdog process smoke test passed: direct PowerShell -File startup is acknowledged and the script-owned worker survives a real Electron parent exit through verified rollback completion.');
} finally {
  rmSync(smokeRoot, { recursive: true, force: true });
}
