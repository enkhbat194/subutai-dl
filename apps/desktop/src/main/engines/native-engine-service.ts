import { app } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { TransferSettings } from '@subutai/shared';
import { DEFAULT_TRANSFER_SETTINGS } from '../network/transfer-policy';
import {
  NativeFrameDecoder,
  NativeMessageKind,
  decodeStatusPayload,
  encodeNativeFrame,
  encodeStartPayload,
  type NativeStatusPayload,
} from './native-engine-protocol';

export interface NativeEngineTaskStatus {
  gid: string;
  status: 'active' | 'waiting' | 'paused' | 'error' | 'complete' | 'removed';
  totalLength: string;
  completedLength: string;
  downloadSpeed: string;
  connections: string;
  errorCode?: string;
  errorMessage?: string;
  files?: Array<{ path: string; length: string; completedLength: string; selected: string }>;
}

interface NativeTaskRequest {
  url: string;
  destinationDirectory: string;
  filename: string;
  destinationPath: string;
  connections: number;
  headers: Record<string, string>;
  speedLimitBytesPerSecond?: number;
}

interface NativeTask {
  id: string;
  request: NativeTaskRequest;
  status: NativeEngineTaskStatus;
  child: ChildProcessWithoutNullStreams | null;
  decoder: NativeFrameDecoder;
  stderr: string;
  pauseRequested: boolean;
  cancelRequested: boolean;
}

const FORBIDDEN_FORWARD_HEADERS = new Set([
  'accept-encoding',
  'connection',
  'content-length',
  'host',
  'if-range',
  'proxy-connection',
  'range',
  'transfer-encoding',
]);

const CONTROL_TIMEOUT_MS = 12_000;
const STDERR_LIMIT = 16 * 1024;
const DEFAULT_MINIMUM_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_CHECKPOINT_BYTES = 256 * 1024;

export class NativeEngineService {
  private readonly tasks = new Map<string, NativeTask>();
  private requestSequence = 1n;
  private executable = '';
  private version = '';
  private lastError = '';
  private transferSettings: TransferSettings = { ...DEFAULT_TRANSFER_SETTINGS };
  private proxyPassword = '';

  async configure(settings: TransferSettings, proxyPassword: string): Promise<void> {
    this.transferSettings = { ...settings };
    this.proxyPassword = proxyPassword;
  }

  async addUri(
    url: string,
    options: {
      destination: string;
      filename?: string;
      connections: number;
      headers?: Record<string, string>;
      speedLimitBytesPerSecond?: number;
    },
  ): Promise<string> {
    const id = crypto.randomUUID();
    const filename = safeFilename(options.filename?.trim() || inferFilename(url));
    const destinationDirectory = resolve(options.destination);
    const destinationPath = join(destinationDirectory, filename);
    const request: NativeTaskRequest = {
      url,
      destinationDirectory,
      filename,
      destinationPath,
      connections: Math.max(1, Math.min(32, Math.trunc(options.connections))),
      headers: normalizeHeaders(options.headers),
    };
    if (typeof options.speedLimitBytesPerSecond === 'number' && options.speedLimitBytesPerSecond > 0) {
      request.speedLimitBytesPerSecond = Math.trunc(options.speedLimitBytesPerSecond);
    }
    const task: NativeTask = {
      id,
      request,
      status: initialStatus(id, destinationPath),
      child: null,
      decoder: new NativeFrameDecoder(),
      stderr: '',
      pauseRequested: false,
      cancelRequested: false,
    };
    this.tasks.set(id, task);
    try {
      await this.startTask(task);
      return id;
    } catch (error) {
      this.tasks.delete(id);
      throw error;
    }
  }

  async tellStatus(id: string): Promise<NativeEngineTaskStatus> {
    const task = this.getTask(id);
    return cloneStatus(task.status);
  }

  async pause(id: string): Promise<void> {
    const task = this.getTask(id);
    if (['paused', 'complete', 'removed', 'error'].includes(task.status.status)) return;
    task.pauseRequested = true;
    if (task.child) {
      this.sendControl(task, NativeMessageKind.PauseRequest);
      const stopped = await this.waitForStatus(task, new Set(['paused', 'complete', 'error', 'removed']));
      if (!stopped && task.child) {
        task.child.kill();
        task.child = null;
        task.status = { ...task.status, status: 'paused', downloadSpeed: '0', connections: '0' };
      }
    } else {
      task.status = { ...task.status, status: 'paused', downloadSpeed: '0', connections: '0' };
    }
  }

