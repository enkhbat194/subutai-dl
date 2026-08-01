import { app } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export interface Aria2FileStatus {
  path: string;
  length: string;
  completedLength: string;
  selected: string;
}

export interface Aria2TaskStatus {
  gid: string;
  status: 'active' | 'waiting' | 'paused' | 'error' | 'complete' | 'removed';
  totalLength: string;
  completedLength: string;
  downloadSpeed: string;
  connections: string;
  errorCode?: string;
  errorMessage?: string;
  files?: Aria2FileStatus[];
}

interface Aria2Version {
  version: string;
  enabledFeatures: string[];
}

interface JsonRpcResponse<T> {
  jsonrpc: '2.0';
  id: string;
  result?: T;
  error?: {
    code: number;
    message: string;
  };
}

export class Aria2Service {
  private child: ChildProcess | null = null;
  private startPromise: Promise<void> | null = null;
  private readonly secret = crypto.randomUUID().replaceAll('-', '');
  private readonly port = 16800 + (process.pid % 1000);
  private readonly endpoint = `http://127.0.0.1:${this.port}/jsonrpc`;
  private executable = '';
  private version = '';
  private lastError = '';

  async ensureStarted(): Promise<void> {
    if (this.child && this.version) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.start();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private resolveExecutable(): string {
    const configured = process.env.SUBUTAI_ARIA2_PATH?.trim();
    if (configured) return configured;

    const binary = process.platform === 'win32' ? 'aria2c.exe' : 'aria2c';
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

  private async start(): Promise<void> {
    this.executable = this.resolveExecutable();
    this.version = '';
    this.lastError = '';

    const child = spawn(
      this.executable,
      [
        '--enable-rpc=true',
        '--rpc-listen-all=false',
        `--rpc-listen-port=${this.port}`,
        `--rpc-secret=${this.secret}`,
        '--continue=true',
        '--max-concurrent-downloads=5',
        '--summary-interval=0',
        '--console-log-level=warn',
        '--download-result=hide',
        '--file-allocation=none',
        '--allow-overwrite=false',
        '--auto-file-renaming=true',
      ],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    this.child = child;
    let spawnError: Error | null = null;

    child.once('error', (error) => {
      spawnError = error;
      this.lastError = error.message;
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const message = chunk.toString().trim();
      if (message) this.lastError = message;
    });

    child.once('exit', (code) => {
      this.child = null;
      this.version = '';
      if (code !== 0 && code !== null) {
        this.lastError = `aria2c exited with code ${code}`;
      }
    });

    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (spawnError) {
        throw new Error(
          `aria2c was not found or could not start. Install aria2 or set SUBUTAI_ARIA2_PATH. ${spawnError.message}`,
        );
      }

      try {
        const version = await this.call<Aria2Version>('aria2.getVersion');
        this.version = version.version;
        this.lastError = '';
        return;
      } catch {
        await delay(100);
      }
    }

    child.kill();
    throw new Error(`aria2c did not open its JSON-RPC endpoint at ${this.endpoint}`);
  }

  async addUri(
    url: string,
    options: {
      destination: string;
      filename?: string;
      connections: number;
    },
  ): Promise<string> {
    await this.ensureStarted();

    const connections = Math.max(1, Math.min(16, Math.trunc(options.connections)));
    const ariaOptions: Record<string, string> = {
      dir: options.destination,
      continue: 'true',
      split: String(connections),
      'max-connection-per-server': String(connections),
      'min-split-size': '1M',
      'auto-file-renaming': 'true',
      'allow-overwrite': 'false',
    };

    if (options.filename?.trim()) ariaOptions.out = options.filename.trim();

    return this.call<string>('aria2.addUri', [[url], ariaOptions]);
  }

  async tellStatus(gid: string): Promise<Aria2TaskStatus> {
    await this.ensureStarted();
    return this.call<Aria2TaskStatus>('aria2.tellStatus', [gid, [
      'gid',
      'status',
      'totalLength',
      'completedLength',
      'downloadSpeed',
      'connections',
      'errorCode',
      'errorMessage',
      'files',
    ]]);
  }

  async pause(gid: string): Promise<void> {
    await this.ensureStarted();
    await this.call<string>('aria2.pause', [gid]);
  }

  async resume(gid: string): Promise<void> {
    await this.ensureStarted();
    await this.call<string>('aria2.unpause', [gid]);
  }

  async cancel(gid: string): Promise<void> {
    await this.ensureStarted();
    await this.call<string>('aria2.forceRemove', [gid]);
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;

    try {
      await this.call<string>('aria2.shutdown');
      await delay(150);
    } catch {
      // The process may already have stopped.
    }

    if (!child.killed) child.kill();
    this.child = null;
    this.version = '';
  }

  getHealth(): {
    available: boolean;
    running: boolean;
    executable: string;
    version?: string;
    error?: string;
  } {
    const health: {
      available: boolean;
      running: boolean;
      executable: string;
      version?: string;
      error?: string;
    } = {
      available: Boolean(this.version),
      running: Boolean(this.child && this.version),
      executable: this.executable || this.resolveExecutable(),
    };

    if (this.version) health.version = this.version;
    if (this.lastError) health.error = this.lastError;
    return health;
  }

  private async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: crypto.randomUUID(),
        method,
        params: [`token:${this.secret}`, ...params],
      }),
    });

    if (!response.ok) {
      throw new Error(`aria2 JSON-RPC HTTP ${response.status}`);
    }

    const payload = await response.json() as JsonRpcResponse<T>;
    if (payload.error) {
      throw new Error(`aria2 RPC ${payload.error.code}: ${payload.error.message}`);
    }
    if (payload.result === undefined) {
      throw new Error(`aria2 RPC method ${method} returned no result`);
    }
    return payload.result;
  }
}
