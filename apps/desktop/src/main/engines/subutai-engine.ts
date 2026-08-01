import type {
  DownloadRequestHeaders,
  MediaDownloadOptions,
  MediaProbeResult,
  SubutaiEngineHealth,
} from '@subutai/shared';
import { Aria2Service, type Aria2TaskStatus } from './aria2-service';
import { MediaService } from './media-service';

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

  async addDownload(options: {
    url: string;
    destination: string;
    filename?: string;
    connections: number;
    headers?: DownloadRequestHeaders;
    sourcePageUrl?: string;
    media?: MediaDownloadOptions;
  }): Promise<string> {
    if (options.media) {
      const mediaOptions: {
        url: string;
        destination: string;
        options: MediaDownloadOptions;
        filename?: string;
        headers?: DownloadRequestHeaders;
        sourcePageUrl?: string;
      } = {
        url: options.url,
        destination: options.destination,
        options: options.media,
      };
      if (options.filename) mediaOptions.filename = options.filename;
      if (options.headers) mediaOptions.headers = options.headers;
      if (options.sourcePageUrl) mediaOptions.sourcePageUrl = options.sourcePageUrl;
      return `media:${await this.mediaEngine.addDownload(mediaOptions)}`;
    }

    const directOptions: {
      destination: string;
      filename?: string;
      connections: number;
      headers?: DownloadRequestHeaders;
    } = {
      destination: options.destination,
      connections: options.connections,
    };
    if (options.filename) directOptions.filename = options.filename;
    if (options.headers) directOptions.headers = options.headers;
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
      phase: status.phase,
    };
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
    if (status.error) result.errorMessage = status.error;
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
    const errors = [direct.error, media.error].filter(Boolean).map((message) => this.toPublicError(String(message)));
    if (errors.length > 0) result.error = errors.join(' | ');
    return result;
  }

  private toPublicError(message: string): string {
    return message
      .replaceAll(/aria2c/gi, 'Subutai Engine')
      .replaceAll(/aria2/gi, 'Subutai Engine')
      .replaceAll(/yt-dlp(?:\.exe)?/gi, 'Subutai Media')
      .replaceAll(/ffmpeg(?:\.exe)?/gi, 'Subutai Media');
  }
}
