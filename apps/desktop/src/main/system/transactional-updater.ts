import { app } from 'electron';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import electronUpdater from 'electron-updater';
import {
  armUpdateTransaction,
  launchUpdateWatchdog,
  prepareUpdateTransaction,
} from './update-transaction';

const { autoUpdater } = electronUpdater;
let installed = false;
let downloadedInstallerPath = '';
let downloadedVersion = '';

function watchdogSourcePath(): string {
  const candidates = [
    app.isPackaged ? join(process.resourcesPath, 'updater', 'update-watchdog.ps1') : '',
    resolve(process.cwd(), 'resources', 'updater', 'update-watchdog.ps1'),
    resolve(app.getAppPath(), 'resources', 'updater', 'update-watchdog.ps1'),
  ].filter(Boolean);
  const resolved = candidates.find((candidate) => existsSync(candidate));
  if (!resolved) throw new Error('Transactional updater watchdog resource is missing.');
  return resolved;
}

function emitUpdaterError(error: unknown): void {
  const normalized = error instanceof Error ? error : new Error(String(error));
  autoUpdater.emit('error', normalized);
}

export function installTransactionalUpdaterGuard(): void {
  if (installed) return;
  installed = true;

  const originalQuitAndInstall = autoUpdater.quitAndInstall.bind(autoUpdater);
  autoUpdater.autoInstallOnAppQuit = false;
  app.prependListener('before-quit', () => {
    // A downloaded update must never install merely because the user closed the app.
    // Installation is allowed only through the journaled quitAndInstall wrapper below.
    autoUpdater.autoInstallOnAppQuit = false;
  });

  autoUpdater.on('update-downloaded', (info) => {
    const event = info as typeof info & { downloadedFile?: string };
    downloadedInstallerPath = event.downloadedFile?.trim() ?? '';
    downloadedVersion = info.version;
  });

  autoUpdater.quitAndInstall = ((isSilent?: boolean, isForceRunAfter?: boolean): void => {
    void (async () => {
      if (process.platform !== 'win32' || !app.isPackaged) {
        throw new Error('Transactional update installation requires packaged Windows Setup mode.');
      }
      if (process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR) {
        throw new Error('Portable mode does not support installed-app rollback.');
      }
      if (!downloadedInstallerPath || !downloadedVersion) {
        throw new Error('Downloaded update installer evidence is unavailable; installation was blocked.');
      }

      await prepareUpdateTransaction({
        currentVersion: app.getVersion(),
        targetVersion: downloadedVersion,
        downloadedInstallerPath,
        installedExecutablePath: process.execPath,
        watchdogSourcePath: watchdogSourcePath(),
      });
      const armed = await armUpdateTransaction();
      await launchUpdateWatchdog(armed);
      originalQuitAndInstall(isSilent ?? false, isForceRunAfter ?? true);
    })().catch(emitUpdaterError);
  }) as typeof autoUpdater.quitAndInstall;
}
