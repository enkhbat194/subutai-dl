import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type {
  DownloadCreateRequest,
  DownloadFailureKind,
  DownloadJob,
  DownloadSchedule,
  DownloadScheduleInput,
  DownloadStatus,
  EngineHealth,
  MediaDownloadOptions,
  MediaProbeRequest,
  MediaProbeResult,
  QueuePriority,
  QueueSettings,
  QueueSnapshot,
  TransferSettings,
  TransferSettingsUpdate,
} from '@subutai/shared';
import { consumeBrowserPayloadArguments } from './browser/native-messaging';
import { SubutaiEngine, type SubutaiTaskStatus } from './engines/subutai-engine';
import { toPublicError } from './engines/public-error';
import {
  DEFAULT_TRANSFER_SETTINGS,
  normalizeTransferSettings,
  resolveProxyUrl,
} from './network/transfer-policy';
import { isRunningStatus, queueAllowance, sortQueuedJobs } from './queue/queue-policy';
import { canAutoRetry, classifyDownloadFailure } from './resilience/failure-policy';
import { JobStore } from './storage/job-store';

const jobs = new Map<string, DownloadJob>();
const schedules = new Map<string, DownloadSchedule>();
const engine = new SubutaiEngine();
let store: JobStore | null = null;
let syncTimer: NodeJS.Timeout | null = null;
let syncInProgress = false;
let queueInProgress = false;
let proxyPassword = '';
let transferSettings: TransferSettings = { ...DEFAULT_TRANSFER_SETTINGS };
let queueSettings: QueueSettings = {
  maxConcurrentDownloads: 3,
  schedulingEnabled: false,
  pauseOutsideSchedule: true,
};

const MEDIA_HOSTS = [
  'youtube.com', 'youtu.be', 'facebook.com', 'fb.watch', 'instagram.com',
  'tiktok.com', 'vimeo.com', 'dailymotion.com', 'twitch.tv', 'soundcloud.com',
  'twitter.com', 'x.com', 'reddit.com',
];

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
    .sort((a, b) => {
      const orderA = a.queueOrder ?? Number.MAX_SAFE_INTEGER;
      const orderB = b.queueOrder ?? Number.MAX_SAFE_INTEGER;
      if (orderA !== orderB) return orderA - orderB;
      return b.createdAt.localeCompare(a.createdAt);
    })
    .map((job) => ({ ...job }));
}

function queueSnapshot(date = new Date()): QueueSnapshot {
  const allowance = queueAllowance(queueSettings, Array.from(schedules.values()), date);
  const values = Array.from(jobs.values());
  return {
    settings: { ...queueSettings },
    schedules: Array.from(schedules.values()).sort((a, b) => a.name.localeCompare(b.name)),
    activeScheduleIds: allowance.activeScheduleIds,
    allowedNow: allowance.allowed,
    runningCount: values.filter((job) => isRunningStatus(job.status)).length,
    queuedCount: values.filter((job) => job.status === 'queued').length,
    pausedCount: values.filter((job) => job.status === 'paused').length,
  };
}

function saveJob(job: DownloadJob): void {
  store?.save(job);
}

function broadcastJobs(): void {
  const current = snapshot();
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('downloads:changed', current);
}

function broadcastQueue(): void {
  const current = queueSnapshot();
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('queue:changed', current);
}

function broadcastTransferSettings(): void {
  const current = { ...transferSettings };
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('transfer-settings:changed', current);
}

function broadcastAll(): void {
  broadcastJobs();
  broadcastQueue();
}

function parseByteCount(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}


function markJobFailed(job: DownloadJob, error: unknown): void {
  const message = toPublicError(error);
  job.status = 'failed';
  job.error = message;
  job.failureKind = classifyDownloadFailure(message);
  job.speedBytesPerSecond = 0;
  job.etaSeconds = null;
  job.updatedAt = new Date().toISOString();
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

function isLikelyMediaUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (MEDIA_HOSTS.some((candidate) => host === candidate || host.endsWith(`.${candidate}`))) return true;
    const path = parsed.pathname.toLowerCase();
    return path.endsWith('.m3u8') || path.endsWith('.mpd');
  } catch {
    return false;
  }
}

