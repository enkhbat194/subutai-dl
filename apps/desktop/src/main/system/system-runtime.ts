import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  Tray,
} from 'electron';
import type { EventEmitter } from 'node:events';
import { join } from 'node:path';
import type {
  DownloadJob,
  SystemSettings,
  SystemSettingsUpdate,
  SystemState,
  UpdateState,
} from '@subutai/shared';
import electronUpdater from 'electron-updater';
import { JobStore } from '../storage/job-store';
import {
  DEFAULT_SYSTEM_SETTINGS,
  downloadCountSummary,
  downloadNotificationTransitions,
  normalizeSystemSettings,
} from './system-policy';
import { toSanitizedUpdateFailure } from './update-error';

const { autoUpdater } = electronUpdater;
const SETTINGS_KEY = 'system-settings';
const attachedWindows = new WeakSet<BrowserWindow>();
let store: JobStore | null = null;
let tray: Tray | null = null;
let timer: NodeJS.Timeout | null = null;
let isQuitting = false;
let settings: SystemSettings = { ...DEFAULT_SYSTEM_SETTINGS };
let previousJobs = new Map<string, DownloadJob>();
let update: UpdateState = {
  status: 'idle',
  currentVersion: app.getVersion(),
};

type ClearableUpdateField = 'error' | 'availableVersion' | 'progressPercent' | 'bytesPerSecond';

function state(): SystemState {
  return {
    settings: { ...settings },
    update: { ...update },
    notificationsSupported: Notification.isSupported(),
    trayAvailable: tray !== null,
    packaged: app.isPackaged,
  };
}

function broadcast(): void {
  const snapshot = state();
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('system:changed', snapshot);
  }
}

function mainWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());
}

function showMainWindow(): void {
  const window = mainWindow();
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function quitApplication(): void {
  isQuitting = true;
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  app.quit();
}

function attachWindow(window: BrowserWindow): void {
  if (attachedWindows.has(window)) return;
  attachedWindows.add(window);

  const eventEmitter = window as unknown as EventEmitter;
  eventEmitter.on('minimize', () => {
    if (!settings.trayEnabled || !settings.minimizeToTray) return;
    setImmediate(() => {
      if (!window.isDestroyed()) window.hide();
    });
  });

  window.on('close', (event: Electron.Event) => {
    if (isQuitting || !settings.trayEnabled || !settings.closeToTray) return;
    event.preventDefault();
    window.hide();
  });
}

function trayImage(): Electron.NativeImage {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#07111f"/><path d="M8 8h16v4H13v3h9c2.2 0 4 1.8 4 4v1c0 2.2-1.8 4-4 4H8v-4h13v-3h-9c-2.2 0-4-1.8-4-4V8z" fill="#eeb85d"/></svg>';
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

function refreshTray(jobs: DownloadJob[] = Array.from(previousJobs.values())): void {
  if (!tray) return;
  const counts = downloadCountSummary(jobs);
  tray.setToolTip(`Subutai Download Manager — ${counts.active} идэвхтэй, ${counts.queued} хүлээгдэж байна`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Subutai-г нээх', click: showMainWindow },
    { type: 'separator' },
    { label: `Идэвхтэй: ${counts.active}`, enabled: false },
    { label: `Хүлээгдэж буй: ${counts.queued}`, enabled: false },
    { label: `Амжилтгүй: ${counts.failed}`, enabled: false },
    { type: 'separator' },
    { label: 'Шинэчлэлт шалгах', click: () => { void checkForUpdates(); } },
    { type: 'separator' },
    { label: 'Гарах', click: quitApplication },
  ]));
}

function configureTray(): void {
  if (!settings.trayEnabled) {
    tray?.destroy();
    tray = null;
    broadcast();
    return;
  }
  if (!tray) {
    tray = new Tray(trayImage());
    tray.on('double-click', showMainWindow);
    tray.on('click', showMainWindow);
  }
  refreshTray();
  broadcast();
}

function showDownloadNotification(kind: 'completed' | 'failed', job: DownloadJob): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title: kind === 'completed' ? 'Таталт дууслаа' : 'Таталт амжилтгүй боллоо',
    body: kind === 'completed' ? job.filename : `${job.filename}\n${job.error ?? 'Таталтын алдаа'}`,
    silent: false,
  });
  notification.on('click', showMainWindow);
  notification.show();
}

function pollDownloads(): void {
  if (!store) return;
  const jobs = store.loadAll();
  for (const event of downloadNotificationTransitions(previousJobs, jobs, settings)) {
    showDownloadNotification(event.kind, event.job);
  }
  previousJobs = new Map(jobs.map((job) => [job.id, { ...job }]));
  refreshTray(jobs);
}

function applyLoginSetting(): void {
  try {
    app.setLoginItemSettings({
      openAtLogin: settings.launchAtLogin,
      openAsHidden: settings.trayEnabled,
    });
  } catch {
    // Unsupported platforms keep the preference for the next supported launch.
  }
}

