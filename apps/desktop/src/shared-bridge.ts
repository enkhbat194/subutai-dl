import type {
  DownloadRequestHeaders,
  QueuePriority,
} from '../../../packages/shared/src/index';

export * from '../../../packages/shared/src/index';

export interface ClipboardSettings {
  enabled: boolean;
  autoEnqueue: boolean;
  captureMultipleUrls: boolean;
  cooldownMs: number;
  maxHistory: number;
  ignoredHosts: string[];
  ignoredExtensions: string[];
}

export interface ClipboardSettingsUpdate extends Partial<ClipboardSettings> {}

export interface ClipboardCapture {
  id: string;
  text: string;
  urls: string[];
  detectedAt: string;
  handled: boolean;
  queuedJobIds: string[];
  error?: string;
}

export interface ClipboardSnapshot {
  settings: ClipboardSettings;
  captures: ClipboardCapture[];
  pendingCount: number;
}

export type SiteGrabberStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';
export type SiteResourceKind = 'document' | 'archive' | 'image' | 'audio' | 'video' | 'software' | 'font' | 'other';

export interface SiteGrabberStartRequest {
  rootUrl: string;
  destination: string;
  maxDepth?: number;
  maxPages?: number;
  maxResources?: number;
  sameHostOnly?: boolean;
  includeSubdomains?: boolean;
  includeExtensions?: string[];
  excludePatterns?: string[];
  headers?: DownloadRequestHeaders;
  priority?: QueuePriority;
  connections?: number;
}

export interface SiteGrabberResource {
  id: string;
  url: string;
  sourcePageUrl: string;
  filename: string;
  extension: string;
  kind: SiteResourceKind;
  depth: number;
  queued: boolean;
  jobId?: string;
}

export interface SiteGrabberJob {
  id: string;
  rootUrl: string;
  destination: string;
  status: SiteGrabberStatus;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  maxDepth: number;
  maxPages: number;
  maxResources: number;
  sameHostOnly: boolean;
  includeSubdomains: boolean;
  includeExtensions: string[];
  excludePatterns: string[];
  headers?: DownloadRequestHeaders;
  priority: QueuePriority;
  connections: number;
  scannedPages: number;
  pendingPages: number;
  resources: SiteGrabberResource[];
  errors: Array<{ url: string; error: string }>;
  error?: string;
}

export interface SiteGrabberEnqueueRequest {
  grabberJobId: string;
  resourceIds?: string[];
}

export interface SiteGrabberEnqueueResult {
  queued: number;
  rejected: Array<{ url: string; error: string }>;
  job: SiteGrabberJob;
}

declare module '../../../packages/shared/src/index' {
  interface SubutaiDesktopApi {
    getClipboardSnapshot(): Promise<ClipboardSnapshot>;
    updateClipboardSettings(settings: ClipboardSettingsUpdate): Promise<ClipboardSnapshot>;
    enqueueClipboardCapture(id: string): Promise<ClipboardSnapshot>;
    dismissClipboardCapture(id: string): Promise<ClipboardSnapshot>;
    clearClipboardHistory(): Promise<ClipboardSnapshot>;
    startSiteGrabber(request: SiteGrabberStartRequest): Promise<SiteGrabberJob>;
    listSiteGrabberJobs(): Promise<SiteGrabberJob[]>;
    getSiteGrabberJob(id: string): Promise<SiteGrabberJob>;
    cancelSiteGrabber(id: string): Promise<SiteGrabberJob>;
    enqueueSiteGrabberResources(request: SiteGrabberEnqueueRequest): Promise<SiteGrabberEnqueueResult>;
    onClipboardChanged(listener: (snapshot: ClipboardSnapshot) => void): () => void;
    onSiteGrabberChanged(listener: (job: SiteGrabberJob) => void): () => void;
  }
}
