import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { DownloadCreateRequest, DownloadJob, DownloadStatus, EngineHealth } from '@subutai/shared';
import { consumeBrowserPayloadArguments } from './browser/native-messaging';
import { SubutaiEngine, type SubutaiTaskStatus } from './engines/subutai-engine';
import { JobStore } from './storage/job-store';

const jobs = new Map<string, DownloadJob>();
const engine = new SubutaiEngine();
let store: JobStore | null = null;
let syncTimer: NodeJS.Timeout | null = null;
let syncInProgress = false;

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
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void window.loadFile(join(__dirname, '../renderer/index.html'));
}

function snapshot(): DownloadJob[] {
  return Array.from(jobs.values())
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((job) => ({ ...job }));
}

function saveJob(job: DownloadJob): void {
  store?.save(job);
}

function broadcastJobs(): void {
  const current = snapshot();
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('downloads:changed', current);
  }
}

function parseByteCount(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function statusFromEngine(status: SubutaiTaskStatus['status']): DownloadStatus {
  switch (status) {
    case 'active': return 'downloading';
    case 'waiting': return 'queued';
    case 'paused': return 'paused';
    case 'complete': return 'completed';
    case 'error': return 'failed';
    case 'removed': return 'cancelled';
  }
}

function inferFilename(url: string): string {
  try {
    const parsed = new URL(url);
    const candidate = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).at(-1) ?? 'download');
    return candidate || 'download';
  } catch {
    return 'download';
  }
}

function validateRequest(request: DownloadCreateRequest): void {
  const url = request.url.trim();
  if (!url) throw new Error('Татах URL шаардлагатай.');

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('URL буруу байна.');
  }

  if (!['http:', 'https:', 'ftp:', 'sftp:'].includes(parsed.protocol)) {
    throw new Error(`Одоогоор дэмжихгүй протокол: ${parsed.protocol}`);
  }
}

function getJob(id: string): DownloadJob {
  const job = jobs.get(id);
  if (!job) throw new Error(`Таталт олдсонгүй: ${id}`);
  return job;
}

async function assignTask(job: DownloadJob): Promise<void> {
  job.status = 'resolving';
  job.updatedAt = new Date().toISOString();
  saveJob(job);
  broadcastJobs();

  const options: {
    url: string;
    destination: string;
    filename?: string;
    connections: number;
    headers?: Record<string, string>;
  } = {
    url: job.url,
    destination: job.destination,
    filename: job.filename,
    connections: job.connections,
  };
  if (job.headers) options.headers = job.headers;

  job.engineTaskId = await engine.addDownload(options);
  job.status = 'queued';
  job.updatedAt = new Date().toISOString();
  saveJob(job);
  broadcastJobs();
}

export async function createDownload(request: DownloadCreateRequest): Promise<DownloadJob> {
  validateRequest(request);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const connections = Math.max(1, Math.min(32, Math.trunc(request.connections ?? 16)));
  const destination = request.destination.trim() || app.getPath('downloads');
  const requestedFilename = request.filename?.trim() ?? '';
  const filename = requestedFilename || inferFilename(request.url);

  const job: DownloadJob = {
    id,
    url: request.url.trim(),
    filename,
    destination,
    engine: 'subutai',
    status: 'queued',
    downloadedBytes: 0,
    totalBytes: null,
    speedBytesPerSecond: 0,
    etaSeconds: null,
    connections,
    createdAt: now,
    updatedAt: now,
  };
  if (request.source) job.source = request.source;
  if (request.sourcePageUrl) job.sourcePageUrl = request.sourcePageUrl;
  if (request.headers && Object.keys(request.headers).length > 0) job.headers = { ...request.headers };

  jobs.set(id, job);
  saveJob(job);
  broadcastJobs();

  try {
    await assignTask(job);
  } catch (error) {
    job.status = 'failed';
    job.error = error instanceof Error ? error.message : String(error);
    job.updatedAt = new Date().toISOString();
    saveJob(job);
    broadcastJobs();
  }

  return { ...job };
}

export async function enqueueBrowserArguments(args: readonly string[]): Promise<number> {
  return consumeBrowserPayloadArguments(args, createDownload);
}

async function pauseDownload(id: string): Promise<DownloadJob> {
  const job = getJob(id);
  if (!job.engineTaskId) await assignTask(job);
  if (!job.engineTaskId) throw new Error('Таталтын даалгавар үүссэнгүй.');
  await engine.pause(job.engineTaskId);
  job.status = 'paused';
  job.speedBytesPerSecond = 0;
  job.etaSeconds = null;
  job.updatedAt = new Date().toISOString();
  saveJob(job);
  broadcastJobs();
  return { ...job };
}

async function resumeDownload(id: string): Promise<DownloadJob> {
  const job = getJob(id);
  if (!job.engineTaskId) {
    await assignTask(job);
  } else {
    await engine.resume(job.engineTaskId);
    job.status = 'queued';
    job.updatedAt = new Date().toISOString();
    saveJob(job);
    broadcastJobs();
  }
  delete job.error;
  return { ...job };
}

async function cancelDownload(id: string): Promise<DownloadJob> {
  const job = getJob(id);
  if (job.engineTaskId && !['completed', 'failed', 'cancelled'].includes(job.status)) {
    await engine.cancel(job.engineTaskId);
  }
  delete job.engineTaskId;
  job.status = 'cancelled';
  job.speedBytesPerSecond = 0;
  job.etaSeconds = null;
  job.updatedAt = new Date().toISOString();
  saveJob(job);
  broadcastJobs();
  return { ...job };
}