function resolveMediaOptions(request: DownloadCreateRequest): MediaDownloadOptions | undefined {
  if (request.media) return { ...request.media };
  if (request.engine === 'media' || (request.engine !== 'subutai' && isLikelyMediaUrl(request.url))) {
    return {
      mode: 'video',
      quality: 'best',
      playlist: false,
      subtitles: false,
      embedMetadata: true,
    };
  }
  return undefined;
}

function getJob(id: string): DownloadJob {
  const job = jobs.get(id);
  if (!job) throw new Error(`Таталт олдсонгүй: ${id}`);
  return job;
}

function nextQueueOrder(): number {
  let highest = 0;
  for (const job of jobs.values()) highest = Math.max(highest, job.queueOrder ?? 0);
  return highest + 1;
}

function jobMatchesSchedule(job: DownloadJob, activeScheduleIds: string[], schedulingEnabled: boolean): boolean {
  if (!job.scheduleId) return true;
  if (!schedulingEnabled) return true;
  return activeScheduleIds.includes(job.scheduleId);
}

async function assignTask(job: DownloadJob): Promise<void> {
  job.status = 'resolving';
  job.updatedAt = new Date().toISOString();
  saveJob(job);
  broadcastAll();

  const options: {
    url: string;
    destination: string;
    filename?: string;
    connections: number;
    headers?: Record<string, string>;
    sourcePageUrl?: string;
    media?: MediaDownloadOptions;
    speedLimitBytesPerSecond?: number;
  } = {
    url: job.url,
    destination: job.destination,
    connections: job.connections,
  };
  if (job.filename && job.filename !== 'Media таталт') options.filename = job.filename;
  if (job.headers) options.headers = job.headers;
  if (job.sourcePageUrl) options.sourcePageUrl = job.sourcePageUrl;
  if (job.media) options.media = job.media;
  if (typeof job.speedLimitBytesPerSecond === 'number') options.speedLimitBytesPerSecond = job.speedLimitBytesPerSecond;

  job.engineTaskId = await engine.addDownload(options);
  delete job.error;
  delete job.failureKind;
  job.status = 'queued';
  job.updatedAt = new Date().toISOString();
  saveJob(job);
}

async function startQueuedJob(job: DownloadJob): Promise<void> {
  job.pausedByScheduler = false;
  if (job.engineTaskId) {
    job.status = 'resolving';
    job.updatedAt = new Date().toISOString();
    saveJob(job);
    await engine.resume(job.engineTaskId);
  } else {
    await assignTask(job);
  }
}

async function pauseForSchedule(job: DownloadJob): Promise<void> {
  if (!isRunningStatus(job.status)) return;
  if (job.engineTaskId) await engine.pause(job.engineTaskId);
  job.status = 'paused';
  job.pausedByScheduler = true;
  job.speedBytesPerSecond = 0;
  job.etaSeconds = null;
  job.updatedAt = new Date().toISOString();
  saveJob(job);
}

async function processQueue(force = false): Promise<void> {
  if (queueInProgress) return;
  queueInProgress = true;
  try {
    const allowance = queueAllowance(queueSettings, Array.from(schedules.values()), new Date());
    const allowed = force || allowance.allowed;

    if (!allowed) {
      if (queueSettings.pauseOutsideSchedule) {
        for (const job of jobs.values()) {
          try {
            await pauseForSchedule(job);
          } catch (error) {
            job.error = toPublicError(error);
            job.updatedAt = new Date().toISOString();
            saveJob(job);
          }
        }
      }
      broadcastAll();
      return;
    }

    for (const job of jobs.values()) {
      if (job.status === 'paused' && job.pausedByScheduler) {
        job.status = 'queued';
        job.pausedByScheduler = false;
        job.updatedAt = new Date().toISOString();
        saveJob(job);
      }
    }

    const runningCount = Array.from(jobs.values()).filter((job) => isRunningStatus(job.status)).length;
    let slots = Math.max(0, (force ? queueSettings.maxConcurrentDownloads : allowance.maxConcurrent) - runningCount);
    if (slots <= 0) {
      broadcastAll();
      return;
    }

    const candidates = sortQueuedJobs(jobs.values()).filter((job) =>
      jobMatchesSchedule(job, allowance.activeScheduleIds, queueSettings.schedulingEnabled) && !job.pausedByScheduler,
    );

    for (const job of candidates) {
      if (slots <= 0) break;
      try {
        await startQueuedJob(job);
        slots -= 1;
      } catch (error) {
        markJobFailed(job, error);
        saveJob(job);
      }
    }
    broadcastAll();
  } finally {
    queueInProgress = false;
  }
}

