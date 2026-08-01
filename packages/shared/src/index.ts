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

export type MediaQuality = 'best' | '2160p' | '1440p' | '1080p' | '720p' | '480p';
export type MediaAudioFormat = 'mp3' | 'm4a' | 'opus' | 'flac' | 'wav';

export interface MediaDownloadOptions {
  mode: 'video' | 'audio';
  quality?: MediaQuality;
  audioFormat?: MediaAudioFormat;
  playlist?: boolean;
  subtitles?: boolean;
  subtitleLanguages?: string[];
  embedMetadata?: boolean;
  embedThumbnail?: boolean;
}

export interface MediaProbeRequest {
  url: string;
  headers?: DownloadRequestHeaders;
  sourcePageUrl?: string;
}

export interface MediaProbeResult {
  title: string;
  uploader?: string;
  durationSeconds?: number;
  thumbnail?: string;
  webpageUrl?: string;
  isPlaylist: boolean;
  entryCount?: number;
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
  media?: MediaDownloadOptions;
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
  media?: MediaDownloadOptions;
  playlistIndex?: number;
  playlistCount?: number;
  engineTaskId?: string;
  error?: string;
}

export interface SubutaiEngineHealth {
  available: boolean;
  running: boolean;
  version?: string;
  mediaAvailable?: boolean;
  mediaRunning?: boolean;
  mediaVersion?: string;
  ffmpegVersion?: string;
  error?: string;
}

export interface EngineHealth {
  subutai: SubutaiEngineHealth;
}

export interface SubutaiDesktopApi {
  listDownloads(): Promise<DownloadJob[]>;
  createDownload(request: DownloadCreateRequest): Promise<DownloadJob>;
  probeMedia(request: MediaProbeRequest): Promise<MediaProbeResult>;
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
