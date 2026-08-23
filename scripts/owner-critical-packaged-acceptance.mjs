import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, open, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const STATE = { ACTIVE: 2, PAUSED: 3, COMPLETE: 4 };
const KIND = { START: 5, PAUSE: 6, STATUS: 10 };
const fileMiB = envInt('SUBUTAI_OWNER_CRITICAL_MIB', 64, 16, 1024);
const fileBytes = fileMiB * 1024 * 1024;
const appRoot = resolve(process.env.SUBUTAI_APP_ROOT || process.argv[2] || '.');
const engine = join(appRoot, 'resources', 'engines', 'subutai-engine-host.exe');

if (process.platform !== 'win32') throw new Error('Packaged owner acceptance requires Windows.');
if (!existsSync(engine)) throw new Error(`Packaged desktop engine host is missing: ${engine}`);

const root = await mkdtemp(join(tmpdir(), 'subutai-packaged-acceptance-'));
const source = join(root, 'source.bin');
const downloads = join(root, 'downloads');
await mkdir(downloads, { recursive: true });
await createPatternFile(source, fileBytes);
const expectedSha = await sha256(source);
const server = await startServer(source, fileBytes);

try {
  await completeFlow('normal-http', join(downloads, 'normal.bin'));
  await pauseResumeFlow(join(downloads, 'pause-resume.bin'));
  await restartFlow(join(downloads, 'restart-resume.bin'));
  console.log(`Packaged direct acceptance passed for ${fileMiB} MiB.`);
  console.log('SUBUTAI_OWNER_CRITICAL_DIRECT_ACCEPTANCE=PASS');
} finally {
  await server.stop();
  await rm(root, { recursive: true, force: true });
}

async function completeFlow(taskId, destination) {
  const host = launchHost(taskId, `${server.origin}/source.bin`, destination);
  const complete = await host.wait((s) => s.state === STATE.COMPLETE, 120_000);
  await host.waitExit(15_000);
  if (complete.completedBytes !== fileBytes) throw new Error('Normal HTTP byte count mismatch.');
  await verify(destination);
  console.log('Packaged normal HTTP download passed.');
}

async function pauseResumeFlow(destination) {
  const taskId = 'packaged-pause-resume';
  const first = launchHost(taskId, `${server.origin}/source.bin`, destination);
  const progress = await first.wait((s) => s.state === STATE.ACTIVE && s.completedBytes >= pauseThreshold(), 60_000);
  first.send(KIND.PAUSE);
  const paused = await first.wait((s) => s.state === STATE.PAUSED, 45_000);
  await first.waitExit(15_000);
  if (paused.completedBytes < progress.completedBytes || paused.completedBytes >= fileBytes) {
    throw new Error(`Explicit pause did not preserve partial progress: ${paused.completedBytes}.`);
  }
  requireRecovery(destination);
  const second = launchHost(taskId, `${server.origin}/source.bin`, destination);
  await second.wait((s) => s.state === STATE.COMPLETE, 120_000);
  await second.waitExit(15_000);
  await verify(destination);
  console.log(`Packaged pause/resume passed after ${paused.completedBytes} bytes.`);
}

async function restartFlow(destination) {
  const taskId = 'packaged-controller-restart';
  const first = launchHost(taskId, `${server.origin}/source.bin`, destination);
  const progress = await first.wait((s) => s.state === STATE.ACTIVE && s.completedBytes >= pauseThreshold(), 60_000);
  first.closeInput();
  const paused = await first.wait((s) => s.state === STATE.PAUSED, 45_000);
  await first.waitExit(15_000);
  if (paused.completedBytes < progress.completedBytes || paused.completedBytes >= fileBytes) {
    throw new Error(`Controller restart did not preserve partial progress: ${paused.completedBytes}.`);
  }
  requireRecovery(destination);
  const second = launchHost(taskId, `${server.origin}/source.bin`, destination);
  await second.wait((s) => s.state === STATE.COMPLETE, 120_000);
  await second.waitExit(15_000);
  await verify(destination);
  console.log(`Packaged restart recovery passed after ${paused.completedBytes} bytes.`);
}