export async function createDownload(request: DownloadCreateRequest): Promise<DownloadJob> {
  validateRequest(request);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const connections = Math.max(1, Math.min(32, Math.trunc(request.connections ?? 16)));
  const destination = request.destination.trim() || app.getPath('downloads');
  const requestedFilename = request.filename?.trim() ?? '';
  const media = resolveMediaOptions(request);
  const filename = requestedFilename || (media ? 'Media таталт' : inferFilename(request.url));

  const job: DownloadJob = {
    id,
    url: request.url.trim(),
    filename,
    destination,
    engine: media ? 'media' : 'subutai',
    status: 'queued',
    downloadedBytes: 0,
    totalBytes: null,
    speedBytesPerSecond: 0,
    etaSeconds: null,
    connections: media ? 1 : connections,
    createdAt: now,
    updatedAt: now,
    priority: request.priority ?? 'normal',
    queueOrder: nextQueueOrder(),
    retryCount: 0,
  };
  if (request.source) job.source = request.source;
  if (request.sourcePageUrl) job.sourcePageUrl = request.sourcePageUrl;
  if (request.headers && Object.keys(request.headers).length > 0) job.headers = { ...request.headers };
  if (media) job.media = media;
  if (request.scheduleId) job.scheduleId = request.scheduleId;
  if (typeof request.speedLimitBytesPerSecond === 'number' && request.speedLimitBytesPerSecond > 0) {
    job.speedLimitBytesPerSecond = Math.trunc(request.speedLimitBytesPerSecond);
  }

  jobs.set(id, job);
  saveJob(job);
  broadcastAll();
  void processQueue();
  return { ...job };
}

export async function enqueueBrowserArguments(args: readonly string[]): Promise<number> {
  return consumeBrowserPayloadArguments(args, createDownload);
}

async function probeMedia(request: MediaProbeRequest): Promise<MediaProbeResult> {
  validateRequest({ url: request.url, destination: '', engine: 'media' });
  try {
    return await engine.probeMedia(request.url.trim(), request.headers, request.sourcePageUrl);
  } catch (error) {
    throw new Error(toPublicError(error));
  }
}

async function pauseDownload(id: string): Promise<DownloadJob> {
  const job = getJob(id);
  if (job.engineTaskId && isRunningStatus(job.status)) await engine.pause(job.engineTaskId);
  job.status = 'paused';
  job.pausedByScheduler = false;
  job.speedBytesPerSecond = 0;
  job.etaSeconds = null;
  job.updatedAt = new Date().toISOString();
  saveJob(job);
  broadcastAll();
  void processQueue();
  return { ...job };
}

async function resumeDownload(id: string): Promise<DownloadJob> {
  const job = getJob(id);
  job.status = 'queued';
  job.pausedByScheduler = false;
  delete job.error;
  job.updatedAt = new Date().toISOString();
  saveJob(job);
  broadcastAll();
  void processQueue();
  return { ...job };
}

async function cancelDownload(id: string): Promise<DownloadJob> {
  const job = getJob(id);
  if (job.engineTaskId && !['completed', 'failed', 'cancelled'].includes(job.status)) await engine.cancel(job.engineTaskId);
  delete job.engineTaskId;
  job.status = 'cancelled';
  job.pausedByScheduler = false;
  job.speedBytesPerSecond = 0;
  job.etaSeconds = null;
  job.updatedAt = new Date().toISOString();
  saveJob(job);
  broadcastAll();
  void processQueue();
  return { ...job };
}

