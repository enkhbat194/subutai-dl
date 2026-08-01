import { app, BrowserWindow } from 'electron';
import { isNativeMessagingInvocation, runNativeMessagingHost } from './browser/native-messaging';
import { ensureNativeMessagingRegistered } from './browser/registration';

const isLaunchSmokeTest = process.argv.includes('--subutai-smoke-test');

async function loadDesktopRuntimes(): Promise<void> {
  const { enqueueBrowserArguments } = await import('./subutai-runtime');
  await Promise.all([
    import('./batch/batch-runtime'),
    import('./resilience/resilience-runtime'),
    import('./tools/utility-runtime'),
    import('./system/system-runtime'),
  ]);

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
    setTimeout(() => app.quit(), 3_000).unref();
  }
}

if (isNativeMessagingInvocation(process.argv)) {
  void runNativeMessagingHost().finally(() => app.exit(Number(process.exitCode ?? 0)));
} else {
  const hasSingleInstanceLock = app.requestSingleInstanceLock();
  if (!hasSingleInstanceLock) {
    app.quit();
  } else {
    void app.whenReady().then(() => ensureNativeMessagingRegistered()).catch(() => undefined);
    void loadDesktopRuntimes().catch((error: unknown) => {
      console.error('Subutai desktop runtime failed to start.', error);
      app.exit(1);
    });
  }
}
