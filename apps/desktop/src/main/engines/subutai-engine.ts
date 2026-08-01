import type {
  DownloadRequestHeaders,
  MediaDownloadOptions,
  MediaProbeResult,
  SubutaiEngineHealth,
  TransferSettings,
} from '@subutai/shared';
import { Aria2Service } from './aria2-service';
import { MediaService } from './media-service';
import { toPublicError } from './public-error';

export interface SubutaiTaskStatus {
  gid: string;
  status: 'active' | 'waiting' | 'paused' | 'error' | 'complete' | 'removed';
  totalLength: string;
  completedLength: string;
  downloadSpeed: string;
  connections: string;
  errorCode?: string;
  errorMessage?: string;
  files?: Array<{ path: string; length: string; completedLength: string; selected: string }>;
  displayName?: string;
  playlistIndex?: number;
  playlistCount?: number;
  phase?: 'resolving' | 'downloading' | 'merging';
}

function isMediaTask(taskId: string): boolean {
  return taskId.startsWith('media:');
}

function directId(taskId: string): string {
  return taskId.startsWith('direct:') ? taskId.slice('direct:'.length) : taskId;
}

function mediaId(taskId: string): string {
  return taskId.slice('media:'.length);
}

export class SubutaiEngine {
  private readonly directEngine = new Aria2Service();
  private readonly mediaEngine = new MediaService();

  async configureTransfer(settings: TransferSettings, proxyPassword: string): Promise<void> {
    this.mediaEngine.configure(settings, proxyPassword);
    await this.directEngine.configure(settings, proxyPassword);
  }

  async addDownload(options: {
    url: string;
    destination: string;
    filename?: string;
    connections: number;
    headers?: DownloadRequestHeaders;
    sourcePageUrl?: string;
    media?: MediaDownloadOptions;
    speedLimitBytesPerSecond?: number;
  }): Promise<string> {
    if (options.media) {
      const mediaOptions: {
        url: string;
        destination: string;
        options: MediaDownloadOptions;
        filename?: string;
        headers?: DownloadRequestHeaders;
        sourcePageUrl?: string;
        speedLimitBytesPerSecond?: number;
      } = {
        url: options.url,
        destination: options.destination,
        options: options.media,
      };
      if (options.filename) mediaOptions.filename = options.filename;
      if (options.headers) mediaOptions.headers = options.headers;
      if (options.sourcePageUrl) mediaOptions.sourcePageUrl = options.sourcePageUrl;
      if (typeof options.speedLimitBytesPerSecond === 'number') mediaOptions.speedLimitBytesPerSecond = options.speedLimitBytesPerSecond;
      return `media:${await this.mediaEngine.addDownload(mediaOptions)}`;
    }

    const directOptions: {
      destination: string;
      filename?: string;
      connections: number;
      headers?: DownloadRequestHeaders;
      speedLimitBytesPerSecond?: number;
    } = {
      destination: options.destination,
      connections: options.connections,
    };
    if (options.filename) directOptions.filename = options.filename;
    if (options.headers) directOptions.headers = options.headers;
    if (typeof options.speedLimitBytesPerSecond === 'number') directOptions.speedLimitBytesPerSecond = options.speedLimitBytesPerSecond;
    return `direct:${await this.directEngine.addUri(options.url, directOptions)}`;
  }

  async probeMedia(url: string, headers?: DownloadRequestHeaders, sourcePageUrl?: string): Promise<MediaProbeResult> {
    return this.mediaEngine.probe(url, headers, sourcePageUrl);
  }

  async getStatus(taskId: string): Promise<SubutaiTaskStatus> {
    if (!isMediaTask(taskId)) return this.directEngine.tellStatus(directId(taskId));
    const status = this.mediaEngine.getStatus(mediaId(taskId));
    const result: SubutaiTaskStatus = {
      gid: taskId,
      status: status.status,
      totalLength: String(status.totalBytes),
      completedLength: String(status.downloadedBytes),
      downloadSpeed: String(status.speedBytesPerSecond),
      connections: '1',
    };
    if (status.phase) result.phase = status.phase;
    if (status.filename) {
      result.files = [{
        path: status.filename,
        length: String(status.totalBytes),
        completedLength: String(status.downloadedBytes),
        selected: 'true',
      }];
    }
    if (status.displayName) result.displayName = status.displayName;
    if (status.playlistIndex) result.playlistIndex = status.playlistIndex;
    if (status.playlistCount) result.playlistCount = status.playlistCount;
    if (status.error) result.errorMessage = toPublicError(status.error);
    return result;
  }

  async pause(taskId: string): Promise<void> {
    if (isMediaTask(taskId)) await this.mediaEngine.pause(mediaId(taskId));
    else await this.directEngine.pause(directId(taskId));
  }

  async resume(taskId: string): Promise<void> {
    if (isMediaTask(taskId)) await this.mediaEngine.resume(mediaId(taskId));
    else await this.directEngine.resume(directId(taskId));
  }

  async cancel(taskId: string): Promise<void> {
    if (isMediaTask(taskId)) await this.mediaEngine.cancel(mediaId(taskId));
    else await this.directEngine.cancel(directId(taskId));
  }

  async stop(): Promise<void> {
    await Promise.all([this.directEngine.stop(), this.mediaEngine.stop()]);
  }

  getHealth(): SubutaiEngineHealth {
    const direct = this.directEngine.getHealth();
    const media = this.mediaEngine.getHealth();
    const result: SubutaiEngineHealth = {
      available: direct.available || media.available,
      running: direct.running || media.running,
      mediaAvailable: media.available,
      mediaRunning: media.running,
    };
    if (direct.version) result.version = direct.version;
    if (media.version) result.mediaVersion = media.version;
    if (media.ffmpegVersion) result.ffmpegVersion = media.ffmpegVersion;
    const errors = [direct.error, media.error].filter(Boolean).map((message) => toPublicError(String(message)));
    if (errors.length > 0) result.error = errors.join(' | ');
    return result;
  }
}
