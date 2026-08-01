import { app, BrowserWindow } from 'electron';
import { isNativeMessagingInvocation, runNativeMessagingHost } from './browser/native-messaging';

if (isNativeMessagingInvocation(process.argv)) {
  void runNativeMessagingHost().finally(() => app.exit(process.exitCode ?? 0));
} else {
  const hasSingleInstanceLock = app.requestSingleInstanceLock();
  if (!hasSingleInstanceLock) {
    app.quit();
  } else {
    void import('./subutai-runtime').then(({ enqueueBrowserArguments }) => {
      app.on('second-instance', (_event, argv) => {
        void enqueueBrowserArguments(argv);
        const window = BrowserWindow.getAllWindows()[0];
        if (window) {
          if (window.isMinimized()) window.restore();
          window.show();
          window.focus();
        }
      });
    });
  }
}