  async resume(id: string): Promise<void> {
    const task = this.getTask(id);
    if (task.child || task.status.status === 'complete' || task.status.status === 'removed') return;
    task.pauseRequested = false;
    task.cancelRequested = false;
    task.stderr = '';
    task.decoder = new NativeFrameDecoder();
    const resumedStatus: NativeEngineTaskStatus = {
      ...task.status,
      status: 'waiting',
      downloadSpeed: '0',
      connections: '0',
    };
    delete resumedStatus.errorCode;
    delete resumedStatus.errorMessage;
    task.status = resumedStatus;
    await this.startTask(task);
  }

  async cancel(id: string): Promise<void> {
    const task = this.getTask(id);
    if (task.status.status === 'removed') return;
    task.cancelRequested = true;
    if (task.child) {
      this.sendControl(task, NativeMessageKind.CancelRequest);
      const stopped = await this.waitForStatus(task, new Set(['removed', 'complete', 'error']));
      if (!stopped && task.child) task.child.kill();
      task.child = null;
    }
    await this.removeTaskFiles(task.request.destinationPath);
    const removedStatus: NativeEngineTaskStatus = {
      ...task.status,
      status: 'removed',
      downloadSpeed: '0',
      connections: '0',
    };
    delete removedStatus.errorCode;
    delete removedStatus.errorMessage;
    task.status = removedStatus;
  }

  async stop(): Promise<void> {
    const active = Array.from(this.tasks.values()).filter((task) => task.child);
    await Promise.all(active.map(async (task) => {
      try {
        await this.pause(task.id);
      } catch {
        task.child?.kill();
        task.child = null;
      }
    }));
  }

  getHealth(): {
    available: boolean;
    running: boolean;
    executable: string;
    version?: string;
    error?: string;
  } {
    const executable = this.executable || this.resolveExecutable();
    const health: {
      available: boolean;
      running: boolean;
      executable: string;
      version?: string;
      error?: string;
    } = {
      available: existsSync(executable),
      running: Array.from(this.tasks.values()).some((task) => Boolean(task.child)),
      executable,
    };
    if (this.version) health.version = this.version;
    if (this.lastError) health.error = this.lastError;
    return health;
  }

  private async startTask(task: NativeTask): Promise<void> {
    const executable = this.resolveExecutable();
    if (!existsSync(executable)) {
      throw new Error(`Subutai native engine host was not found: ${executable}`);
    }
    this.executable = executable;
    const child = spawn(executable, [], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    task.child = child;
    task.decoder = new NativeFrameDecoder();
    task.stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      try {
        for (const frame of task.decoder.push(chunk)) {
          if (frame.kind === NativeMessageKind.HelloAck) {
            this.version = frame.payload.toString('utf8').trim();
            this.lastError = '';
          } else if (frame.kind === NativeMessageKind.StatusEvent) {
            this.applyStatus(task, decodeStatusPayload(frame.payload));
          }
        }
      } catch (error) {
        this.failTask(task, `Native IPC decode failed: ${errorMessage(error)}`);
        child.kill();
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      task.stderr = `${task.stderr}${chunk.toString('utf8')}`.slice(-STDERR_LIMIT);
    });

    const spawned = new Promise<void>((resolveSpawn, rejectSpawn) => {
      let settled = false;
      child.once('spawn', () => {
        if (settled) return;
        settled = true;
        try {
          const payload = encodeStartPayload({
            taskId: task.id,
            url: task.request.url,
            destination: task.request.destinationPath,
            maximumConnections: task.request.connections,
            minimumChunkBytes: BigInt(DEFAULT_MINIMUM_CHUNK_BYTES),
            checkpointBytes: BigInt(DEFAULT_CHECKPOINT_BYTES),
            headers: task.request.headers,
          });
          child.stdin.write(encodeNativeFrame(this.nextRequestId(), NativeMessageKind.StartRequest, payload));
          resolveSpawn();
        } catch (error) {
          rejectSpawn(error);
          child.kill();
        }
      });
      child.once('error', (error) => {
        this.lastError = error.message;
        if (!settled) {
          settled = true;
          rejectSpawn(error);
        } else {
          this.failTask(task, error.message);
        }
      });
    });

    child.once('exit', (code) => {
      task.child = null;
      const current = task.status.status;
      if (['paused', 'complete', 'removed', 'error'].includes(current)) return;
      if (task.cancelRequested) {
        task.status = { ...task.status, status: 'removed', downloadSpeed: '0', connections: '0' };
        return;
      }
      if (task.pauseRequested) {
        task.status = { ...task.status, status: 'paused', downloadSpeed: '0', connections: '0' };
        return;
      }
      const details = task.stderr.trim() || `Subutai native engine exited with code ${String(code)}`;
      this.failTask(task, details);
    });

    await spawned;
  }

