import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { DownloadCreateRequest, DownloadJob, DownloadStatus, EngineHealth } from '@subutai/shared';
import { Aria2Service, type Aria2TaskStatus } from './engines/aria2-service';

const jobs = new Map<string, DownloadJob>();
const aria2 = new Aria2Service();
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
  return Array.from(jobs.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function broadcastJobs(): void {
  const current = snapshot();
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('downloads:changed', current);
}

function parseByteCount(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function statusFromAria2(status: Aria2TaskStatus['status']): DownloadStatus {
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
  if (!url) throw new Error('Download URL is required.');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('The download URL is invalid.');
  }
  if (!['http:', 'https:', 'ftp:', 'sftp:'].includes(parsed.protocol)) {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  }
}

function getJob(id: string): DownloadJob {
  const job = jobs.get(id);
  if (!job) throw new Error(`Download job not found: ${id}`);
  return job;
}

function getEngineTaskId(job: DownloadJob): string {
  if (!job.engineTaskId) throw new Error('The download has not been assigned to aria2 yet.');
  return job.engineTaskId;
}

async function createDownload(request: DownloadCreateRequest): Promise<DownloadJob> {
  validateRequest(request);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const connections = Math.max(1, Math.min(16, Math.trunc(request.connections ?? 16)));
  const destination = request.destination.trim() || app.getPath('downloads');
  const requestedFilename = request.filename?.trim() ?? '';
  const filename = requestedFilename || inferFilename(request.url);

  const job: DownloadJob = {
    id,
    url: request.url.trim(),
    filename,
    destination,
    engine: 'aria2',
    status: 'resolving',
    downloadedBytes: 0,
    totalBytes: null,
    speedBytesPerSecond: 0,
    etaSeconds: null,
    connections,
    createdAt: now,
    updatedAt: now,
  };

  jobs.set(id, job);
  broadcastJobs();

  try {
    const addOptions: { destination: string; connections: number; filename?: string } = { destination, connections };
    if (requestedFilename) addOptions.filename = requestedFilename;
    const gid = await aria2.addUri(job.url, addOptions);
    job.engineTaskId = gid;
    job.status = 'queued';
    job.updatedAt = new Date().toISOString();
  } catch (error) {
    job.status = 'failed';
    job.error = error instanceof Error ? error.message : String(error);
    job.updatedAt = new Date().toISOString();
  }

  broadcastJobs();
  return { ...job };
}

async function pauseDownload(id: string): Promise<DownloadJob> {
  const job = getJob(id);
  await aria2.pause(getEngineTaskId(job));
  job.status = 'paused';
  job.speedBytesPerSecond = 0;
  job.etaSeconds = null;
  job.updatedAt = new Date().toISOString();
  broadcastJobs();
  return { ...job };
}

async function resumeDownload(id: string): Promise<DownloadJob> {
  const job = getJob(id);
  await aria2.resume(getEngineTaskId(job));
  job.status = 'queued';
  delete job.error;
  job.updatedAt = new Date().toISOString();
  broadcastJobs();
  return { ...job };
}

async function cancelDownload(id: string): Promise<DownloadJob> {
  const job = getJob(id);
  if (job.engineTaskId && !['completed', 'failed', 'cancelled'].includes(job.status)) await aria2.cancel(job.engineTaskId);
  job.status = 'cancelled';
  job.speedBytesPerSecond = 0;
  job.etaSeconds = null;
  job.updatedAt = new Date().toISOString();
  broadcastJobs();
  return { ...job };
}

async function removeDownload(id: string, deleteFile = false): Promise<void> {
  const job = getJob(id);
  if (job.engineTaskId && !['completed', 'failed', 'cancelled'].includes(job.status)) {
    try { await aria2.cancel(job.engineTaskId); } catch { /* Task may already be gone. */ }
  }
  jobs.delete(id);
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

function updateJobFromStatus(job: DownloadJob, status: Aria2TaskStatus): void {
  const totalBytes = parseByteCount(status.totalLength);
  const downloadedBytes = parseByteCount(status.completedLength);
  const speedBytesPerSecond = parseByteCount(status.downloadSpeed);
  const remaining = Math.max(0, totalBytes - downloadedBytes);
  const filePath = status.files?.[0]?.path;

  job.status = statusFromAria2(status.status);
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
        const status = await aria2.tellStatus(job.engineTaskId);
        updateJobFromStatus(job, status);
        changed = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('not found')) {
          job.status = 'failed';
          job.error = message;
          job.speedBytesPerSecond = 0;
          job.etaSeconds = null;
          job.updatedAt = new Date().toISOString();
          changed = true;
        }
      }
    }
    if (changed) broadcastJobs();
  } finally {
    syncInProgress = false;
  }
}

ipcMain.handle('downloads:list', (): DownloadJob[] => snapshot());
ipcMain.handle('downloads:create', (_event, request: DownloadCreateRequest) => createDownload(request));
ipcMain.handle('downloads:pause', (_event, id: string) => pauseDownload(id));
ipcMain.handle('downloads:resume', (_event, id: string) => resumeDownload(id));
ipcMain.handle('downloads:cancel', (_event, id: string) => cancelDownload(id));
ipcMain.handle('downloads:remove', (_event, id: string, deleteFile?: boolean) => removeDownload(id, deleteFile));
ipcMain.handle('downloads:open-folder', (_event, id: string) => openDownloadFolder(id));
ipcMain.handle('engines:health', (): EngineHealth => ({ aria2: aria2.getHealth() }));
ipcMain.handle('window:minimize', (event): void => { BrowserWindow.fromWebContents(event.sender)?.minimize(); });
ipcMain.handle('window:toggle-maximize', (event): void => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return;
  if (window.isMaximized()) window.unmaximize(); else window.maximize();
});
ipcMain.handle('window:close', (event): void => { BrowserWindow.fromWebContents(event.sender)?.close(); });

app.whenReady().then(() => {
  createWindow();
  syncTimer = setInterval(() => void synchronizeJobs(), 750);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('before-quit', () => {
  if (syncTimer) clearInterval(syncTimer);
  void aria2.stop();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
