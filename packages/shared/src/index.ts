export type DownloadEngine = 'auto' | 'subutai' | 'media';

export type DownloadStatus =
  | 'queued'
  | 'resolving'
  | 'downloading'
  | 'paused'
  | 'merging'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type DownloadSource = 'desktop' | 'chrome' | 'edge' | 'firefox' | 'clipboard' | 'batch' | 'site-grabber';

export interface DownloadRequestHeaders {
  [name: string]: string;
}

export interface DownloadCreateRequest {
  url: string;
  filename?: string;
  destination: string;
  engine?: DownloadEngine;
  connections?: number;
  headers?: DownloadRequestHeaders;
  source?: DownloadSource;
  sourcePageUrl?: string;
}

export interface BrowserEnqueueMessage {
  type: 'enqueue';
  requestId: string;
  url: string;
  filename?: string;
  headers?: DownloadRequestHeaders;
  source: 'chrome' | 'edge' | 'firefox';
  sourcePageUrl?: string;
  connections?: number;
}

export interface BrowserPingMessage {
  type: 'ping';
  requestId: string;
}

export type BrowserNativeMessage = BrowserEnqueueMessage | BrowserPingMessage;

export interface BrowserNativeResponse {
  ok: boolean;
  requestId: string;
  accepted?: number;
  error?: string;
}

export interface DownloadJob {
  id: string;
  url: string;
  filename: string;
  destination: string;
  engine: DownloadEngine;
  status: DownloadStatus;
  downloadedBytes: number;
  totalBytes: number | null;
  speedBytesPerSecond: number;
  etaSeconds: number | null;
  connections: number;
  createdAt: string;
  updatedAt: string;
  source?: DownloadSource;
  sourcePageUrl?: string;
  headers?: DownloadRequestHeaders;
  engineTaskId?: string;
  error?: string;
}

export interface SubutaiEngineHealth {
  available: boolean;
  running: boolean;
  version?: string;
  error?: string;
}

export interface EngineHealth {
  subutai: SubutaiEngineHealth;
}

export interface SubutaiDesktopApi {
  listDownloads(): Promise<DownloadJob[]>;
  createDownload(request: DownloadCreateRequest): Promise<DownloadJob>;
  pauseDownload(id: string): Promise<DownloadJob>;
  resumeDownload(id: string): Promise<DownloadJob>;
  cancelDownload(id: string): Promise<DownloadJob>;
  removeDownload(id: string, deleteFile?: boolean): Promise<void>;
  openDownloadFolder(id: string): Promise<void>;
  getEngineHealth(): Promise<EngineHealth>;
  onDownloadsChanged(listener: (jobs: DownloadJob[]) => void): () => void;
  minimizeWindow(): Promise<void>;
  toggleMaximizeWindow(): Promise<void>;
  closeWindow(): Promise<void>;
}