  private applyStatus(task: NativeTask, event: NativeStatusPayload): void {
    if (event.taskId !== task.id) {
      this.failTask(task, `Native status task mismatch: ${event.taskId}`);
      return;
    }
    const status: NativeEngineTaskStatus = {
      gid: task.id,
      status: event.state,
      totalLength: event.totalBytes.toString(),
      completedLength: event.completedBytes.toString(),
      downloadSpeed: event.bytesPerSecond.toString(),
      connections: String(event.activeConnections),
      files: [{
        path: event.filePath || task.request.destinationPath,
        length: event.totalBytes.toString(),
        completedLength: event.completedBytes.toString(),
        selected: 'true',
      }],
    };
    if (event.errorCode) status.errorCode = event.errorCode;
    if (event.errorMessage) status.errorMessage = event.errorMessage;
    task.status = status;
    if (event.state === 'error') this.lastError = event.errorMessage;
  }

  private failTask(task: NativeTask, message: string): void {
    this.lastError = message;
    task.status = {
      ...task.status,
      status: 'error',
      downloadSpeed: '0',
      connections: '0',
      errorCode: 'NATIVE_ENGINE',
      errorMessage: message,
    };
  }

  private sendControl(task: NativeTask, kind: NativeMessageKind): void {
    const child = task.child;
    if (!child || child.stdin.destroyed) return;
    child.stdin.write(encodeNativeFrame(this.nextRequestId(), kind));
  }

  private async waitForStatus(task: NativeTask, accepted: ReadonlySet<NativeEngineTaskStatus['status']>): Promise<boolean> {
    const deadline = Date.now() + CONTROL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (accepted.has(task.status.status)) return true;
      if (!task.child) return accepted.has(task.status.status);
      await delay(25);
    }
    return false;
  }

  private getTask(id: string): NativeTask {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Subutai native task not found: ${id}`);
    return task;
  }

  private nextRequestId(): bigint {
    const value = this.requestSequence;
    this.requestSequence = this.requestSequence >= 0xffff_ffff_ffff_ffffn ? 1n : this.requestSequence + 1n;
    return value;
  }

  private resolveExecutable(): string {
    const configured = process.env.SUBUTAI_NATIVE_ENGINE_PATH?.trim();
    if (configured) return resolve(configured);
    const binary = process.platform === 'win32' ? 'subutai-engine-host.exe' : 'subutai-engine-host';
    const candidates = [
      app.isPackaged ? join(process.resourcesPath, 'engines', binary) : '',
      resolve(process.cwd(), 'engines', 'native', 'target', 'release', binary),
      resolve(process.cwd(), 'engines', 'native', 'target', 'debug', binary),
      resolve(app.getAppPath(), '..', '..', 'engines', 'native', 'target', 'release', binary),
      resolve(app.getAppPath(), '..', '..', 'engines', 'native', 'target', 'debug', binary),
      resolve(app.getAppPath(), 'resources', 'engines', binary),
    ].filter(Boolean);
    return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0] ?? binary;
  }

  private async removeTaskFiles(destinationPath: string): Promise<void> {
    const paths = [
      `${destinationPath}.subutai.part`,
      `${destinationPath}.subutai.job`,
      `${destinationPath}.subutai.job.a`,
      `${destinationPath}.subutai.job.b`,
    ];
    await Promise.all(paths.map((path) => rm(path, { force: true })));
  }
}

function initialStatus(id: string, destinationPath: string): NativeEngineTaskStatus {
  return {
    gid: id,
    status: 'waiting',
    totalLength: '0',
    completedLength: '0',
    downloadSpeed: '0',
    connections: '0',
    files: [{
      path: destinationPath,
      length: '0',
      completedLength: '0',
      selected: 'true',
    }],
  };
}

function cloneStatus(status: NativeEngineTaskStatus): NativeEngineTaskStatus {
  const clone: NativeEngineTaskStatus = { ...status };
  if (status.files) clone.files = status.files.map((file) => ({ ...file }));
  return clone;
}

function normalizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([name, value]) => !FORBIDDEN_FORWARD_HEADERS.has(name.toLowerCase()) && value.trim().length > 0)
      .map(([name, value]) => [name, value.replace(/[\r\n\0]+/gu, ' ').trim()]),
  );
}

function inferFilename(url: string): string {
  try {
    const parsed = new URL(url);
    return decodeURIComponent(parsed.pathname.split('/').filter(Boolean).at(-1) ?? 'download');
  } catch {
    return 'download';
  }
}

function safeFilename(value: string): string {
  const leaf = basename(value).replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').trim();
  if (!leaf || leaf === '.' || leaf === '..') return 'download';
  return leaf.slice(0, 240);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
