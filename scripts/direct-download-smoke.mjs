import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

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
  throw new Error(
    `Subutai native engine was not found: ${nativeEngine}. Build it first with cargo build --manifest-path engines/native/Cargo.toml --bin subutai-engine.`,
  );
}

const payload = randomBytes(5 * 1024 * 1024 + 137);
const expectedHash = sha256(payload);
const downloadDirectory = await mkdtemp(join(tmpdir(), 'subutai-direct-'));
let httpServer = null;

function runNativeDownload(url, destination) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      nativeEngine,
      ['download', url, destination],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0 && stdout.includes('result=PASS')) {
        resolvePromise({ stdout, stderr });
      } else {
        reject(new Error(`Subutai native direct engine exited with ${String(code)}\n${stderr}\n${stdout}`));
      }
    });
  });
}

try {
  httpServer = createHttpServer((request, response) => {
    if (request.url !== '/smoke.bin') {
      response.writeHead(404);
      response.end();
      return;
    }

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
      const match = /^bytes=(\d+)-(\d*)$/u.exec(range);
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

  await new Promise((resolvePromise, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Subutai smoke server did not start');

  const destination = join(downloadDirectory, 'smoke.bin');
  const url = `http://127.0.0.1:${address.port}/smoke.bin`;
  const result = await runNativeDownload(url, destination);
  const downloaded = await readFile(destination);
  const actualHash = sha256(downloaded);
  if (actualHash !== expectedHash) throw new Error(`Checksum mismatch: ${actualHash} != ${expectedHash}`);
  if (!result.stdout.includes(`downloaded_bytes=${downloaded.length}`)) {
    throw new Error(`Native direct engine did not report the expected byte count.\n${result.stdout}`);
  }

  console.log(JSON.stringify({
    result: 'PASS',
    engine: 'subutai-native',
    bytes: downloaded.length,
    sha256: actualHash,
  }, null, 2));
} finally {
  if (httpServer) await new Promise((resolvePromise) => httpServer.close(resolvePromise));
  await rm(downloadDirectory, { recursive: true, force: true });
}
