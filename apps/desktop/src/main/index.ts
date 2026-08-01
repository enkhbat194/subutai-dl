import { app, BrowserWindow } from 'electron';
import { appendFileSync } from 'node:fs';
import { isNativeMessagingInvocation, runNativeMessagingHost } from './browser/native-messaging';
import { ensureNativeMessagingRegistered } from './browser/registration';

const isLaunchSmokeTest = process.argv.includes('--subutai-smoke-test');
const smokeLogPath = process.env.SUBUTAI_SMOKE_LOG?.trim() ?? '';

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
  await ensureNativeMessagingRegistered().catch((error: unknown) => {
    writeSmokeLog(`Native messaging registration warning: ${formatError(error)}`);
  });
  await loadDesktopRuntimes();
}

process.on('uncaughtException', (error: Error) => {
  writeSmokeLog(`Uncaught exception: ${formatError(error)}`);
});
process.on('unhandledRejection', (reason: unknown) => {
  writeSmokeLog(`Unhandled rejection: ${formatError(reason)}`);
});

if (isNativeMessagingInvocation(process.argv)) {
  void runNativeMessagingHost().finally(() => app.exit(Number(process.exitCode ?? 0)));
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
