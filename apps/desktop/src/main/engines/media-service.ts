import { app } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type {
  DownloadRequestHeaders,
  MediaDownloadOptions,
  MediaProbeResult,
  TransferSettings,
} from '@subutai/shared';
import { DEFAULT_TRANSFER_SETTINGS, resolveProxyUrl, ytDlpSpeed } from '../network/transfer-policy';

export type MediaTaskState = 'waiting' | 'active' | 'paused' | 'complete' | 'error' | 'removed';

export interface MediaTaskStatus {
  id: string;
  status: MediaTaskState;
  totalBytes: number;
  downloadedBytes: number;
  speedBytesPerSecond: number;
  etaSeconds: number | null;
  filename?: string;
  displayName?: string;
  playlistIndex?: number;
  playlistCount?: number;
  phase?: 'resolving' | 'downloading' | 'merging';
  error?: string;
}

interface MediaTask {
  id: string;
  url: string;
  destination: string;
  filename?: string;
  headers?: DownloadRequestHeaders;
  sourcePageUrl?: string;
  speedLimitBytesPerSecond?: number;
  options: MediaDownloadOptions;
  process: ChildProcess | null;
  status: MediaTaskStatus;
  stderr: string[];
}

interface MediaServiceHealth {
  available: boolean;
  running: boolean;
  version?: string;
  ffmpegVersion?: string;
  error?: string;
}

