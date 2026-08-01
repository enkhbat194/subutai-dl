export type DownloadEngine = 'auto' | 'aria2' | 'yt-dlp';

export type DownloadStatus =
  | 'queued'
  | 'resolving'
  | 'downloading'
  | 'paused'
  | 'merging'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface DownloadCreateRequest {
  url: string;
  filename?: string;
  destination: string;
  engine?: DownloadEngine;
  connections?: number;
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
  engineTaskId?: string;
  error?: string;
}

export interface Aria2EngineHealth {
  available: boolean;
  running: boolean;
  executable: string;
  version?: string;
  error?: string;
}

export interface EngineHealth {
  aria2: Aria2EngineHealth;
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
