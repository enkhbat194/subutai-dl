import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (process.platform !== 'win32') throw new Error('Watchdog process smoke test requires Windows.');

const root = process.cwd();
const smokeRoot = mkdtempSync(join(process.env.RUNNER_TEMP?.trim() || tmpdir(), 'subutai-watchdog-process-smoke-'));
const sourceWatchdog = resolve(root, 'apps', 'desktop', 'resources', 'updater', 'update-watchdog.ps1');
const stagedWatchdog = join(smokeRoot, 'watchdog', 'update-watchdog.ps1');
const transactionPath = join(smokeRoot, 'update-transaction.json');
const launcherLogPath = join(smokeRoot, 'watchdog-launcher.log');
const childOutputPath = join(smokeRoot, 'watchdog-child.log');
const rollbackMarker = join(smokeRoot, 'rollback-marker.txt');
const mutexName = `Local\\SubutaiUpdaterWatchdog-Smoke-${randomUUID()}`;

function powerShellExecutablePath() {
  const windowsRoot = process.env.SystemRoot?.trim() || process.env.WINDIR?.trim();
  if (windowsRoot) {
    const candidate = join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (existsSync(candidate)) return candidate;
  }
  return 'powershell.exe';
}

mkdirSync(join(smokeRoot, 'watchdog'), { recursive: true });
copyFileSync(sourceWatchdog, stagedWatchdog);
const logFile = openSync(childOutputPath, 'a');
const startupOffset = existsSync(launcherLogPath) ? statSync(launcherLogPath).size : 0;
let child;
try {
  child = spawn(powerShellExecutablePath(), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    stagedWatchdog,
    '-TransactionPath',
    transactionPath,
    '-ParentProcessId',
    '0',
    '-LauncherLogPath',
    launcherLogPath,
    '-WatchdogMutexName',
    mutexName,
    '-TestMode',
    '-TestAllowedInstallRoot',
    smokeRoot,
    '-TestRollbackMarker',
    rollbackMarker,
  ], {
    windowsHide: true,
    detached: false,
    stdio: ['ignore', logFile, logFile],
  });

  const exitCode = await new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Watchdog process smoke test hung beyond 8 seconds.'));
    }, 8_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (signal) reject(new Error(`Watchdog process smoke test exited by signal ${signal}.`));
      else resolveExit(code);
    });
  });

  if (!existsSync(launcherLogPath)) {
    const childOutput = existsSync(childOutputPath) ? readFileSync(childOutputPath, 'utf8') : '';
    throw new Error(`Watchdog process did not create its startup log.\n${childOutput}`);
  }
  const log = readFileSync(launcherLogPath).subarray(startupOffset).toString('utf8');
  for (const phase of ['watchdog-started', 'watchdog-error', 'watchdog-finished']) {
    if (!log.includes(phase)) throw new Error(`Watchdog process log is missing phase: ${phase}\n${log}`);
  }
  if (exitCode !== 2) throw new Error(`Controlled missing-journal watchdog exited ${exitCode} instead of 2.\n${log}`);
  console.log('Subutai watchdog process smoke test passed: Node spawn direct -File launch produced startup, controlled error and finished phases without an orphan process.');
} finally {
  if (child?.exitCode === null) child.kill();
  closeSync(logFile);
  rmSync(smokeRoot, { recursive: true, force: true });
}
