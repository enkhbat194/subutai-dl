import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, open, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

if (process.platform !== 'win32') throw new Error('Packaged owner critical acceptance requires Windows.');

const appRoot = resolve(process.env.SUBUTAI_APP_ROOT || process.argv[2] || '');
if (!appRoot) throw new Error('Pass the unpacked/installed Subutai app root as argv[2] or SUBUTAI_APP_ROOT.');
const engine = join(appRoot, 'resources', 'engines', 'subutai-engine-host.exe');
if (!existsSync(engine)) throw new Error(`Packaged desktop engine host was not found: ${engine}`);

const fileMiB = integerEnv('SUBUTAI_OWNER_CRITICAL_MIB', 64, 16, 1024);
const fileSize = fileMiB * 1024 * 1024;
const checkpointBytes = 1024 * 1024;
const minimumChunkBytes = 1024 * 1024;
const root = await mkdtemp(join(tmpdir(), 'subutai-owner-critical-'));
const sourcePath = join(root, 'source.bin');
const outputDir = join(root, 'downloads');
await mkdir(outputDir, { recursive: true });
await createDeterministicFile(sourcePath, fileSize);
const expectedHash = await sha256(sourcePath);
const server = await startRangeServer(sourcePath, fileSize);

try {
  await runCompleteFlow('normal-http', join(outputDir, 'normal.bin'), server.origin, expectedHash);
  await runPauseResumeFlow(join(outputDir, 'pause-resume.bin'), server.origin, expectedHash);
  await runControllerRestartFlow(join(outputDir, 'restart-resume.bin'), server.origin, expectedHash);
  console.log(`Subutai packaged critical direct acceptance passed for ${fileMiB} MiB payloads.`);
  console.log('SUBUTAI_OWNER_CRITICAL_DIRECT_ACCEPTANCE=PASS');
} finally {
  await server.stop();
  await rm(root, { recursive: true, force: true });
}

async function runCompleteFlow(taskId, destination, origin, expectedSha256) {
  const session = startHost(taskId, `${origin}/source.bin`, destination);
  const complete = await session.waitForState(4, 90_000);
  await session.waitForExit(10_000);
  if (complete.completedBytes !== fileSize) throw new Error(`normal HTTP byte mismatch: ${complete.completedBytes} != ${fileSize}`);
  await verifyCompleted(destination, expectedSha256);
  console.log('Packaged normal HTTP download passed.');
}

async function runPauseResumeFlow(destination, origin, expectedSha256) {
  const taskId = 'owner-pause-resume';
  const first = startHost(taskId, `${origin}/source.bin`, destination);
  await first.waitForProgress(Math.min(8 * 1024 * 1024, Math.floor(fileSize / 4)), 45_000);
  first.send(6);
  const paused = await first.waitForState(3, 30_000);
  await first.waitForExit(10_000);
  if (paused.completedBytes <= 0 || paused.completedBytes >= fileSize) {
    throw new Error(`pause did not preserve partial progress: ${paused.completedBytes}`);
  }
  assertRecoveryState(destination);

  const second = startHost(taskId, `${origin}/source.bin`, destination);
  await second.waitForState(4, 90_000);
  await second.waitForExit(10_000);
  await verifyCompleted(destination, expectedSha256);
  console.log(`Packaged explicit pause/resume passed after ${paused.completedBytes} bytes.`);
}

async function runControllerRestartFlow(destination, origin, expectedSha256) {
  const taskId = 'owner-controller-restart';
  const first = startHost(taskId, `${origin}/source.bin`, destination);
  const progress = await first.waitForProgress(Math.min(8 * 1024 * 1024, Math.floor(fileSize / 4)), 45_000);
  first.closeController();
  const paused = await first.waitForState(3, 30_000);
  await first.waitForExit(10_000);
  if (paused.completedBytes < progress.completedBytes) throw new Error('controller shutdown lost persisted progress.');
  assertRecoveryState(destination);

  const second = startHost(taskId, `${origin}/source.bin`, destination);
  await second.waitForState(4, 90_000);
  await second.waitForExit(10_000);
  await verifyCompleted(destination, expectedSha256);
  console.log(`Packaged unfinished-download restart recovery passed after ${paused.completedBytes} bytes.`);
}

