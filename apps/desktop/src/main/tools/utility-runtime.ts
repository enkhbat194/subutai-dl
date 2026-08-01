import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import type {
  ClipboardCapture,
  ClipboardSettings,
  ClipboardSettingsUpdate,
  ClipboardSnapshot,
  DownloadCreateRequest,
  SiteGrabberEnqueueRequest,
  SiteGrabberEnqueueResult,
  SiteGrabberJob,
  SiteGrabberStartRequest,
} from '@subutai/shared';
import { ClipboardMonitor, type ClipboardDetection } from '../clipboard/clipboard-monitor';
import {
  DEFAULT_CLIPBOARD_SETTINGS,
  normalizeClipboardSettings,
} from '../clipboard/clipboard-policy';
import { SiteGrabberService } from '../site-grabber/site-grabber-service';
import { JobStore } from '../storage/job-store';
import { createDownload } from '../subutai-runtime';

const CLIPBOARD_SETTINGS_KEY = 'clipboard-settings';
const CLIPBOARD_CAPTURES_KEY = 'clipboard-captures';
const SITE_GRABBER_JOBS_KEY = 'site-grabber-jobs';

let utilityStore: JobStore | null = null;
let clipboardMonitor: ClipboardMonitor | null = null;
let clipboardSettings: ClipboardSettings = { ...DEFAULT_CLIPBOARD_SETTINGS };
let captures: ClipboardCapture[] = [];
let sitePersistTimer: NodeJS.Timeout | null = null;

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload);
  }
}

function cloneCapture(capture: ClipboardCapture): ClipboardCapture {
  const clone: ClipboardCapture = {
    ...capture,
    urls: [...capture.urls],
    queuedJobIds: [...capture.queuedJobIds],
  };
  if (capture.error) clone.error = capture.error;
  return clone;
}

function clipboardSnapshot(): ClipboardSnapshot {
  return {
    settings: {
      ...clipboardSettings,
      ignoredHosts: [...clipboardSettings.ignoredHosts],
      ignoredExtensions: [...clipboardSettings.ignoredExtensions],
    },
    captures: captures.map(cloneCapture),
    pendingCount: captures.filter((capture) => !capture.handled).length,
  };
}

function persistClipboard(): void {
  utilityStore?.saveState(CLIPBOARD_SETTINGS_KEY, clipboardSettings);
  utilityStore?.saveState(CLIPBOARD_CAPTURES_KEY, captures.slice(0, clipboardSettings.maxHistory));
}

function broadcastClipboard(): void {
  broadcast('clipboard:changed', clipboardSnapshot());
}

function persistSiteJobsNow(): void {
  if (sitePersistTimer) {
    clearTimeout(sitePersistTimer);
    sitePersistTimer = null;
  }
  utilityStore?.saveState(SITE_GRABBER_JOBS_KEY, siteGrabber.list().slice(0, 20));
}

function scheduleSitePersistence(): void {
  if (sitePersistTimer) return;
  sitePersistTimer = setTimeout(() => {
    sitePersistTimer = null;
    persistSiteJobsNow();
  }, 750);
}

const siteGrabber = new SiteGrabberService((job) => {
  broadcast('site-grabber:changed', job);
  scheduleSitePersistence();
});

function normalizeCaptureHistory(value: unknown): ClipboardCapture[] {
  if (!Array.isArray(value)) return [];
  const output: ClipboardCapture[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') continue;
    const record = candidate as Partial<ClipboardCapture>;
    if (typeof record.id !== 'string' || !Array.isArray(record.urls) || typeof record.detectedAt !== 'string') continue;
    const capture: ClipboardCapture = {
      id: record.id,
      text: typeof record.text === 'string' ? record.text.slice(0, 4_096) : '',
      urls: record.urls.filter((url): url is string => typeof url === 'string'),
      detectedAt: record.detectedAt,
      handled: Boolean(record.handled),
      queuedJobIds: Array.isArray(record.queuedJobIds)
        ? record.queuedJobIds.filter((id): id is string => typeof id === 'string')
        : [],
    };
    if (typeof record.error === 'string' && record.error) capture.error = record.error;
    output.push(capture);
  }
  return output.slice(0, clipboardSettings.maxHistory);
}

