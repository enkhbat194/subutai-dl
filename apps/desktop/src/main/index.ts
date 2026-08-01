import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import type { DownloadCreateRequest, DownloadJob } from '@subutai/shared';

const jobs = new Map<string, DownloadJob>();

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#07111f',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.once('ready-to-show', () => window.show());

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

ipcMain.handle('downloads:list', (): DownloadJob[] => Array.from(jobs.values()));

ipcMain.handle('downloads:create', (_event, request: DownloadCreateRequest): DownloadJob => {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const job: DownloadJob = {
    id,
    url: request.url,
    filename: request.filename ?? 'Resolving…',
    destination: request.destination,
    engine: request.engine ?? 'auto',
    status: 'queued',
    downloadedBytes: 0,
    totalBytes: null,
    speedBytesPerSecond: 0,
    createdAt: now,
    updatedAt: now,
  };

  jobs.set(id, job);
  return job;
});

ipcMain.handle('window:minimize', (event): void => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});

ipcMain.handle('window:toggle-maximize', (event): void => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return;
  if (window.isMaximized()) window.unmaximize();
  else window.maximize();
});

ipcMain.handle('window:close', (event): void => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
