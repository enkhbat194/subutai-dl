import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const FILE_MB = Math.max(8, Number(process.env.SUBUTAI_RESILIENCE_MB || 64));
const FILE_SIZE = FILE_MB * 1024 * 1024;
const CHUNK_SIZE = 64 * 1024;
const aria2 = process.env.SUBUTAI_ARIA2_PATH || (process.platform === 'win32' ? 'aria2c.exe' : 'aria2c');
const root = await mkdtemp(join(tmpdir(), 'subutai-resilience-'));
const sourcePath = join(root, 'source.bin');
const outputDir = join(root, 'downloads');
await mkdir(outputDir, { recursive: true });

function patternChunk(offset, length) {
  const buffer = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index += 1) buffer[index] = (offset + index * 31 + 17) & 0xff;
  return buffer;
}

async function createSource() {
  const stream = createWriteStream(sourcePath);
  let offset = 0;
  while (offset < FILE_SIZE) {
    const length = Math.min(1024 * 1024, FILE_SIZE - offset);
    if (!stream.write(patternChunk(offset, length))) await new Promise((resolve) => stream.once('drain', resolve));
    offset += length;
  }
  await new Promise((resolve, reject) => {
    stream.end(resolve);
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
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', resolve);
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
    await new Promise((resolve) => server.close(() => resolve()));
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
        if (!response.write(buffer.subarray(0, bytesRead))) await new Promise((resolve) => response.once('drain', resolve));
        position += bytesRead;
        await delay(8);
      }
      if (!response.destroyed) response.end();
    } finally {
      await file.close();
    }
  }
}

function ariaArgs(url, filename, split = 8) {
  return [
    '--continue=true',
    `--split=${split}`,
    `--max-connection-per-server=${split}`,
    '--min-split-size=1M',
    '--file-allocation=none',
    '--auto-file-renaming=false',
    '--allow-overwrite=true',
    '--max-tries=0',
    '--retry-wait=1',
    '--connect-timeout=5',
    '--timeout=10',
    '--summary-interval=0',
    '--console-log-level=warn',
    `--dir=${outputDir}`,
    `--out=${filename}`,
    url,
  ];
}

function runAria(url, filename, split = 8) {
  const child = spawn(aria2, ariaArgs(url, filename, split), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${basename(aria2)} exited with ${code}\n${stderr}`));
    });
  });
  return { child, completion };
}

async function waitForPartial(path, minimumBytes = 1024 * 1024) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const info = await stat(path);
      if (info.size >= minimumBytes && info.size < FILE_SIZE) return info.size;
    } catch {
      // File is not created yet.
    }
    await delay(100);
  }
  throw new Error(`Partial download was not observed for ${path}`);
}

async function verify(path, expectedHash) {
  const info = await stat(path);
  if (info.size !== FILE_SIZE) throw new Error(`Unexpected size for ${path}: ${info.size}`);
  const actualHash = await sha256(path);
  if (actualHash !== expectedHash) throw new Error(`Checksum mismatch for ${path}`);
}

await createSource();
const expectedHash = await sha256(sourcePath);
const server = new RangeServer(sourcePath);
await server.start();
const url = `http://127.0.0.1:${server.port}/source.bin`;

try {
  const clean = runAria(url, 'clean.bin', 8);
  await clean.completion;
  await verify(join(outputDir, 'clean.bin'), expectedHash);
  console.log(`Clean segmented ${FILE_MB} MB download passed.`);

  const crashPath = join(outputDir, 'crash-resume.bin');
  const firstCrash = runAria(url, 'crash-resume.bin', 4);
  await waitForPartial(crashPath);
  firstCrash.child.kill();
  await firstCrash.completion.catch(() => undefined);
  const resumedCrash = runAria(url, 'crash-resume.bin', 4);
  await resumedCrash.completion;
  await verify(crashPath, expectedHash);
  console.log('Crash/kill resume checksum passed.');

  const networkPath = join(outputDir, 'network-resume.bin');
  const network = runAria(url, 'network-resume.bin', 4);
  await waitForPartial(networkPath);
  const originalPort = server.port;
  await server.stop(true);
  await delay(2_000);
  await server.start(originalPort);
  await network.completion;
  await verify(networkPath, expectedHash);
  console.log('Network drop/rebind resume checksum passed.');

  const sidecar = await readFile(`${networkPath}.aria2`).catch(() => null);
  if (sidecar) throw new Error('Recovery sidecar remained after successful completion.');
  console.log(`Subutai resilience suite passed for ${FILE_MB} MB payloads.`);
} finally {
  await server.stop(true);
  await rm(root, { recursive: true, force: true });
}