async function updateSettings(value: SystemSettingsUpdate): Promise<SystemState> {
  settings = normalizeSystemSettings(settings, value);
  store?.saveState(SETTINGS_KEY, settings);
  autoUpdater.autoDownload = settings.automaticUpdateDownloads;
  applyLoginSetting();
  configureTray();
  broadcast();
  return state();
}

function setUpdate(next: Partial<UpdateState>, clearFields: ClearableUpdateField[] = []): void {
  const merged: UpdateState = {
    ...update,
    ...next,
    currentVersion: app.getVersion(),
  };
  if (clearFields.includes('error')) delete merged.error;
  if (clearFields.includes('availableVersion')) delete merged.availableVersion;
  if (clearFields.includes('progressPercent')) delete merged.progressPercent;
  if (clearFields.includes('bytesPerSecond')) delete merged.bytesPerSecond;
  update = merged;
  broadcast();
}

function recordUpdateFailure(error: unknown): void {
  const failure = toSanitizedUpdateFailure(error);
  console.error(`[subutai-updater] ${failure.diagnosticMessage}`);
  setUpdate({ status: 'error', error: failure.publicMessage });
}

async function checkForUpdates(): Promise<SystemState> {
  if (!app.isPackaged) {
    setUpdate(
      { status: 'disabled', checkedAt: new Date().toISOString() },
      ['error', 'availableVersion', 'progressPercent', 'bytesPerSecond'],
    );
    return state();
  }
  setUpdate(
    { status: 'checking', checkedAt: new Date().toISOString() },
    ['error', 'progressPercent', 'bytesPerSecond'],
  );
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    recordUpdateFailure(error);
  }
  return state();
}

async function downloadUpdate(): Promise<SystemState> {
  if (!app.isPackaged) return checkForUpdates();
  try {
    setUpdate({ status: 'downloading' }, ['error']);
    await autoUpdater.downloadUpdate();
  } catch (error) {
    recordUpdateFailure(error);
  }
  return state();
}

function installUpdate(): void {
  if (update.status !== 'downloaded') return;
  isQuitting = true;
  autoUpdater.quitAndInstall(false, true);
}

function configureUpdater(): void {
  autoUpdater.autoDownload = settings.automaticUpdateDownloads;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => {
    setUpdate({ status: 'checking' }, ['error']);
  });
  autoUpdater.on('update-available', (info) => {
    setUpdate(
      { status: 'available', availableVersion: info.version, checkedAt: new Date().toISOString() },
      ['error', 'progressPercent', 'bytesPerSecond'],
    );
  });
  autoUpdater.on('update-not-available', () => {
    setUpdate(
      { status: 'not-available', checkedAt: new Date().toISOString() },
      ['error', 'availableVersion', 'progressPercent', 'bytesPerSecond'],
    );
  });
  autoUpdater.on('download-progress', (progress) => {
    setUpdate(
      { status: 'downloading', progressPercent: progress.percent, bytesPerSecond: progress.bytesPerSecond },
      ['error'],
    );
  });
  autoUpdater.on('update-downloaded', (info) => {
    setUpdate(
      { status: 'downloaded', availableVersion: info.version, progressPercent: 100 },
      ['error', 'bytesPerSecond'],
    );
    if (settings.notificationsEnabled && Notification.isSupported()) {
      const notification = new Notification({
        title: 'Subutai шинэчлэгдлээ',
        body: 'Шинэ хувилбарыг суулгахад бэлэн.',
      });
      notification.on('click', showMainWindow);
      notification.show();
    }
  });
  autoUpdater.on('error', (error) => {
    recordUpdateFailure(error);
  });
}

async function initialize(): Promise<void> {
  store = new JobStore(join(app.getPath('userData'), 'data', 'subutai.db'));
  settings = normalizeSystemSettings(
    DEFAULT_SYSTEM_SETTINGS,
    store.loadState<Partial<SystemSettings>>(SETTINGS_KEY) ?? {},
  );
  previousJobs = new Map(store.loadAll().map((job) => [job.id, { ...job }]));
  for (const window of BrowserWindow.getAllWindows()) attachWindow(window);
  app.on('browser-window-created', (_event, window) => attachWindow(window));
  applyLoginSetting();
  configureTray();
  configureUpdater();
  timer = setInterval(pollDownloads, 1_000);
  if (settings.automaticUpdateChecks && app.isPackaged) {
    setTimeout(() => { void checkForUpdates(); }, 12_000).unref();
  }
  broadcast();
}

ipcMain.handle('system:get', (): SystemState => state());
ipcMain.handle('system:update-settings', (_event, value: SystemSettingsUpdate) => updateSettings(value));
ipcMain.handle('system:check-updates', () => checkForUpdates());
ipcMain.handle('system:download-update', () => downloadUpdate());
ipcMain.handle('system:install-update', (): void => installUpdate());
ipcMain.handle('system:show-window', (): void => showMainWindow());
ipcMain.handle('system:quit', (): void => quitApplication());

void app.whenReady().then(initialize);
app.on('before-quit', () => {
  isQuitting = true;
  if (timer) clearInterval(timer);
  timer = null;
  tray?.destroy();
  tray = null;
  store?.close();
  store = null;
});
