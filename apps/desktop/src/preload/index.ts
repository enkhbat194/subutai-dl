import { contextBridge, ipcRenderer } from 'electron';
import type { DownloadCreateRequest, DownloadJob, SubutaiDesktopApi } from '@subutai/shared';

const api: SubutaiDesktopApi = {
  listDownloads: (): Promise<DownloadJob[]> => ipcRenderer.invoke('downloads:list'),
  createDownload: (request: DownloadCreateRequest): Promise<DownloadJob> =>
    ipcRenderer.invoke('downloads:create', request),
};

contextBridge.exposeInMainWorld('subutai', api);
