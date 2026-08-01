import { contextBridge, ipcRenderer } from 'electron';
import type {
  BatchCreateRequest,
  BatchCreateResult,
  BatchPreviewRequest,
  BatchPreviewResult,
  ClipboardSettingsUpdate,
  ClipboardSnapshot,
  DownloadCreateRequest,
  DownloadJob,
  DownloadScheduleInput,
  EngineHealth,
  MediaProbeRequest,
  MediaProbeResult,
  QueuePriority,
  QueueSettings,
  QueueSnapshot,
  SiteGrabberEnqueueRequest,
  SiteGrabberEnqueueResult,
  SiteGrabberJob,
  SiteGrabberStartRequest,
  SubutaiDesktopApi,
  TransferSettings,
  TransferSettingsUpdate,
} from '@subutai/shared';

const api: SubutaiDesktopApi = {
  listDownloads: (): Promise<DownloadJob[]> => ipcRenderer.invoke('downloads:list'),
  createDownload: (request: DownloadCreateRequest): Promise<DownloadJob> => ipcRenderer.invoke('downloads:create', request),
  previewBatch: (request: BatchPreviewRequest): Promise<BatchPreviewResult> => ipcRenderer.invoke('batch:preview', request),
  createBatchDownloads: (request: BatchCreateRequest): Promise<BatchCreateResult> => ipcRenderer.invoke('batch:create', request),
  probeMedia: (request: MediaProbeRequest): Promise<MediaProbeResult> => ipcRenderer.invoke('media:probe', request),
  getClipboardSnapshot: (): Promise<ClipboardSnapshot> => ipcRenderer.invoke('clipboard:get'),
  updateClipboardSettings: (settings: ClipboardSettingsUpdate): Promise<ClipboardSnapshot> => ipcRenderer.invoke('clipboard:update-settings', settings),
  enqueueClipboardCapture: (id: string): Promise<ClipboardSnapshot> => ipcRenderer.invoke('clipboard:enqueue', id),
  dismissClipboardCapture: (id: string): Promise<ClipboardSnapshot> => ipcRenderer.invoke('clipboard:dismiss', id),
  clearClipboardHistory: (): Promise<ClipboardSnapshot> => ipcRenderer.invoke('clipboard:clear'),
  startSiteGrabber: (request: SiteGrabberStartRequest): Promise<SiteGrabberJob> => ipcRenderer.invoke('site-grabber:start', request),
  listSiteGrabberJobs: (): Promise<SiteGrabberJob[]> => ipcRenderer.invoke('site-grabber:list'),
  getSiteGrabberJob: (id: string): Promise<SiteGrabberJob> => ipcRenderer.invoke('site-grabber:get', id),
  cancelSiteGrabber: (id: string): Promise<SiteGrabberJob> => ipcRenderer.invoke('site-grabber:cancel', id),
  enqueueSiteGrabberResources: (request: SiteGrabberEnqueueRequest): Promise<SiteGrabberEnqueueResult> => ipcRenderer.invoke('site-grabber:enqueue', request),
  pauseDownload: (id: string): Promise<DownloadJob> => ipcRenderer.invoke('downloads:pause', id),
  resumeDownload: (id: string): Promise<DownloadJob> => ipcRenderer.invoke('downloads:resume', id),
  cancelDownload: (id: string): Promise<DownloadJob> => ipcRenderer.invoke('downloads:cancel', id),
  removeDownload: (id: string, deleteFile = false): Promise<void> => ipcRenderer.invoke('downloads:remove', id, deleteFile),
  openDownloadFolder: (id: string): Promise<void> => ipcRenderer.invoke('downloads:open-folder', id),
  setDownloadPriority: (id: string, priority: QueuePriority): Promise<DownloadJob> => ipcRenderer.invoke('downloads:priority', id, priority),
  moveDownload: (id: string, direction: 'up' | 'down' | 'top' | 'bottom'): Promise<DownloadJob[]> => ipcRenderer.invoke('downloads:move', id, direction),
  getQueueSnapshot: (): Promise<QueueSnapshot> => ipcRenderer.invoke('queue:get'),
  updateQueueSettings: (settings: Partial<QueueSettings>): Promise<QueueSnapshot> => ipcRenderer.invoke('queue:settings', settings),
  saveSchedule: (schedule: DownloadScheduleInput): Promise<QueueSnapshot> => ipcRenderer.invoke('queue:schedule-save', schedule),
  deleteSchedule: (id: string): Promise<QueueSnapshot> => ipcRenderer.invoke('queue:schedule-delete', id),
  runQueueNow: (): Promise<QueueSnapshot> => ipcRenderer.invoke('queue:run-now'),
  getTransferSettings: (): Promise<TransferSettings> => ipcRenderer.invoke('transfer-settings:get'),
  updateTransferSettings: (settings: TransferSettingsUpdate): Promise<TransferSettings> => ipcRenderer.invoke('transfer-settings:update', settings),
  getEngineHealth: (): Promise<EngineHealth> => ipcRenderer.invoke('engines:health'),
  onDownloadsChanged: (listener: (jobs: DownloadJob[]) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, jobs: DownloadJob[]): void => listener(jobs);
    ipcRenderer.on('downloads:changed', handler);
    return () => ipcRenderer.removeListener('downloads:changed', handler);
  },
  onQueueChanged: (listener: (snapshot: QueueSnapshot) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: QueueSnapshot): void => listener(snapshot);
    ipcRenderer.on('queue:changed', handler);
    return () => ipcRenderer.removeListener('queue:changed', handler);
  },
  onTransferSettingsChanged: (listener: (settings: TransferSettings) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, settings: TransferSettings): void => listener(settings);
    ipcRenderer.on('transfer-settings:changed', handler);
    return () => ipcRenderer.removeListener('transfer-settings:changed', handler);
  },
  onClipboardChanged: (listener: (snapshot: ClipboardSnapshot) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: ClipboardSnapshot): void => listener(snapshot);
    ipcRenderer.on('clipboard:changed', handler);
    return () => ipcRenderer.removeListener('clipboard:changed', handler);
  },
  onSiteGrabberChanged: (listener: (job: SiteGrabberJob) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, job: SiteGrabberJob): void => listener(job);
    ipcRenderer.on('site-grabber:changed', handler);
    return () => ipcRenderer.removeListener('site-grabber:changed', handler);
  },
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: (): Promise<void> => ipcRenderer.invoke('window:toggle-maximize'),
  closeWindow: (): Promise<void> => ipcRenderer.invoke('window:close'),
};

contextBridge.exposeInMainWorld('subutai', api);
