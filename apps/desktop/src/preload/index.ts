import { contextBridge, ipcRenderer } from 'electron';
import type { DownloadCreateRequest, DownloadJob, SubutaiDesktopApi } from '@subutai/shared';

const api: SubutaiDesktopApi = {
  listDownloads: (): Promise<DownloadJob[]> => ipcRenderer.invoke('downloads:list'),
  createDownload: (request: DownloadCreateRequest): Promise<DownloadJob> =>
    ipcRenderer.invoke('downloads:create', request),
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: (): Promise<void> => ipcRenderer.invoke('window:toggle-maximize'),
  closeWindow: (): Promise<void> => ipcRenderer.invoke('window:close'),
};

contextBridge.exposeInMainWorld('subutai', api);