async function removeDownload(id: string, deleteFile = false): Promise<void> {
  const job = getJob(id);
  if (job.engineTaskId && !['completed', 'failed', 'cancelled'].includes(job.status)) {
    try { await engine.cancel(job.engineTaskId); } catch { /* task may already be gone */ }
  }
  jobs.delete(id);
  store?.remove(id);
  if (deleteFile) {
    await rm(join(job.destination, job.filename), { force: true });
    if (job.engine !== 'media') await rm(join(job.destination, `${job.filename}.aria2`), { force: true });
  }
  broadcastAll();
  void processQueue();
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

async function setDownloadPriority(id: string, priority: QueuePriority): Promise<DownloadJob> {
  const job = getJob(id);
  job.priority = priority;
  job.updatedAt = new Date().toISOString();
  saveJob(job);
  broadcastAll();
  void processQueue();
  return { ...job };
}

async function moveDownload(id: string, direction: 'up' | 'down' | 'top' | 'bottom'): Promise<DownloadJob[]> {
  const ordered = Array.from(jobs.values()).sort((a, b) => (a.queueOrder ?? 0) - (b.queueOrder ?? 0));
  const index = ordered.findIndex((job) => job.id === id);
  if (index < 0) throw new Error(`Таталт олдсонгүй: ${id}`);
  const [job] = ordered.splice(index, 1);
  if (!job) return snapshot();
  const target = direction === 'top' ? 0 : direction === 'bottom' ? ordered.length : direction === 'up' ? Math.max(0, index - 1) : Math.min(ordered.length, index + 1);
  ordered.splice(target, 0, job);
  const now = new Date().toISOString();
  ordered.forEach((item, queueIndex) => {
    item.queueOrder = queueIndex + 1;
    item.updatedAt = now;
    saveJob(item);
  });
  broadcastAll();
  return snapshot();
}

function normalizeQueueSettings(update: Partial<QueueSettings>): QueueSettings {
  return {
    maxConcurrentDownloads: Math.max(1, Math.min(32, Math.trunc(update.maxConcurrentDownloads ?? queueSettings.maxConcurrentDownloads))),
    schedulingEnabled: update.schedulingEnabled ?? queueSettings.schedulingEnabled,
    pauseOutsideSchedule: update.pauseOutsideSchedule ?? queueSettings.pauseOutsideSchedule,
  };
}

async function updateQueueSettings(update: Partial<QueueSettings>): Promise<QueueSnapshot> {
  queueSettings = normalizeQueueSettings(update);
  store?.saveQueueSettings(queueSettings);
  await processQueue();
  broadcastQueue();
  return queueSnapshot();
}

function validateTime(value: string): string {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error(`Цагийн формат буруу: ${value}`);
  return value;
}

async function saveSchedule(input: DownloadScheduleInput): Promise<QueueSnapshot> {
  const name = input.name.trim();
  if (!name) throw new Error('Хуваарийн нэр шаардлагатай.');
  const id = input.id?.trim() || crypto.randomUUID();
  const existing = schedules.get(id);
  const now = new Date().toISOString();
  const schedule: DownloadSchedule = {
    id,
    name,
    enabled: Boolean(input.enabled),
    days: Array.from(new Set(input.days.map((day) => Math.max(0, Math.min(6, Math.trunc(day)))))).sort(),
    startTime: validateTime(input.startTime),
    endTime: validateTime(input.endTime),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  if (typeof input.maxConcurrentDownloads === 'number' && input.maxConcurrentDownloads > 0) {
    schedule.maxConcurrentDownloads = Math.max(1, Math.min(32, Math.trunc(input.maxConcurrentDownloads)));
  }
  schedules.set(id, schedule);
  store?.saveSchedule(schedule);
  await processQueue();
  broadcastQueue();
  return queueSnapshot();
}

async function deleteSchedule(id: string): Promise<QueueSnapshot> {
  schedules.delete(id);
  store?.deleteSchedule(id);
  for (const job of jobs.values()) {
    if (job.scheduleId === id) {
      delete job.scheduleId;
      job.updatedAt = new Date().toISOString();
      saveJob(job);
    }
  }
  await processQueue();
  broadcastAll();
  return queueSnapshot();
}

async function runQueueNow(): Promise<QueueSnapshot> {
  await processQueue(true);
  return queueSnapshot();
}

function loadProxyPassword(): string {
  const encoded = store?.loadState<string>('proxy-password-encrypted');
  if (!encoded || !safeStorage.isEncryptionAvailable()) return '';
  try {
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
  } catch {
    return '';
  }
}

function persistProxyPassword(): void {
  if (!store) return;
  if (!proxyPassword) {
    store.deleteState('proxy-password-encrypted');
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) return;
  const encrypted = safeStorage.encryptString(proxyPassword).toString('base64');
  store.saveState('proxy-password-encrypted', encrypted);
}

async function updateTransferSettings(update: TransferSettingsUpdate): Promise<TransferSettings> {
  if (update.clearProxyPassword) proxyPassword = '';
  else if (typeof update.proxyPassword === 'string') proxyPassword = update.proxyPassword;
  transferSettings = normalizeTransferSettings(transferSettings, update, Boolean(proxyPassword));
  if (transferSettings.proxyMode === 'manual') resolveProxyUrl(transferSettings, proxyPassword);
  store?.saveState('transfer-settings', transferSettings);
  persistProxyPassword();
  await engine.configureTransfer(transferSettings, proxyPassword);

  for (const job of jobs.values()) {
    if (job.engine !== 'media' || !isRunningStatus(job.status) || !job.engineTaskId) continue;
    try {
      await engine.pause(job.engineTaskId);
      job.status = 'queued';
      job.updatedAt = new Date().toISOString();
      saveJob(job);
    } catch {
      // Existing media task may have completed while settings were changing.
    }
  }
  broadcastTransferSettings();
  broadcastAll();
  void processQueue();
  return { ...transferSettings };
}


export function getDownloadSnapshot(): DownloadJob[] {
  return snapshot();
}

export async function recoverNetworkInterruptedDownloads(maxRetries = 5): Promise<number> {
  let recovered = 0;
  for (const job of jobs.values()) {
    if (!canAutoRetry(job, maxRetries)) continue;
    if (job.engineTaskId) {
      try {
        await engine.cancel(job.engineTaskId);
      } catch {
        // The failed task may already have disappeared from the engine.
      }
    }
    delete job.engineTaskId;
    delete job.error;
    delete job.failureKind;
    job.status = 'queued';
    job.retryCount = (job.retryCount ?? 0) + 1;
    job.lastRetryAt = new Date().toISOString();
    job.updatedAt = job.lastRetryAt;
    saveJob(job);
    recovered += 1;
  }
  if (recovered > 0) {
    broadcastAll();
    await processQueue(true);
  }
  return recovered;
}

function updateJobFromStatus(job: DownloadJob, status: SubutaiTaskStatus): void {
  const totalBytes = parseByteCount(status.totalLength);
  const downloadedBytes = parseByteCount(status.completedLength);
  const speedBytesPerSecond = parseByteCount(status.downloadSpeed);
  const remaining = Math.max(0, totalBytes - downloadedBytes);
  const filePath = status.files?.[0]?.path;
  const mapped = status.phase === 'merging' ? 'merging' : statusFromEngine(status.status);
  job.status = mapped === 'queued' && job.engineTaskId ? 'resolving' : mapped;
  job.totalBytes = totalBytes > 0 ? totalBytes : null;
  job.downloadedBytes = downloadedBytes;
  job.speedBytesPerSecond = speedBytesPerSecond;
  job.etaSeconds = speedBytesPerSecond > 0 ? Math.ceil(remaining / speedBytesPerSecond) : null;
  job.connections = job.engine === 'media' ? 1 : Math.max(0, Number(status.connections) || job.connections);
  job.updatedAt = new Date().toISOString();
  if (filePath) job.filename = basename(filePath);
  else if (status.displayName && job.engine === 'media') job.filename = status.displayName;
  if (status.playlistIndex) job.playlistIndex = status.playlistIndex;
  if (status.playlistCount) job.playlistCount = status.playlistCount;
  if (status.errorMessage) {
    job.error = status.errorMessage;
    job.failureKind = classifyDownloadFailure(status.errorMessage);
  } else if (job.status !== 'failed') {
    delete job.error;
    delete job.failureKind;
  }
}

async function synchronizeJobs(): Promise<void> {
  if (syncInProgress) return;
  syncInProgress = true;
  try {
    let changed = false;
    for (const job of jobs.values()) {
      if (!job.engineTaskId || ['completed', 'failed', 'cancelled'].includes(job.status) || job.status === 'paused') continue;
      try {
        const status = await engine.getStatus(job.engineTaskId);
        updateJobFromStatus(job, status);
        saveJob(job);
        changed = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.toLowerCase().includes('not found')) {
          markJobFailed(job, message);
          saveJob(job);
          changed = true;
        }
      }
    }
    if (changed) broadcastAll();
  } finally {
    syncInProgress = false;
  }
  void processQueue();
}

function restoreState(): void {
  if (!store) return;
  queueSettings = store.loadQueueSettings();
  for (const schedule of store.loadSchedules()) schedules.set(schedule.id, schedule);
  proxyPassword = loadProxyPassword();
  const savedTransfer = store.loadState<TransferSettingsUpdate>('transfer-settings') ?? {};
  transferSettings = normalizeTransferSettings(DEFAULT_TRANSFER_SETTINGS, savedTransfer, Boolean(proxyPassword));
  let order = 1;
  for (const restored of store.loadAll()) {
    restored.speedBytesPerSecond = 0;
    restored.etaSeconds = null;
    restored.priority ??= 'normal';
    restored.queueOrder ??= order;
    restored.retryCount ??= 0;
    order += 1;
    if (!['completed', 'failed', 'cancelled'].includes(restored.status)) {
      delete restored.engineTaskId;
      if (restored.status !== 'paused' || restored.pausedByScheduler) restored.status = 'queued';
    }
    jobs.set(restored.id, restored);
  }
}

ipcMain.handle('downloads:list', (): DownloadJob[] => snapshot());
ipcMain.handle('downloads:create', (_event, request: DownloadCreateRequest) => createDownload(request));
ipcMain.handle('media:probe', (_event, request: MediaProbeRequest) => probeMedia(request));
ipcMain.handle('downloads:pause', (_event, id: string) => pauseDownload(id));
ipcMain.handle('downloads:resume', (_event, id: string) => resumeDownload(id));
ipcMain.handle('downloads:cancel', (_event, id: string) => cancelDownload(id));
ipcMain.handle('downloads:remove', (_event, id: string, deleteFile?: boolean) => removeDownload(id, deleteFile));
ipcMain.handle('downloads:open-folder', (_event, id: string) => openDownloadFolder(id));
ipcMain.handle('downloads:priority', (_event, id: string, priority: QueuePriority) => setDownloadPriority(id, priority));
ipcMain.handle('downloads:move', (_event, id: string, direction: 'up' | 'down' | 'top' | 'bottom') => moveDownload(id, direction));
ipcMain.handle('queue:get', (): QueueSnapshot => queueSnapshot());
ipcMain.handle('queue:settings', (_event, settings: Partial<QueueSettings>) => updateQueueSettings(settings));
ipcMain.handle('queue:schedule-save', (_event, schedule: DownloadScheduleInput) => saveSchedule(schedule));
ipcMain.handle('queue:schedule-delete', (_event, id: string) => deleteSchedule(id));
ipcMain.handle('queue:run-now', () => runQueueNow());
ipcMain.handle('transfer-settings:get', (): TransferSettings => ({ ...transferSettings }));
ipcMain.handle('transfer-settings:update', (_event, settings: TransferSettingsUpdate) => updateTransferSettings(settings));
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
  restoreState();
  await engine.configureTransfer(transferSettings, proxyPassword);
  await enqueueBrowserArguments(process.argv);
  createWindow();
  await processQueue();
  syncTimer = setInterval(() => void synchronizeJobs(), 750);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  if (syncTimer) clearInterval(syncTimer);
  try {
    store?.saveMany(jobs.values());
    store?.saveQueueSettings(queueSettings);
    store?.saveState('transfer-settings', transferSettings);
    persistProxyPassword();
    for (const schedule of schedules.values()) store?.saveSchedule(schedule);
    store?.close();
  } catch {
    // Shutdown must continue even when persistence is unavailable.
  }
  void engine.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