async function queueCapture(capture: ClipboardCapture): Promise<void> {
  const queuedJobIds: string[] = [];
  const errors: string[] = [];
  for (const url of capture.urls) {
    try {
      const job = await createDownload({
        url,
        destination: '',
        source: 'clipboard',
        priority: 'normal',
      });
      queuedJobIds.push(job.id);
    } catch (error) {
      errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  capture.queuedJobIds = queuedJobIds;
  capture.handled = true;
  if (errors.length > 0) capture.error = errors.join(' | ');
  else delete capture.error;
}

async function handleClipboardDetection(detection: ClipboardDetection): Promise<void> {
  const capture: ClipboardCapture = {
    id: crypto.randomUUID(),
    text: detection.text.slice(0, 4_096),
    urls: [...detection.urls],
    detectedAt: detection.detectedAt,
    handled: false,
    queuedJobIds: [],
  };
  captures = [capture, ...captures].slice(0, clipboardSettings.maxHistory);
  if (clipboardSettings.autoEnqueue) await queueCapture(capture);
  persistClipboard();
  broadcastClipboard();
}

function requireCapture(id: string): ClipboardCapture {
  const capture = captures.find((item) => item.id === id);
  if (!capture) throw new Error(`Clipboard capture олдсонгүй: ${id}`);
  return capture;
}

async function enqueueClipboardCapture(id: string): Promise<ClipboardSnapshot> {
  const capture = requireCapture(id);
  if (!capture.handled || capture.queuedJobIds.length === 0) await queueCapture(capture);
  persistClipboard();
  broadcastClipboard();
  return clipboardSnapshot();
}

function dismissClipboardCapture(id: string): ClipboardSnapshot {
  captures = captures.filter((capture) => capture.id !== id);
  persistClipboard();
  broadcastClipboard();
  return clipboardSnapshot();
}

function clearClipboardHistory(): ClipboardSnapshot {
  captures = [];
  persistClipboard();
  broadcastClipboard();
  return clipboardSnapshot();
}

function updateClipboardSettings(update: ClipboardSettingsUpdate): ClipboardSnapshot {
  clipboardSettings = normalizeClipboardSettings(clipboardSettings, update);
  captures = captures.slice(0, clipboardSettings.maxHistory);
  clipboardMonitor?.updateSettings(clipboardSettings);
  persistClipboard();
  broadcastClipboard();
  return clipboardSnapshot();
}

async function enqueueSiteGrabberResources(request: SiteGrabberEnqueueRequest): Promise<SiteGrabberEnqueueResult> {
  const snapshot = siteGrabber.get(request.grabberJobId);
  const selectedIds = request.resourceIds ? new Set(request.resourceIds) : null;
  const targets = snapshot.resources.filter((resource) =>
    !resource.queued && (!selectedIds || selectedIds.has(resource.id)),
  );
  const result: SiteGrabberEnqueueResult = {
    queued: 0,
    rejected: [],
    job: snapshot,
  };

  for (const resource of targets) {
    try {
      const createRequest: DownloadCreateRequest = {
        url: resource.url,
        filename: resource.filename,
        destination: snapshot.destination,
        source: 'site-grabber',
        sourcePageUrl: resource.sourcePageUrl,
        priority: snapshot.priority,
        connections: snapshot.connections,
      };
      if (snapshot.headers) createRequest.headers = { ...snapshot.headers };
      const job = await createDownload(createRequest);
      siteGrabber.updateResource(snapshot.id, resource.id, { queued: true, jobId: job.id });
      result.queued += 1;
    } catch (error) {
      result.rejected.push({
        url: resource.url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  result.job = siteGrabber.get(snapshot.id);
  persistSiteJobsNow();
  return result;
}

function registerIpc(): void {
  ipcMain.handle('clipboard:get', (): ClipboardSnapshot => clipboardSnapshot());
  ipcMain.handle('clipboard:update-settings', (_event, update: ClipboardSettingsUpdate) => updateClipboardSettings(update));
  ipcMain.handle('clipboard:enqueue', (_event, id: string) => enqueueClipboardCapture(id));
  ipcMain.handle('clipboard:dismiss', (_event, id: string) => dismissClipboardCapture(id));
  ipcMain.handle('clipboard:clear', () => clearClipboardHistory());

  ipcMain.handle('site-grabber:start', (_event, request: SiteGrabberStartRequest) => siteGrabber.start(request));
  ipcMain.handle('site-grabber:list', (): SiteGrabberJob[] => siteGrabber.list());
  ipcMain.handle('site-grabber:get', (_event, id: string) => siteGrabber.get(id));
  ipcMain.handle('site-grabber:cancel', (_event, id: string) => siteGrabber.cancel(id));
  ipcMain.handle('site-grabber:enqueue', (_event, request: SiteGrabberEnqueueRequest) => enqueueSiteGrabberResources(request));
}

async function initialize(): Promise<void> {
  utilityStore = new JobStore(join(app.getPath('userData'), 'data', 'subutai.db'));
  const savedSettings = utilityStore.loadState<ClipboardSettingsUpdate>(CLIPBOARD_SETTINGS_KEY) ?? {};
  clipboardSettings = normalizeClipboardSettings(DEFAULT_CLIPBOARD_SETTINGS, savedSettings);
  captures = normalizeCaptureHistory(utilityStore.loadState<unknown>(CLIPBOARD_CAPTURES_KEY));
  const savedSiteJobs = utilityStore.loadState<SiteGrabberJob[]>(SITE_GRABBER_JOBS_KEY) ?? [];
  siteGrabber.restore(savedSiteJobs);

  clipboardMonitor = new ClipboardMonitor(clipboardSettings, handleClipboardDetection);
  clipboardMonitor.start();
  broadcastClipboard();
}

registerIpc();
void app.whenReady().then(initialize);

app.on('before-quit', () => {
  clipboardMonitor?.dispose();
  persistClipboard();
  persistSiteJobsNow();
  utilityStore?.close();
  utilityStore = null;
});