function startHost(taskId, url, destination) {
  const requestId = BigInt(Date.now()) ^ BigInt(Math.floor(Math.random() * 0x7fffffff));
  const child = spawn(engine, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const decoder = new FrameDecoder();
  const statuses = [];
  const waiters = [];
  let stderr = '';
  let exited = false;
  let exitCode = null;

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    for (const frame of decoder.push(Buffer.from(chunk))) {
      if (frame.kind !== 10) continue;
      const status = decodeStatus(frame.payload);
      statuses.push(status);
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(status)) continue;
        waiter.resolve(status);
        waiters.splice(waiters.indexOf(waiter), 1);
      }
    }
  });
  child.once('exit', (code) => {
    exited = true;
    exitCode = code;
    if (code !== 0) {
      for (const waiter of waiters.splice(0)) waiter.reject(new Error(`desktop host exited ${String(code)}: ${stderr}`));
    }
  });
  child.once('error', (error) => {
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  });

  child.stdin.write(encodeFrame(requestId, 5, encodeStartRequest({ taskId, url, destination })));

  return {
    send(kind) {
      if (child.stdin.destroyed) throw new Error('desktop host controller pipe is closed.');
      child.stdin.write(encodeFrame(requestId, kind, Buffer.alloc(0)));
    },
    closeController() { child.stdin.end(); },
    waitForState(state, timeoutMs) { return waitFor((value) => value.state === state, timeoutMs); },
    waitForProgress(bytes, timeoutMs) { return waitFor((value) => value.state === 2 && value.completedBytes >= bytes, timeoutMs); },
    async waitForExit(timeoutMs) {
      if (exited) {
        if (exitCode !== 0) throw new Error(`desktop host exited ${String(exitCode)}: ${stderr}`);
        return;
      }
      const deadline = Date.now() + timeoutMs;
      while (!exited && Date.now() < deadline) await delay(25);
      if (!exited) {
        child.kill();
        throw new Error(`desktop host did not exit within ${timeoutMs} ms.`);
      }
      if (exitCode !== 0) throw new Error(`desktop host exited ${String(exitCode)}: ${stderr}`);
    },
  };

  function waitFor(predicate, timeoutMs) {
    const existing = statuses.findLast(predicate);
    if (existing) return Promise.resolve(existing);
    if (exited && exitCode !== 0) return Promise.reject(new Error(`desktop host exited ${String(exitCode)}: ${stderr}`));
    return new Promise((resolvePromise, reject) => {
      const waiter = { predicate, resolve: resolvePromise, reject };
      waiters.push(waiter);
      const timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`timed out waiting for packaged desktop host status. Last statuses: ${JSON.stringify(statuses.slice(-5))}; stderr=${stderr}`));
      }, timeoutMs);
      waiter.resolve = (value) => { clearTimeout(timer); resolvePromise(value); };
      waiter.reject = (error) => { clearTimeout(timer); reject(error); };
    });
  }
}

function encodeStartRequest({ taskId, url, destination }) {
  const chunks = [Buffer.from('SUBSTRT1'), u16(2), stringField(taskId), stringField(url), stringField(destination), u32(8), u64(minimumChunkBytes), u64(checkpointBytes), Buffer.from([0]), stringField(''), stringField(''), stringField(''), u64(0), u32(10), u64(2000), u64(20_000), u64(60_000), u32(0)];
  return Buffer.concat(chunks);
}

function encodeFrame(requestId, kind, payload) {
  const protectedBytes = Buffer.concat([Buffer.from('SUBIPC01'), u16(1), Buffer.from([kind, 0]), u64(requestId), u32(payload.length), payload]);
  const checksum = fnv1a64(protectedBytes);
  const body = Buffer.concat([protectedBytes, u64(checksum)]);
  return Buffer.concat([u32(body.length), body]);
}

function decodeStatus(payload) {
  let offset = 0;
  if (payload.subarray(0, 8).toString('ascii') !== 'SUBSTAT1') throw new Error('invalid desktop status magic.');
  offset += 8;
  const schema = payload.readUInt16LE(offset); offset += 2;
  const task = readString(payload, offset); offset = task.offset;
  const state = payload.readUInt8(offset); offset += 1;
  const totalBytes = Number(payload.readBigUInt64LE(offset)); offset += 8;
  const completedBytes = Number(payload.readBigUInt64LE(offset)); offset += 8;
  const bytesPerSecond = Number(payload.readBigUInt64LE(offset)); offset += 8;
  const activeConnections = payload.readUInt32LE(offset); offset += 4;
  if (schema === 3) offset += 4 + 4 + 4 + 8 + 8 + 8;
  else if (schema !== 2) throw new Error(`unsupported desktop status schema ${schema}`);
  return { taskId: task.value, state, totalBytes, completedBytes, bytesPerSecond, activeConnections };
}

class FrameDecoder {
  constructor() { this.buffer = Buffer.alloc(0); }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames = [];
    while (this.buffer.length >= 4) {
      const bodyLength = this.buffer.readUInt32LE(0);
      const total = 4 + bodyLength;
      if (this.buffer.length < total) break;
      const frameBytes = this.buffer.subarray(0, total);
      this.buffer = this.buffer.subarray(total);
      frames.push(decodeFrame(frameBytes));
    }
    return frames;
  }
}