function launchHost(taskId, url, destination) {
  const requestId = BigInt(Date.now()) ^ BigInt(Math.floor(Math.random() * 0x7fffffff));
  const child = spawn(engine, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const decoder = makeFrameDecoder();
  const statuses = [];
  const waiters = [];
  let stderr = '';
  let exited = false;
  let exitCode = null;

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    for (const frame of decoder.push(Buffer.from(chunk))) {
      if (frame.kind !== KIND.STATUS) continue;
      const status = decodeStatus(frame.payload);
      statuses.push(status);
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(status)) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(status);
      }
    }
  });
  child.once('exit', (code) => {
    exited = true;
    exitCode = code;
    if (code !== 0) for (const waiter of waiters.splice(0)) waiter.reject(hostError(code, stderr));
  });
  child.once('error', (error) => {
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  });

  child.stdin.write(frame(requestId, KIND.START, startPayload(taskId, url, destination)));

  return {
    send(kind) { child.stdin.write(frame(requestId, kind, Buffer.alloc(0))); },
    closeInput() { child.stdin.end(); },
    wait(predicate, timeoutMs) {
      const existing = statuses.findLast(predicate);
      if (existing) return Promise.resolve(existing);
      if (exited && exitCode !== 0) return Promise.reject(hostError(exitCode, stderr));
      return new Promise((resolvePromise, reject) => {
        const waiter = { predicate, resolve: resolvePromise, reject };
        waiters.push(waiter);
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`Timed out waiting for packaged host status. Last=${JSON.stringify(statuses.slice(-5))}; stderr=${stderr}`));
        }, timeoutMs);
        waiter.resolve = (value) => { clearTimeout(timer); resolvePromise(value); };
        waiter.reject = (error) => { clearTimeout(timer); reject(error); };
      });
    },
    async waitExit(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (!exited && Date.now() < deadline) await delay(25);
      if (!exited) { child.kill(); throw new Error('Packaged desktop host did not exit in time.'); }
      if (exitCode !== 0) throw hostError(exitCode, stderr);
    },
  };
}

function makeFrameDecoder() {
  let buffer = Buffer.alloc(0);
  return {
    push(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      const frames = [];
      while (buffer.length >= 4) {
        const bodyLength = buffer.readUInt32LE(0);
        const total = bodyLength + 4;
        if (buffer.length < total) break;
        frames.push(decodeFrame(buffer.subarray(0, total)));
        buffer = buffer.subarray(total);
      }
      return frames;
    },
  };
}

function startPayload(taskId, url, destination) {
  return Buffer.concat([
    Buffer.from('SUBSTRT1'), u16(2), str(taskId), str(url), str(destination),
    u32(8), u64(1024 * 1024), u64(1024 * 1024), Buffer.from([0]),
    str(''), str(''), str(''), u64(0), u32(10), u64(2000), u64(20_000), u64(60_000), u32(0),
  ]);
}

function frame(requestId, kind, payload) {
  const protectedBytes = Buffer.concat([
    Buffer.from('SUBIPC01'), u16(1), Buffer.from([kind, 0]), u64(requestId), u32(payload.length), payload,
  ]);
  const body = Buffer.concat([protectedBytes, u64(fnv1a64(protectedBytes))]);
  return Buffer.concat([u32(body.length), body]);
}

function decodeFrame(bytes) {
  const bodyLength = bytes.readUInt32LE(0);
  if (bytes.length !== bodyLength + 4) throw new Error('IPC frame length mismatch.');
  const body = bytes.subarray(4);
  const protectedBytes = body.subarray(0, body.length - 8);
  if (fnv1a64(protectedBytes) !== body.readBigUInt64LE(body.length - 8)) throw new Error('IPC checksum mismatch.');
  if (protectedBytes.subarray(0, 8).toString('ascii') !== 'SUBIPC01') throw new Error('IPC magic mismatch.');
  const kind = protectedBytes.readUInt8(10);
  const payloadLength = protectedBytes.readUInt32LE(20);
  const payload = protectedBytes.subarray(24);
  if (payload.length !== payloadLength) throw new Error('IPC payload length mismatch.');
  return { kind, payload };
}

