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
export type QueuePriority = 'low' | 'normal' | 'high';
export type ProxyMode = 'off' | 'system' | 'manual';

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
  priority?: QueuePriority;
  scheduleId?: string;
  speedLimitBytesPerSecond?: number;
}

export interface BatchPreviewRequest {
  input: string;
  maxItems?: number;
}

export interface BatchPreviewResult {
  urls: string[];
  total: number;
  duplicateCount: number;
  invalidLines: string[];
  truncated: boolean;
}

export interface BatchCreateRequest extends BatchPreviewRequest {
  destination: string;
  connections?: number;
  priority?: QueuePriority;
  speedLimitBytesPerSecond?: number;
}

export interface BatchCreateResult {
  jobs: DownloadJob[];
  rejected: Array<{ url: string; error: string }>;
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
  priority?: QueuePriority;
  queueOrder?: number;
  scheduleId?: string;
  pausedByScheduler?: boolean;
  speedLimitBytesPerSecond?: number;
  engineTaskId?: string;
  error?: string;
}

export interface QueueSettings {
  maxConcurrentDownloads: number;
  schedulingEnabled: boolean;
  pauseOutsideSchedule: boolean;
}

export interface DownloadSchedule {
  id: string;
  name: string;
  enabled: boolean;
  days: number[];
  startTime: string;
  endTime: string;
  maxConcurrentDownloads?: number;
  createdAt: string;
  updatedAt: string;
}

export interface DownloadScheduleInput {
  id?: string;
  name: string;
  enabled: boolean;
  days: number[];
  startTime: string;
  endTime: string;
  maxConcurrentDownloads?: number;
}

export interface QueueSnapshot {
  settings: QueueSettings;
  schedules: DownloadSchedule[];
  activeScheduleIds: string[];
  allowedNow: boolean;
  runningCount: number;
  queuedCount: number;
  pausedCount: number;
}

export interface TransferSettings {
  globalSpeedLimitBytesPerSecond: number;
  defaultDownloadSpeedLimitBytesPerSecond: number;
  proxyMode: ProxyMode;
  proxyUrl: string;
  proxyUsername: string;
  proxyPasswordSet: boolean;
  retryMaxAttempts: number;
  retryBaseDelaySeconds: number;
  connectTimeoutSeconds: number;
  transferTimeoutSeconds: number;
}

export interface TransferSettingsUpdate {
  globalSpeedLimitBytesPerSecond?: number;
  defaultDownloadSpeedLimitBytesPerSecond?: number;
  proxyMode?: ProxyMode;
  proxyUrl?: string;
  proxyUsername?: string;
  proxyPassword?: string;
  clearProxyPassword?: boolean;
  retryMaxAttempts?: number;
  retryBaseDelaySeconds?: number;
  connectTimeoutSeconds?: number;
  transferTimeoutSeconds?: number;
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
  previewBatch(request: BatchPreviewRequest): Promise<BatchPreviewResult>;
  createBatchDownloads(request: BatchCreateRequest): Promise<BatchCreateResult>;
  probeMedia(request: MediaProbeRequest): Promise<MediaProbeResult>;
  pauseDownload(id: string): Promise<DownloadJob>;
  resumeDownload(id: string): Promise<DownloadJob>;
  cancelDownload(id: string): Promise<DownloadJob>;
  removeDownload(id: string, deleteFile?: boolean): Promise<void>;
  openDownloadFolder(id: string): Promise<void>;
  setDownloadPriority(id: string, priority: QueuePriority): Promise<DownloadJob>;
  moveDownload(id: string, direction: 'up' | 'down' | 'top' | 'bottom'): Promise<DownloadJob[]>;
  getQueueSnapshot(): Promise<QueueSnapshot>;
  updateQueueSettings(settings: Partial<QueueSettings>): Promise<QueueSnapshot>;
  saveSchedule(schedule: DownloadScheduleInput): Promise<QueueSnapshot>;
  deleteSchedule(id: string): Promise<QueueSnapshot>;
  runQueueNow(): Promise<QueueSnapshot>;
  getTransferSettings(): Promise<TransferSettings>;
  updateTransferSettings(settings: TransferSettingsUpdate): Promise<TransferSettings>;
  getEngineHealth(): Promise<EngineHealth>;
  onDownloadsChanged(listener: (jobs: DownloadJob[]) => void): () => void;
  onQueueChanged(listener: (snapshot: QueueSnapshot) => void): () => void;
  onTransferSettingsChanged(listener: (settings: TransferSettings) => void): () => void;
  minimizeWindow(): Promise<void>;
  toggleMaximizeWindow(): Promise<void>;
  closeWindow(): Promise<void>;
}