function decodeFrame(frame) {
  const bodyLength = frame.readUInt32LE(0);
  if (frame.length !== 4 + bodyLength) throw new Error('IPC frame length mismatch.');
  const body = frame.subarray(4);
  const protectedBytes = body.subarray(0, body.length - 8);
  const expected = body.readBigUInt64LE(body.length - 8);
  if (fnv1a64(protectedBytes) !== expected) throw new Error('IPC frame checksum mismatch.');
  if (protectedBytes.subarray(0, 8).toString('ascii') !== 'SUBIPC01') throw new Error('IPC frame magic mismatch.');
  const version = protectedBytes.readUInt16LE(8);
  if (version !== 1) throw new Error(`unsupported IPC version ${version}`);
  const kind = protectedBytes.readUInt8(10);
  const requestId = protectedBytes.readBigUInt64LE(12);
  const length = protectedBytes.readUInt32LE(20);
  const payload = protectedBytes.subarray(24);
  if (payload.length !== length) throw new Error('IPC payload length mismatch.');
  return { kind, requestId, payload };
}

async function startRangeServer(path, length) {
  const sockets = new Set();
  const server = createServer(async (request, response) => {
    if (request.url !== '/source.bin') { response.statusCode = 404; response.end(); return; }
    let start = 0;
    let end = length - 1;
    const range = request.headers.range;
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/u.exec(range);
      if (!match) { response.statusCode = 416; response.end(); return; }
      start = Number(match[1]);
      if (match[2]) end = Math.min(end, Number(match[2]));
      response.statusCode = 206;
      response.setHeader('content-range', `bytes ${start}-${end}/${length}`);
    }
    response.setHeader('accept-ranges', 'bytes');
    response.setHeader('content-length', String(end - start + 1));
    response.setHeader('content-type', 'application/octet-stream');
    response.setHeader('etag', '"subutai-owner-critical"');
    response.setHeader('last-modified', 'Sun, 23 Aug 2026 00:00:00 GMT');
    if (request.method === 'HEAD') { response.end(); return; }
    const file = await open(path, 'r');
    try {
      let position = start;
      while (position <= end && !response.destroyed) {
        const size = Math.min(64 * 1024, end - position + 1);
        const buffer = Buffer.allocUnsafe(size);
        const { bytesRead } = await file.read(buffer, 0, size, position);
        if (bytesRead <= 0) break;
        if (!response.write(buffer.subarray(0, bytesRead))) await new Promise((resolvePromise) => response.once('drain', resolvePromise));
        position += bytesRead;
        await delay(3);
      }
      if (!response.destroyed) response.end();
    } finally { await file.close(); }
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolvePromise, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolvePromise); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('owner critical range server failed to start.');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolvePromise) => server.close(resolvePromise));
    },
  };
}

async function verifyCompleted(path, expectedSha256) {
  const info = await stat(path);
  if (info.size !== fileSize) throw new Error(`completed file size mismatch: ${info.size} != ${fileSize}`);
  if (await sha256(path) !== expectedSha256) throw new Error('completed file checksum mismatch.');
  for (const statePath of recoveryPaths(path)) if (existsSync(statePath)) throw new Error(`recovery state remained after completion: ${statePath}`);
}

function assertRecoveryState(path) {
  if (!recoveryPaths(path).some((candidate) => existsSync(candidate))) throw new Error('paused/restarted transfer did not preserve resumable state.');
}

function recoveryPaths(path) { return [`${path}.subutai.part`, `${path}.subutai.job`, `${path}.subutai.job.a`, `${path}.subutai.job.b`]; }

async function createDeterministicFile(path, length) {
  await mkdir(dirname(path), { recursive: true });
  const stream = createWriteStream(path);
  let offset = 0;
  while (offset < length) {
    const size = Math.min(1024 * 1024, length - offset);
    const buffer = Buffer.allocUnsafe(size);
    for (let index = 0; index < size; index += 1) buffer[index] = (offset + index * 37 + 19) & 0xff;
    if (!stream.write(buffer)) await new Promise((resolvePromise) => stream.once('drain', resolvePromise));
    offset += size;
  }
  await new Promise((resolvePromise, reject) => { stream.end(resolvePromise); stream.once('error', reject); });
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function fnv1a64(buffer) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const byte of buffer) hash = ((hash ^ BigInt(byte)) * prime) & mask;
  return hash;
}

function stringField(value) { const bytes = Buffer.from(value, 'utf8'); return Buffer.concat([u32(bytes.length), bytes]); }
function readString(buffer, offset) { const length = buffer.readUInt32LE(offset); offset += 4; return { value: buffer.subarray(offset, offset + length).toString('utf8'), offset: offset + length }; }
function u16(value) { const buffer = Buffer.allocUnsafe(2); buffer.writeUInt16LE(Number(value)); return buffer; }
function u32(value) { const buffer = Buffer.allocUnsafe(4); buffer.writeUInt32LE(Number(value)); return buffer; }
function u64(value) { const buffer = Buffer.allocUnsafe(8); buffer.writeBigUInt64LE(BigInt(value)); return buffer; }
function integerEnv(name, fallback, minimum, maximum) { const value = Number.parseInt(process.env[name] || '', 10); return Number.isInteger(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback; }