function decodeStatus(payload) {
  let offset = 0;
  if (payload.subarray(0, 8).toString('ascii') !== 'SUBSTAT1') throw new Error('Status magic mismatch.');
  offset += 8;
  const schema = payload.readUInt16LE(offset); offset += 2;
  const task = readStr(payload, offset); offset = task.offset;
  const state = payload.readUInt8(offset); offset += 1;
  const totalBytes = Number(payload.readBigUInt64LE(offset)); offset += 8;
  const completedBytes = Number(payload.readBigUInt64LE(offset)); offset += 8;
  const bytesPerSecond = Number(payload.readBigUInt64LE(offset)); offset += 8;
  const activeConnections = payload.readUInt32LE(offset); offset += 4;
  if (schema === 3) offset += 4 + 4 + 4 + 8 + 8 + 8;
  else if (schema !== 2) throw new Error(`Unsupported status schema ${schema}.`);
  return { taskId: task.value, state, totalBytes, completedBytes, bytesPerSecond, activeConnections };
}

async function startServer(path, length) {
  const sockets = new Set();
  const http = createServer(async (request, response) => {
    if (request.url !== '/source.bin') { response.statusCode = 404; response.end(); return; }
    let start = 0;
    let end = length - 1;
    if (request.headers.range) {
      const match = /^bytes=(\d+)-(\d*)$/u.exec(request.headers.range);
      if (!match) { response.statusCode = 416; response.end(); return; }
      start = Number(match[1]);
      if (match[2]) end = Math.min(end, Number(match[2]));
      response.statusCode = 206;
      response.setHeader('content-range', `bytes ${start}-${end}/${length}`);
    }
    response.setHeader('accept-ranges', 'bytes');
    response.setHeader('content-length', String(end - start + 1));
    response.setHeader('content-type', 'application/octet-stream');
    response.setHeader('etag', '"subutai-packaged-owner"');
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
        if (!response.write(buffer.subarray(0, bytesRead))) await new Promise((r) => response.once('drain', r));
        position += bytesRead;
        await delay(10);
      }
      if (!response.destroyed) response.end();
    } finally { await file.close(); }
  });
  http.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolvePromise, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolvePromise); });
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Local range server failed to start.');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    async stop() { for (const socket of sockets) socket.destroy(); await new Promise((r) => http.close(r)); },
  };
}

async function verify(path) {
  const info = await stat(path);
  if (info.size !== fileBytes) throw new Error(`Completed file size mismatch: ${info.size} != ${fileBytes}.`);
  if (await sha256(path) !== expectedSha) throw new Error('Completed file SHA-256 mismatch.');
  for (const candidate of recoveryPaths(path)) if (existsSync(candidate)) throw new Error(`Recovery state remained: ${candidate}`);
}

function requireRecovery(path) {
  if (!recoveryPaths(path).some((candidate) => existsSync(candidate))) throw new Error('No resumable state was preserved.');
}
function recoveryPaths(path) { return [`${path}.subutai.part`, `${path}.subutai.job`, `${path}.subutai.job.a`, `${path}.subutai.job.b`]; }
function pauseThreshold() { return Math.min(8 * 1024 * 1024, Math.floor(fileBytes / 4)); }
function hostError(code, stderr) { return new Error(`Packaged desktop host exited ${String(code)}: ${stderr}`); }

async function createPatternFile(path, length) {
  await mkdir(dirname(path), { recursive: true });
  const stream = createWriteStream(path);
  let offset = 0;
  while (offset < length) {
    const size = Math.min(1024 * 1024, length - offset);
    const buffer = Buffer.allocUnsafe(size);
    for (let i = 0; i < size; i += 1) buffer[i] = (offset + i * 37 + 19) & 0xff;
    if (!stream.write(buffer)) await new Promise((r) => stream.once('drain', r));
    offset += size;
  }
  await new Promise((resolvePromise, reject) => { stream.end(resolvePromise); stream.once('error', reject); });
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
function fnv1a64(buffer) { let hash = 0xcbf29ce484222325n; for (const byte of buffer) hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn; return hash; }
function str(value) { const bytes = Buffer.from(value, 'utf8'); return Buffer.concat([u32(bytes.length), bytes]); }
function readStr(buffer, offset) { const length = buffer.readUInt32LE(offset); offset += 4; return { value: buffer.subarray(offset, offset + length).toString('utf8'), offset: offset + length }; }
function u16(value) { const b = Buffer.allocUnsafe(2); b.writeUInt16LE(Number(value)); return b; }
function u32(value) { const b = Buffer.allocUnsafe(4); b.writeUInt32LE(Number(value)); return b; }
function u64(value) { const b = Buffer.allocUnsafe(8); b.writeBigUInt64LE(BigInt(value)); return b; }
function envInt(name, fallback, min, max) { const value = Number.parseInt(process.env[name] || '', 10); return Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback; }
