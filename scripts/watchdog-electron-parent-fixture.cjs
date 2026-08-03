const { spawn } = require('node:child_process');
const {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  statSync,
} = require('node:fs');
const { app } = require('electron');

const configPath = process.argv[2];
if (!configPath) throw new Error('Watchdog Electron parent fixture requires a config path.');
const config = JSON.parse(readFileSync(configPath, 'utf8'));

async function waitForStartup(child, path, offset) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const text = readFileSync(path).subarray(Math.min(offset, statSync(path).size)).toString('utf8');
      if (text.includes('watchdog-started')) return;
    }
    if (child.exitCode !== null) {
      throw new Error(`Watchdog bootstrap exited before worker startup with code ${child.exitCode}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Watchdog worker did not start before the Electron parent fixture timeout.');
}

app.whenReady().then(async () => {
  const offset = existsSync(config.launcherLogPath) ? statSync(config.launcherLogPath).size : 0;
  appendFileSync(config.launcherLogPath, `${new Date().toISOString()} launcher-requested electron-parent=${process.pid}\n`);
  const output = openSync(config.childOutputPath, 'a');
  const child = spawn(config.powerShellPath, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', config.watchdogPath,
    '-TransactionPath', config.transactionPath,
    '-ParentProcessId', String(process.pid),
    '-LauncherLogPath', config.launcherLogPath,
    '-WatchdogMutexName', config.mutexName,
    '-PollMilliseconds', '100',
    '-TestMode',
    '-TestAllowedInstallRoot', config.allowedInstallRoot,
    '-TestRollbackMarker', config.rollbackMarker,
  ], {
    windowsHide: true,
    detached: false,
    stdio: ['ignore', output, output],
  });

  try {
    await waitForStartup(child, config.launcherLogPath, offset);
    appendFileSync(config.launcherLogPath, `${new Date().toISOString()} electron-parent-exiting pid=${process.pid}\n`);
    child.unref();
  } finally {
    closeSync(output);
  }
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
