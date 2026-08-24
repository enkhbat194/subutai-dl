import { app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { isNativeMessagingInvocation, runNativeMessagingHost } from './browser/native-messaging';
import { ensureNativeMessagingRegistered } from './browser/registration';
import {
  initializeRealUpdateAcceptance,
  realUpdateAcceptanceTransactionOptions,
  recordHealthyRealUpdateAcceptance,
  recordRolledBackRealUpdateAcceptance,
  shouldFailRealUpdateAcceptanceHealth,
  startRealUpdateAcceptanceDriver,
} from './system/real-update-acceptance';
import { verifyUpdatedDesktopHealth } from './system/update-health';
import { installTransactionalUpdaterGuard } from './system/transactional-updater';
import {
  beginStartupHealthAttempt,
  confirmUpdateHealth,
  launchUpdateWatchdog,
  recordIntentionalExitSync,
  recordStartupHealthFailure,
} from './system/update-transaction';

const isLaunchSmokeTest = process.argv.includes('--subutai-smoke-test');
const isOwnerYouTubeAcceptance = process.argv.includes('--subutai-owner-youtube-acceptance');
const smokeLogPath = process.env.SUBUTAI_SMOKE_LOG?.trim() ?? '';
let healthFailureExit = false;

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

function writeSmokeLog(message: string): void {
  if (!smokeLogPath) return;
  try {
    appendFileSync(smokeLogPath, `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch {
    // A diagnostic log must never prevent the app from starting.
  }
}

function configurePackagedMediaEnvironment(): void {
  const providerHome = join(process.resourcesPath, 'engines', 'pot-provider', 'server');
  const providerScript = join(providerHome, 'build', 'generate_once.js');
  if (existsSync(providerScript)) {
    process.env.SUBUTAI_POT_SERVER_HOME = providerHome;
    writeSmokeLog('Packaged YouTube token provider runtime configured.');
  }
}

function runPowerShellAcceptance(scriptPath: string, appRoot: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-AppRoot',
        appRoot,
      ],
      {
        stdio: 'inherit',
        windowsHide: false,
        env: process.env,
      },
    );
    child.once('error', reject);
    child.once('exit', (code) => resolve(Number(code ?? 1)));
  });
}

async function runPackagedOwnerYouTubeAcceptance(): Promise<void> {
  await app.whenReady();
  configurePackagedMediaEnvironment();

  const appRoot = join(process.resourcesPath, '..');
  const acceptanceRoot = join(process.resourcesPath, 'owner-acceptance');
  const primaryScript = join(acceptanceRoot, 'owner-youtube-acceptance.ps1');
  const retryScript = join(acceptanceRoot, 'owner-youtube-fresh-url-retry.ps1');

  if (!existsSync(primaryScript)) {
    throw new Error(`Packaged owner YouTube acceptance script is missing: ${primaryScript}`);
  }

  let exitCode = await runPowerShellAcceptance(primaryScript, appRoot);
  if (exitCode !== 0 && existsSync(retryScript)) {
    console.log('Primary owner YouTube acceptance did not pass. Trying bounded fresh-media-URL retry routes.');
    exitCode = await runPowerShellAcceptance(retryScript, appRoot);
  }

  if (exitCode === 0) {
    console.log('SUBUTAI_YOUTUBE_OWNER_ACCEPTANCE=PASS');
  } else {
    console.error(`Subutai owner-network YouTube acceptance did not pass (exit ${exitCode}).`);
  }
  app.exit(exitCode);
}

async function loadDesktopRuntimes(): Promise<void> {
  writeSmokeLog('Loading desktop runtimes.');
  const { enqueueBrowserArguments } = await import('./subutai-runtime');
  await Promise.all([
    import('./batch/batch-runtime'),
    import('./resilience/resilience-runtime'),
    import('./tools/utility-runtime'),
    import('./system/system-runtime'),
  ]);
  writeSmokeLog('Desktop runtimes loaded.');

  app.on('second-instance', (_event, argv) => {
    void enqueueBrowserArguments(argv);
    const window = BrowserWindow.getAllWindows()[0];
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
  });

  if (isLaunchSmokeTest) {
    writeSmokeLog('Launch smoke timer armed.');
    setTimeout(() => {
      writeSmokeLog('Launch smoke completed successfully.');
      app.exit(0);
    }, 5_000).unref();
  }
}

async function startDesktop(): Promise<void> {
  await app.whenReady();
  writeSmokeLog('Electron app is ready.');
  configurePackagedMediaEnvironment();
  initializeRealUpdateAcceptance();
  installTransactionalUpdaterGuard();

  let startupTransaction = null;
  try {
    startupTransaction = await beginStartupHealthAttempt(
      app.getVersion(),
      realUpdateAcceptanceTransactionOptions(),
    );
    if (startupTransaction) {
      writeSmokeLog(`Update health attempt ${startupTransaction.startupAttemptCount}/${startupTransaction.maxStartupAttempts}.`);
      await launchUpdateWatchdog(startupTransaction, 0);
    }
  } catch (error) {
    writeSmokeLog(`Update transaction warning: ${formatError(error)}`);
  }

  let nativeMessagingRegistered = true;
  try {
    await ensureNativeMessagingRegistered();
  } catch (error) {
    nativeMessagingRegistered = false;
    writeSmokeLog(`Native messaging registration warning: ${formatError(error)}`);
  }

  await loadDesktopRuntimes();
  startRealUpdateAcceptanceDriver();

  if (startupTransaction) {
    try {
      if (shouldFailRealUpdateAcceptanceHealth()) {
        throw new Error('Real two-installer acceptance forced the target startup health failure.');
      }
      await verifyUpdatedDesktopHealth(nativeMessagingRegistered);
      await confirmUpdateHealth(app.getVersion());
      await recordHealthyRealUpdateAcceptance();
      writeSmokeLog('Update startup health confirmed and transaction committed.');
    } catch (error) {
      await recordStartupHealthFailure(app.getVersion(), error).catch(() => undefined);
      healthFailureExit = true;
      writeSmokeLog(`Updated version failed startup health: ${formatError(error)}`);
      app.exit(70);
    }
  } else {
    await recordRolledBackRealUpdateAcceptance();
  }
}

process.on('uncaughtException', (error: Error) => {
  writeSmokeLog(`Uncaught exception: ${formatError(error)}`);
});
process.on('unhandledRejection', (reason: unknown) => {
  writeSmokeLog(`Unhandled rejection: ${formatError(reason)}`);
});

app.on('before-quit', () => {
  if (!healthFailureExit) {
    try { recordIntentionalExitSync(app.getVersion()); } catch { /* shutdown must continue */ }
  }
});

if (isNativeMessagingInvocation(process.argv)) {
  void runNativeMessagingHost().finally(() => app.exit(Number(process.exitCode ?? 0)));
} else if (isOwnerYouTubeAcceptance) {
  void runPackagedOwnerYouTubeAcceptance().catch((error: unknown) => {
    console.error('Packaged owner YouTube acceptance failed to start.', error);
    app.exit(2);
  });
} else {
  const hasSingleInstanceLock = app.requestSingleInstanceLock();
  if (!hasSingleInstanceLock) {
    writeSmokeLog('Single-instance lock was not acquired.');
    app.quit();
  } else {
    void startDesktop().catch((error: unknown) => {
      const details = formatError(error);
      writeSmokeLog(`Subutai desktop runtime failed to start: ${details}`);
      console.error('Subutai desktop runtime failed to start.', error);
      app.exit(1);
    });
  }
}
