import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a local TCP port'));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

const payload = randomBytes(5 * 1024 * 1024 + 137);
const expectedHash = sha256(payload);
const downloadDirectory = await mkdtemp(join(tmpdir(), 'subutai-direct-'));
const rpcPort = await getFreePort();
const rpcSecret = randomBytes(16).toString('hex');
let engineProcess = null;
let httpServer = null;

async function rpc(method, params = []) {
  const response = await fetch(`http://127.0.0.1:${rpcPort}/jsonrpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: randomBytes(8).toString('hex'),
      method,
      params: [`token:${rpcSecret}`, ...params],
    }),
  });
  if (!response.ok) throw new Error(`Subutai direct engine RPC HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`Subutai direct engine RPC ${body.error.code}: ${body.error.message}`);
  return body.result;
}

try {
  httpServer = createHttpServer((request, response) => {
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('ETag', `"${expectedHash}"`);

    if (request.method === 'HEAD') {
      response.setHeader('Content-Length', payload.length);
      response.end();
      return;
    }

    const range = request.headers.range;
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!match) {
        response.writeHead(416);
        response.end();
        return;
      }
      const start = Number(match[1]);
      const end = match[2] ? Math.min(Number(match[2]), payload.length - 1) : payload.length - 1;
      if (start > end || start >= payload.length) {
        response.writeHead(416, { 'Content-Range': `bytes */${payload.length}` });
        response.end();
        return;
      }
      response.writeHead(206, {
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${payload.length}`,
      });
      response.end(payload.subarray(start, end + 1));
      return;
    }

    response.writeHead(200, { 'Content-Length': payload.length });
    response.end(payload);
  });

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Subutai smoke server did not start');

  engineProcess = spawn('aria2c', [
    '--enable-rpc=true',
    '--rpc-listen-all=false',
    `--rpc-listen-port=${rpcPort}`,
    `--rpc-secret=${rpcSecret}`,
    '--summary-interval=0',
    '--console-log-level=warn',
    '--file-allocation=none',
    '--download-result=hide',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let processError = '';
  engineProcess.once('error', (error) => { processError = error.message; });
  engineProcess.stderr.on('data', (chunk) => {
    const message = chunk.toString().trim();
    if (message) process.stderr.write(`[Subutai direct engine] ${message}\n`);
  });

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (processError) throw new Error(processError);
    try {
      await rpc('aria2.getVersion');
      break;
    } catch {
      if (attempt === 49) throw new Error('Subutai direct engine did not become ready');
      await delay(100);
    }
  }

  const gid = await rpc('aria2.addUri', [[`http://127.0.0.1:${address.port}/smoke.bin`], {
    dir: downloadDirectory,
    out: 'smoke.bin',
    split: '4',
    'max-connection-per-server': '4',
    'min-split-size': '1M',
    continue: 'true',
  }]);

  let finalStatus = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    finalStatus = await rpc('aria2.tellStatus', [gid, [
      'status',
      'totalLength',
      'completedLength',
      'downloadSpeed',
      'connections',
      'errorMessage',
    ]]);
    if (finalStatus.status === 'complete') break;
    if (finalStatus.status === 'error') throw new Error(finalStatus.errorMessage || 'Subutai direct download failed');
    await delay(50);
  }

  if (!finalStatus || finalStatus.status !== 'complete') throw new Error('Subutai direct download timed out');
  const downloaded = await readFile(join(downloadDirectory, 'smoke.bin'));
  const actualHash = sha256(downloaded);
  if (actualHash !== expectedHash) throw new Error(`Checksum mismatch: ${actualHash} != ${expectedHash}`);

  console.log(JSON.stringify({
    result: 'PASS',
    bytes: downloaded.length,
    sha256: actualHash,
    status: finalStatus.status,
  }, null, 2));
} finally {
  if (engineProcess && !engineProcess.killed) {
    try { await rpc('aria2.shutdown'); } catch { engineProcess.kill(); }
  }
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  await rm(downloadDirectory, { recursive: true, force: true });
}
