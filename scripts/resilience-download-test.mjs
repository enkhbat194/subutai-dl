import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, open, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const FILE_MB = Math.max(8, Number(process.env.SUBUTAI_RESILIENCE_MB || 32));
const FILE_SIZE = FILE_MB * 1024 * 1024;
const CHUNK_SIZE = 64 * 1024;
const MINIMUM_PROGRESS_BYTES = 1024 * 1024;
const nativeEngine = resolve(
  process.env.SUBUTAI_NATIVE_ENGINE_PATH
    || join(
      process.cwd(),
      'engines',
      'native',
      'target',
      process.env.SUBUTAI_NATIVE_PROFILE || 'debug',
      process.platform === 'win32' ? 'subutai-engine.exe' : 'subutai-engine',
    ),
);

if (!existsSync(nativeEngine)) {
  throw new Error(`Subutai native engine was not found: ${nativeEngine}`);
}

const root = await mkdtemp(join(tmpdir(), 'subutai-native-resilience-'));
const sourcePath = join(root, 'source.bin');
const outputDir = join(root, 'downloads');
await mkdir(outputDir, { recursive: true });

function patternChunk(offset, length) {
  const buffer = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index += 1) {
    buffer[index] = (offset + index * 31 + 17) & 0xff;
  }
  return buffer;
}

async function createSource() {
  const stream = createWriteStream(sourcePath);
  let offset = 0;
  while (offset < FILE_SIZE) {
    const length = Math.min(1024 * 1024, FILE_SIZE - offset);
    if (!stream.write(patternChunk(offset, length))) {
      await new Promise((resolvePromise) => stream.once('drain', resolvePromise));
    }
    offset += length;
  }
  await new Promise((resolvePromise, reject) => {
    stream.end(resolvePromise);
    stream.once('error', reject);
  });
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

class RangeServer {
  constructor(path) {
    this.path = path;
    this.server = null;
    this.port = 0;
    this.sockets = new Set();
  }

  async start(port = 0) {
    this.server = createServer((request, response) => void this.handle(request, response));
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    await new Promise((resolvePromise, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', resolvePromise);
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Range server failed to start.');
    this.port = address.port;
  }

  async stop(dropConnections = true) {
    if (!this.server) return;
    if (dropConnections) for (const socket of this.sockets) socket.destroy();
    const server = this.server;
    this.server = null;
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }

  async handle(request, response) {
    if (request.url !== '/source.bin') {
      response.statusCode = 404;
      response.end();
      return;
    }

    const rangeHeader = request.headers.range;
    let start = 0;
    let end = FILE_SIZE - 1;
    if (rangeHeader) {
      const match = /^bytes=(\d+)-(\d*)$/u.exec(rangeHeader);
      if (!match) {
        response.statusCode = 416;
        response.end();
        return;
      }
      start = Number(match[1]);
      if (match[2]) end = Math.min(FILE_SIZE - 1, Number(match[2]));
      response.statusCode = 206;
      response.setHeader('content-range', `bytes ${start}-${end}/${FILE_SIZE}`);
    }

    const length = end - start + 1;
    response.setHeader('accept-ranges', 'bytes');
    response.setHeader('content-length', String(length));
    response.setHeader('content-type', 'application/octet-stream');
    response.setHeader('etag', '"subutai-n5-resilience"');
    response.setHeader('last-modified', 'Sun, 02 Aug 2026 14:00:00 GMT');
    if (request.method === 'HEAD') {
      response.end();
      return;
    }

    const file = await open(this.path, 'r');
    try {
      let position = start;
      while (position <= end && !response.destroyed) {
        const size = Math.min(CHUNK_SIZE, end - position + 1);
        const buffer = Buffer.allocUnsafe(size);
        const { bytesRead } = await file.read(buffer, 0, size, position);
        if (bytesRead <= 0) break;
        if (!response.write(buffer.subarray(0, bytesRead))) {
          await new Promise((resolvePromise) => response.once('drain', resolvePromise));
        }
        position += bytesRead;
        await delay(10);
      }
      if (!response.destroyed) response.end();
    } finally {
      await file.close();
    }
  }
}

function runNative(url, destination, segments = 4) {
  const child = spawn(
    nativeEngine,
    ['download-segmented', url, destination, String(segments), String(1024 * 1024)],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  let stdout = '';
  let stderr = '';
  let downloadedBytes = 0;
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => { stdout += chunk; });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
    for (const match of chunk.matchAll(/downloaded=(\d+)/gu)) {
      downloadedBytes = Math.max(downloadedBytes, Number(match[1]));
    }
  });
  const completion = new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0 && stdout.includes('result=PASS')) resolvePromise({ stdout, stderr });
      else reject(new Error(`Subutai native engine exited with ${String(code)}\n${stderr}\n${stdout}`));
    });
  });
  return {
    child,
    completion,
    downloadedBytes: () => downloadedBytes,
  };
}

async function waitForProgress(run, minimumBytes = MINIMUM_PROGRESS_BYTES) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (run.downloadedBytes() >= minimumBytes) return run.downloadedBytes();
    if (run.child.exitCode !== null) {
      throw new Error(`Native engine exited before reaching ${minimumBytes} bytes.`);
    }
    await delay(50);
  }
  throw new Error(`Native progress did not reach ${minimumBytes} bytes.`);
}

async function verify(path, expectedHash) {
  const info = await stat(path);
  if (info.size !== FILE_SIZE) throw new Error(`Unexpected size for ${path}: ${info.size}`);
  const actualHash = await sha256(path);
  if (actualHash !== expectedHash) throw new Error(`Checksum mismatch for ${path}`);
  for (const statePath of resumableStatePaths(path)) {
    if (existsSync(statePath)) throw new Error(`Recovery state remained after completion: ${statePath}`);
  }
}

function resumableStatePaths(destination) {
  return [
    `${destination}.subutai.part`,
    `${destination}.subutai.job`,
    `${destination}.subutai.job.a`,
    `${destination}.subutai.job.b`,
  ];
}

await createSource();
const expectedHash = await sha256(sourcePath);
const server = new RangeServer(sourcePath);
await server.start();
const url = `http://127.0.0.1:${server.port}/source.bin`;

try {
  const cleanPath = join(outputDir, 'clean.bin');
  const clean = runNative(url, cleanPath, 4);
  await clean.completion;
  await verify(cleanPath, expectedHash);
  console.log(`Clean native segmented ${FILE_MB} MB download passed.`);

  const crashPath = join(outputDir, 'crash-resume.bin');
  const firstCrash = runNative(url, crashPath, 4);
  const persistedBeforeKill = await waitForProgress(firstCrash);
  firstCrash.child.kill();
  await firstCrash.completion.catch(() => undefined);
  if (!resumableStatePaths(crashPath).some((path) => existsSync(path))) {
    throw new Error('Native process kill did not preserve resumable state.');
  }
  const resumedCrash = runNative(url, crashPath, 4);
  await resumedCrash.completion;
  await verify(crashPath, expectedHash);
  console.log(`Process-kill resume passed after ${persistedBeforeKill} persisted bytes.`);

  const networkPath = join(outputDir, 'network-resume.bin');
  const network = runNative(url, networkPath, 4);
  await waitForProgress(network);
  const originalPort = server.port;
  await server.stop(true);
  await delay(1_000);
  await server.start(originalPort);
  await network.completion;
  await verify(networkPath, expectedHash);
  console.log('Network drop/rebind recovery checksum passed.');

  console.log(`Subutai first-party resilience suite passed for ${FILE_MB} MB payloads.`);
} finally {
  await server.stop(true);
  await rm(root, { recursive: true, force: true });
}
