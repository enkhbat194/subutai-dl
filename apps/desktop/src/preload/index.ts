import { contextBridge, ipcRenderer } from 'electron';
import type {
  DownloadCreateRequest,
  DownloadJob,
  EngineHealth,
  MediaProbeRequest,
  MediaProbeResult,
  SubutaiDesktopApi,
} from '@subutai/shared';

const api: SubutaiDesktopApi = {
  listDownloads: (): Promise<DownloadJob[]> => ipcRenderer.invoke('downloads:list'),
  createDownload: (request: DownloadCreateRequest): Promise<DownloadJob> =>
    ipcRenderer.invoke('downloads:create', request),
  probeMedia: (request: MediaProbeRequest): Promise<MediaProbeResult> => ipcRenderer.invoke('media:probe', request),
  pauseDownload: (id: string): Promise<DownloadJob> => ipcRenderer.invoke('downloads:pause', id),
  resumeDownload: (id: string): Promise<DownloadJob> => ipcRenderer.invoke('downloads:resume', id),
  cancelDownload: (id: string): Promise<DownloadJob> => ipcRenderer.invoke('downloads:cancel', id),
  removeDownload: (id: string, deleteFile = false): Promise<void> =>
    ipcRenderer.invoke('downloads:remove', id, deleteFile),
  openDownloadFolder: (id: string): Promise<void> => ipcRenderer.invoke('downloads:open-folder', id),
  getEngineHealth: (): Promise<EngineHealth> => ipcRenderer.invoke('engines:health'),
  onDownloadsChanged: (listener: (jobs: DownloadJob[]) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, jobs: DownloadJob[]): void => listener(jobs);
    ipcRenderer.on('downloads:changed', handler);
    return () => ipcRenderer.removeListener('downloads:changed', handler);
  },
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: (): Promise<void> => ipcRenderer.invoke('window:toggle-maximize'),
  closeWindow: (): Promise<void> => ipcRenderer.invoke('window:close'),
};

contextBridge.exposeInMainWorld('subutai', api);