function positiveNumber(value: string | undefined): number {
  if (!value || value === 'NA' || value === 'None') return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function optionalPositiveNumber(value: string | undefined): number | undefined {
  const parsed = positiveNumber(value);
  return parsed > 0 ? parsed : undefined;
}

function sanitizeHeader(name: string, value: string): string | null {
  const normalizedName = name.trim();
  const normalizedValue = value.replace(/[\r\n]+/g, ' ').trim();
  if (!normalizedName || !normalizedValue || normalizedName.includes(':')) return null;
  return `${normalizedName}:${normalizedValue}`;
}

function minimumPositive(...values: number[]): number {
  const positive = values.filter((value) => value > 0);
  return positive.length > 0 ? Math.min(...positive) : 0;
}

export class MediaService {
  private readonly tasks = new Map<string, MediaTask>();
  private ytDlpVersion = '';
  private ffmpegVersion = '';
  private lastError = '';
  private transferSettings: TransferSettings = { ...DEFAULT_TRANSFER_SETTINGS };
  private proxyPassword = '';

  configure(settings: TransferSettings, proxyPassword: string): void {
    this.transferSettings = { ...settings };
    this.proxyPassword = proxyPassword;
  }

  async probe(url: string, headers?: DownloadRequestHeaders, sourcePageUrl?: string): Promise<MediaProbeResult> {
    const args = [
      '--dump-single-json',
      '--skip-download',
      '--no-warnings',
      '--socket-timeout', String(this.transferSettings.connectTimeoutSeconds),
      '--extractor-retries', String(this.transferSettings.retryMaxAttempts),
    ];
    this.appendJavaScriptRuntime(args);
    this.appendTransferArguments(args, 0);
    this.appendRequestArguments(args, headers, sourcePageUrl);
    args.push(url);

    const payload = await this.captureJson(args);
    const entries = Array.isArray(payload.entries) ? payload.entries : [];
    const result: MediaProbeResult = {
      title: typeof payload.title === 'string' && payload.title.trim() ? payload.title : 'Media',
      isPlaylist: entries.length > 0 || payload._type === 'playlist',
    };
    if (entries.length > 0) result.entryCount = entries.length;
    if (typeof payload.uploader === 'string') result.uploader = payload.uploader;
    if (typeof payload.duration === 'number') result.durationSeconds = payload.duration;
    if (typeof payload.thumbnail === 'string') result.thumbnail = payload.thumbnail;
    if (typeof payload.webpage_url === 'string') result.webpageUrl = payload.webpage_url;
    return result;
  }

  async addDownload(input: {
    url: string;
    destination: string;
    filename?: string;
    headers?: DownloadRequestHeaders;
    sourcePageUrl?: string;
    speedLimitBytesPerSecond?: number;
    options: MediaDownloadOptions;
  }): Promise<string> {
    const id = crypto.randomUUID();
    const task: MediaTask = {
      id,
      url: input.url,
      destination: input.destination,
      options: { ...input.options },
      process: null,
      status: {
        id,
        status: 'waiting',
        totalBytes: 0,
        downloadedBytes: 0,
        speedBytesPerSecond: 0,
        etaSeconds: null,
        phase: 'resolving',
      },
      stderr: [],
    };
    if (input.filename) task.filename = input.filename;
    if (input.headers) task.headers = { ...input.headers };
    if (input.sourcePageUrl) task.sourcePageUrl = input.sourcePageUrl;
    if (typeof input.speedLimitBytesPerSecond === 'number') task.speedLimitBytesPerSecond = input.speedLimitBytesPerSecond;
    this.tasks.set(id, task);
    await this.startTask(task);
    return id;
  }

  getStatus(id: string): MediaTaskStatus {
    const task = this.requireTask(id);
    return { ...task.status };
  }

  async pause(id: string): Promise<void> {
    const task = this.requireTask(id);
    if (task.status.status === 'complete' || task.status.status === 'removed') return;
    task.status.status = 'paused';
    task.status.speedBytesPerSecond = 0;
    task.status.etaSeconds = null;
    task.process?.kill();
    task.process = null;
  }

  async resume(id: string): Promise<void> {
    const task = this.requireTask(id);
    if (task.status.status !== 'paused' && task.status.status !== 'error') return;
    task.status.status = 'waiting';
    delete task.status.error;
    task.stderr = [];
    await this.startTask(task);
  }

  async cancel(id: string): Promise<void> {
    const task = this.requireTask(id);
    task.status.status = 'removed';
    task.status.speedBytesPerSecond = 0;
    task.status.etaSeconds = null;
    task.process?.kill();
    task.process = null;
  }

  async stop(): Promise<void> {
    for (const task of this.tasks.values()) {
      task.process?.kill();
      task.process = null;
    }
  }

  getHealth(): MediaServiceHealth {
    const running = Array.from(this.tasks.values()).some((task) => task.process !== null);
    const ytDlpPath = this.resolveYtDlp();
    const ffmpegPath = this.resolveFfmpeg();
    const nodePath = this.resolveNode();
    const result: MediaServiceHealth = {
      available: this.looksAvailable(ytDlpPath) && this.looksAvailable(ffmpegPath) && this.looksAvailable(nodePath),
      running,
    };
    if (this.ytDlpVersion) result.version = this.ytDlpVersion;
    if (this.ffmpegVersion) result.ffmpegVersion = this.ffmpegVersion;
    if (this.lastError) result.error = this.lastError;
    return result;
  }

  private requireTask(id: string): MediaTask {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Media task not found: ${id}`);
    return task;
  }

  private async startTask(task: MediaTask): Promise<void> {
    if (task.process) return;
    const ytDlp = this.resolveYtDlp();
    const ffmpeg = this.resolveFfmpeg();
    const node = this.resolveNode();
    const args = this.buildDownloadArguments(task, ffmpeg, node);

    const child = spawn(ytDlp, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    task.process = child;
    task.status.status = 'active';
    task.status.phase = 'resolving';
    this.lastError = '';

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    let stdoutBuffer = '';
    child.stdout?.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) this.consumeOutputLine(task, line.trim());
    });
    child.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        task.stderr.push(trimmed);
        if (task.stderr.length > 24) task.stderr.shift();
      }
    });
    child.once('error', (error) => {
      task.process = null;
      task.status.status = 'error';
      task.status.error = this.publicError(error.message);
      this.lastError = task.status.error;
    });
    child.once('exit', (code) => {
      task.process = null;
      if (task.status.status === 'paused' || task.status.status === 'removed') return;
      if (code === 0) {
        task.status.status = 'complete';
        task.status.phase = 'downloading';
        task.status.speedBytesPerSecond = 0;
        task.status.etaSeconds = 0;
        if (task.status.totalBytes > 0) task.status.downloadedBytes = task.status.totalBytes;
      } else {
        const detail = this.preferredError(task.stderr);
        task.status.status = 'error';
        task.status.speedBytesPerSecond = 0;
        task.status.etaSeconds = null;
        task.status.error = this.publicError(detail || `Media process exited with code ${code ?? 'unknown'}`);
        this.lastError = task.status.error;
      }
    });

    void this.refreshVersions(ytDlp, ffmpeg);
  }

  private buildDownloadArguments(task: MediaTask, ffmpegPath: string, nodePath: string): string[] {
    const options = task.options;
    const quality = options.quality ?? 'best';
    const qualityHeight = quality === 'best' ? null : Number.parseInt(quality, 10);
    const retryDelay = Math.max(1, this.transferSettings.retryBaseDelaySeconds);
    const args = [
      '--newline',
      '--continue',
      '--part',
      '--socket-timeout', String(this.transferSettings.transferTimeoutSeconds),
      '--retries', String(this.transferSettings.retryMaxAttempts),
      '--fragment-retries', String(this.transferSettings.retryMaxAttempts),
      '--retry-sleep', `http:linear=${retryDelay}:30:${retryDelay}`,
      '--retry-sleep', `fragment:linear=${retryDelay}:30:${retryDelay}`,
      '--concurrent-fragments', '8',
      '--paths', task.destination,
      '--progress-template', 'download:SUBUTAI_PROGRESS|%(progress.downloaded_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress.status)s|%(info.title)s|%(info.playlist_index)s|%(info.playlist_count)s',
      '--print', 'after_move:SUBUTAI_FILE|%(filepath)s',
    ];
    this.appendJavaScriptRuntime(args, nodePath);
    this.appendFfmpegLocation(args, ffmpegPath);
    this.appendTransferArguments(args, task.speedLimitBytesPerSecond ?? 0);

    if (task.filename?.trim()) {
      const stem = task.filename.replace(/\.[^.]+$/, '');
      args.push('--output', `${stem}.%(ext)s`);
    } else if (options.playlist) {
      args.push('--output', '%(playlist_title)s/%(playlist_index)03d - %(title)s [%(id)s].%(ext)s');
    } else {
      args.push('--output', '%(title)s [%(id)s].%(ext)s');
    }

    if (options.mode === 'audio') {
      args.push('--format', 'bestaudio/best', '--extract-audio', '--audio-format', options.audioFormat ?? 'mp3', '--audio-quality', '0');
    } else {
      const format = qualityHeight
        ? `bestvideo[height<=${qualityHeight}]+bestaudio/best[height<=${qualityHeight}]/best`
        : 'bestvideo+bestaudio/best';
      args.push('--format', format, '--merge-output-format', 'mp4');
    }

    args.push(options.playlist ? '--yes-playlist' : '--no-playlist');
    if (options.subtitles) {
      const languages = options.subtitleLanguages?.filter(Boolean).join(',') || 'all,-live_chat';
      args.push('--write-subs', '--write-auto-subs', '--sub-langs', languages, '--convert-subs', 'srt');
      if (options.mode === 'video') args.push('--embed-subs');
    }
    if (options.embedMetadata !== false) args.push('--embed-metadata');
    if (options.embedThumbnail) args.push('--embed-thumbnail');

    this.appendRequestArguments(args, task.headers, task.sourcePageUrl);
    args.push(task.url);
    return args;
  }

  private appendJavaScriptRuntime(args: string[], nodePath = this.resolveNode()): void {
    const runtime = nodePath === basename(nodePath) && !existsSync(nodePath) ? 'node' : `node:${nodePath}`;
    args.push('--js-runtimes', runtime);
  }

  private appendTransferArguments(args: string[], taskSpeedLimit: number): void {
    const effectiveSpeed = minimumPositive(
      taskSpeedLimit,
      this.transferSettings.defaultDownloadSpeedLimitBytesPerSecond,
      this.transferSettings.globalSpeedLimitBytesPerSecond,
    );
    const speed = ytDlpSpeed(effectiveSpeed);
    if (speed) args.push('--limit-rate', speed);

    if (this.transferSettings.proxyMode === 'off') {
      args.push('--proxy', '');
      return;
    }
    if (this.transferSettings.proxyMode === 'manual') {
      const proxy = resolveProxyUrl(this.transferSettings, this.proxyPassword);
      if (proxy) args.push('--proxy', proxy);
    }
  }

  private appendFfmpegLocation(args: string[], ffmpegPath: string): void {
    if (ffmpegPath !== basename(ffmpegPath) || existsSync(ffmpegPath)) {
      args.push('--ffmpeg-location', dirname(ffmpegPath));
    }
  }

  private appendRequestArguments(args: string[], headers?: DownloadRequestHeaders, sourcePageUrl?: string): void {
    if (sourcePageUrl) args.push('--referer', sourcePageUrl);
    if (!headers) return;
    for (const [name, value] of Object.entries(headers)) {
      const lower = name.toLowerCase();
      if (lower === 'referer' || lower === 'referrer') {
        args.push('--referer', value);
      } else if (lower === 'user-agent') {
        args.push('--user-agent', value);
      } else if (lower === 'cookie') {
        args.push('--add-header', `Cookie:${value.replace(/[\r\n]+/g, ' ')}`);
      } else {
        const header = sanitizeHeader(name, value);
        if (header) args.push('--add-header', header);
      }
    }
  }

  private consumeOutputLine(task: MediaTask, line: string): void {
    if (line.startsWith('SUBUTAI_FILE|')) {
      const filePath = line.slice('SUBUTAI_FILE|'.length).trim();
      if (filePath) task.status.filename = basename(filePath);
      return;
    }
    if (!line.startsWith('SUBUTAI_PROGRESS|')) return;
    const [, downloaded, total, speed, eta, rawState, title, playlistIndex, playlistCount] = line.split('|');
    task.status.downloadedBytes = positiveNumber(downloaded);
    task.status.totalBytes = positiveNumber(total);
    task.status.speedBytesPerSecond = positiveNumber(speed);
    task.status.etaSeconds = optionalPositiveNumber(eta) ?? null;
    if (title && title !== 'NA') task.status.displayName = title;
    const parsedIndex = optionalPositiveNumber(playlistIndex);
    const parsedCount = optionalPositiveNumber(playlistCount);
    if (parsedIndex) task.status.playlistIndex = parsedIndex;
    if (parsedCount) task.status.playlistCount = parsedCount;
    task.status.phase = rawState?.toLowerCase().includes('post') ? 'merging' : 'downloading';
    task.status.status = 'active';
  }

  private async captureJson(args: string[]): Promise<Record<string, unknown>> {
    const executable = this.resolveYtDlp();
    return new Promise((resolvePromise, reject) => {
      const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
      child.once('error', (error) => reject(new Error(this.publicError(error.message))));
      child.once('exit', (code) => {
        if (code !== 0) {
          const detail = this.preferredError(stderr.split(/\r?\n/));
          reject(new Error(this.publicError(detail || `Media probe exited with code ${code ?? 'unknown'}`)));
          return;
        }
        try {
          resolvePromise(JSON.parse(stdout) as Record<string, unknown>);
        } catch {
          reject(new Error('Media мэдээллийг задлахад алдаа гарлаа.'));
        }
      });
    });
  }

  private resolveYtDlp(): string {
    return this.resolveBinary('SUBUTAI_YTDLP_PATH', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  }

  private resolveFfmpeg(): string {
    return this.resolveBinary('SUBUTAI_FFMPEG_PATH', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  }

  private resolveNode(): string {
    return this.resolveBinary('SUBUTAI_NODE_PATH', process.platform === 'win32' ? 'node.exe' : 'node');
  }

  private resolveBinary(environmentName: string, binary: string): string {
    const configured = process.env[environmentName]?.trim();
    if (configured) return configured;
    const platformDirectory = `${process.platform}-${process.arch}`;
    const candidates = [
      app.isPackaged ? join(process.resourcesPath, 'engines', binary) : '',
      resolve(process.cwd(), 'resources', 'engines', platformDirectory, binary),
      resolve(process.cwd(), 'resources', 'engines', binary),
      resolve(app.getAppPath(), 'resources', 'engines', platformDirectory, binary),
      resolve(app.getAppPath(), 'resources', 'engines', binary),
    ].filter(Boolean);
    return candidates.find((candidate) => existsSync(candidate)) ?? binary;
  }

  private looksAvailable(binary: string): boolean {
    return binary === basename(binary) || existsSync(binary);
  }

  private async refreshVersions(ytDlp: string, ffmpeg: string): Promise<void> {
    if (!this.ytDlpVersion) this.ytDlpVersion = await this.captureVersion(ytDlp, ['--version']);
    if (!this.ffmpegVersion) this.ffmpegVersion = await this.captureVersion(ffmpeg, ['-version']);
  }

  private captureVersion(executable: string, args: string[]): Promise<string> {
    return new Promise((resolvePromise) => {
      const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => { output += chunk; });
      child.stderr?.on('data', (chunk: string) => { output += chunk; });
      child.once('error', () => resolvePromise(''));
      child.once('exit', () => resolvePromise(output.split(/\r?\n/)[0]?.trim() ?? ''));
    });
  }

  private preferredError(lines: string[]): string {
    const useful = lines.map((line) => line.trim()).filter(Boolean);
    const explicit = [...useful].reverse().find((line) => /^ERROR:/i.test(line) || /\berror:/i.test(line));
    if (explicit) return explicit;
    const withoutWarnings = useful.filter((line) => !/^WARNING:/i.test(line) && !/deprecated/i.test(line));
    return (withoutWarnings.length > 0 ? withoutWarnings : useful).slice(-4).join(' | ');
  }

  private publicError(message: string): string {
    const normalized = message
      .replaceAll(/yt-dlp(?:\.exe)?/gi, 'Subutai Media')
      .replaceAll(/ffmpeg(?:\.exe)?/gi, 'Subutai Media')
      .replaceAll(/node(?:\.exe)?/gi, 'Subutai JavaScript Runtime');
    if (/sign in to confirm|not a bot|cookies-from-browser/i.test(normalized)) {
      return 'YouTube энэ видеонд нэвтрэлт шаардаж байна. Browser integration-оор дахин оролдох эсвэл өөр public видео туршина уу.';
    }
    if (/javascript runtime|js runtime|challenge solver/i.test(normalized)) {
      return 'YouTube боловсруулах JavaScript хөдөлгүүр эхэлсэнгүй. Subutai-г дахин нээгээд оролдоно уу.';
    }
    return normalized;
  }
}