async function removeDownload(id: string, deleteFile = false): Promise<void> {
  const job = getJob(id);
  if (job.engineTaskId && !['completed', 'failed', 'cancelled'].includes(job.status)) {
    try {
      await engine.cancel(job.engineTaskId);
    } catch {
      // The task may already be gone.
    }
  }

  jobs.delete(id);
  store?.remove(id);

  if (deleteFile) {
    await rm(join(job.destination, job.filename), { force: true });
    await rm(join(job.destination, `${job.filename}.aria2`), { force: true });
  }
  broadcastJobs();
}

async function openDownloadFolder(id: string): Promise<void> {
  const job = getJob(id);
  const filePath = join(job.destination, job.filename);
  if (existsSync(filePath)) {
    shell.showItemInFolder(filePath);
    return;
  }
  const error = await shell.openPath(job.destination);
  if (error) throw new Error(error);
}

function updateJobFromStatus(job: DownloadJob, status: SubutaiTaskStatus): void {
  const totalBytes = parseByteCount(status.totalLength);
  const downloadedBytes = parseByteCount(status.completedLength);
  const speedBytesPerSecond = parseByteCount(status.downloadSpeed);
  const remaining = Math.max(0, totalBytes - downloadedBytes);
  const filePath = status.files?.[0]?.path;

  job.status = statusFromEngine(status.status);
  job.totalBytes = totalBytes > 0 ? totalBytes : null;
  job.downloadedBytes = downloadedBytes;
  job.speedBytesPerSecond = speedBytesPerSecond;
  job.etaSeconds = speedBytesPerSecond > 0 ? Math.ceil(remaining / speedBytesPerSecond) : null;
  job.connections = Math.max(0, Number(status.connections) || job.connections);
  job.updatedAt = new Date().toISOString();
  if (filePath) job.filename = basename(filePath);
  if (status.errorMessage) job.error = status.errorMessage;
  else if (job.status !== 'failed') delete job.error;
}

async function synchronizeJobs(): Promise<void> {
  if (syncInProgress) return;
  syncInProgress = true;
  try {
    let changed = false;
    for (const job of jobs.values()) {
      if (!job.engineTaskId || ['completed', 'failed', 'cancelled'].includes(job.status)) continue;
      try {
        const status = await engine.getStatus(job.engineTaskId);
        updateJobFromStatus(job, status);
        saveJob(job);
        changed = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.toLowerCase().includes('not found')) {
          job.status = 'failed';
          job.error = message;
          job.speedBytesPerSecond = 0;
          job.etaSeconds = null;
          job.updatedAt = new Date().toISOString();
          saveJob(job);
          changed = true;
        }
      }
    }
    if (changed) broadcastJobs();
  } finally {
    syncInProgress = false;
  }
}

function restoreJobs(): void {
  if (!store) return;
  for (const restored of store.loadAll()) {
    restored.engine = 'subutai';
    restored.speedBytesPerSecond = 0;
    restored.etaSeconds = null;
    if (!['completed', 'failed', 'cancelled'].includes(restored.status)) {
      delete restored.engineTaskId;
      if (restored.status !== 'paused') restored.status = 'queued';
    }
    jobs.set(restored.id, restored);
  }
}

async function recoverInterruptedJobs(): Promise<void> {
  for (const job of jobs.values()) {
    if (job.status !== 'queued' || job.engineTaskId) continue;
    try {
      await assignTask(job);
    } catch (error) {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : String(error);
      job.updatedAt = new Date().toISOString();
      saveJob(job);
    }
  }
  broadcastJobs();
}

ipcMain.handle('downloads:list', (): DownloadJob[] => snapshot());
ipcMain.handle('downloads:create', (_event, request: DownloadCreateRequest) => createDownload(request));
ipcMain.handle('downloads:pause', (_event, id: string) => pauseDownload(id));
ipcMain.handle('downloads:resume', (_event, id: string) => resumeDownload(id));
ipcMain.handle('downloads:cancel', (_event, id: string) => cancelDownload(id));
ipcMain.handle('downloads:remove', (_event, id: string, deleteFile?: boolean) => removeDownload(id, deleteFile));
ipcMain.handle('downloads:open-folder', (_event, id: string) => openDownloadFolder(id));
ipcMain.handle('engines:health', (): EngineHealth => ({ subutai: engine.getHealth() }));
ipcMain.handle('window:minimize', (event): void => { BrowserWindow.fromWebContents(event.sender)?.minimize(); });
ipcMain.handle('window:toggle-maximize', (event): void => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return;
  if (window.isMaximized()) window.unmaximize();
  else window.maximize();
});
ipcMain.handle('window:close', (event): void => { BrowserWindow.fromWebContents(event.sender)?.close(); });

app.whenReady().then(async () => {
  store = new JobStore(join(app.getPath('userData'), 'data', 'subutai.db'));
  restoreJobs();
  await enqueueBrowserArguments(process.argv);
  createWindow();
  void recoverInterruptedJobs();
  syncTimer = setInterval(() => void synchronizeJobs(), 750);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  if (syncTimer) clearInterval(syncTimer);
  try {
    store?.saveMany(jobs.values());
    store?.close();
  } catch {
    // Shutdown must continue even when persistence is unavailable.
  }
  void engine.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
