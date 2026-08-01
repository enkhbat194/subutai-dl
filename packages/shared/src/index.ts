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
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface SubutaiDesktopApi {
  listDownloads(): Promise<DownloadJob[]>;
  createDownload(request: DownloadCreateRequest): Promise<DownloadJob>;
}
