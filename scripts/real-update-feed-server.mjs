import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve, sep } from 'node:path';

const [rootArgument, stateFileArgument, logFileArgument = ''] = process.argv.slice(2);
if (!rootArgument || !stateFileArgument) {
  throw new Error('Usage: node scripts/real-update-feed-server.mjs <root> <state-file> [log-file]');
}

const root = resolve(rootArgument);
const stateFile = resolve(stateFileArgument);
const logFile = logFileArgument ? resolve(logFileArgument) : '';
const contentTypes = new Map([
  ['.yml', 'text/yaml; charset=utf-8'],
  ['.yaml', 'text/yaml; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.exe', 'application/vnd.microsoft.portable-executable'],
  ['.blockmap', 'application/octet-stream'],
]);

async function appendLog(message) {
  if (!logFile) return;
  await mkdir(dirname(logFile), { recursive: true });
  await writeFile(logFile, `${new Date().toISOString()} ${message}\n`, { flag: 'a' });
}

function resolveRequestPath(rawUrl) {
  const parsed = new URL(rawUrl ?? '/', 'http://127.0.0.1');
  const pathname = decodeURIComponent(parsed.pathname);
  const relative = pathname.replace(/^\/+/, '');
  const candidate = resolve(root, relative || 'latest.yml');
  const offset = candidate.slice(root.length);
  if (candidate !== root && (!offset.startsWith(sep) || offset.includes(`..${sep}`))) {
    throw new Error('Requested path escaped the update feed root.');
  }
  return candidate;
}

function parseRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
  if (!match || (!match[1] && !match[2])) throw new Error('Unsupported Range header.');
  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) throw new Error('Invalid suffix range.');
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
    throw new Error('Requested byte range is outside the file.');
  }
  return { start, end: Math.min(end, size - 1) };
}

const server = createServer(async (request, response) => {
  try {
    if (!['GET', 'HEAD'].includes(request.method ?? '')) {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return;
    }
    const filePath = resolveRequestPath(request.url);
    const information = await stat(filePath);
    if (!information.isFile()) throw new Error('Requested update feed entry is not a file.');

    const range = parseRange(request.headers.range, information.size);
    const start = range?.start ?? 0;
    const end = range?.end ?? Math.max(0, information.size - 1);
    const responseSize = information.size === 0 ? 0 : end - start + 1;
    const status = range ? 206 : 200;
    const headers = {
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store, max-age=0',
      'Content-Length': responseSize,
      'Content-Type': contentTypes.get(extname(filePath).toLowerCase()) ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${information.size}`;
    response.writeHead(status, headers);
    if (request.method === 'HEAD' || information.size === 0) {
      response.end();
    } else {
      const stream = createReadStream(filePath, { start, end });
      stream.on('error', (error) => response.destroy(error));
      stream.pipe(response);
    }
    await appendLog(`${request.method} /${basename(filePath)} ${status} ${start}-${end}/${information.size}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes('range') || message.includes('Range') ? 416 : 404;
    response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(status === 416 ? 'Range not satisfiable' : 'Not found');
    await appendLog(`${request.method ?? 'UNKNOWN'} ${request.url ?? '/'} ${status} ${message}`);
  }
});

server.on('error', async (error) => {
  await appendLog(`SERVER_ERROR ${error.stack ?? error.message}`);
  process.exitCode = 1;
});

server.listen({ host: '127.0.0.1', port: 0 }, async () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback update server did not expose a TCP port.');
  const state = {
    schemaVersion: 1,
    pid: process.pid,
    root,
    host: '127.0.0.1',
    port: address.port,
    url: `http://127.0.0.1:${address.port}/`,
    startedAt: new Date().toISOString(),
  };
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await appendLog(`LISTEN ${state.url} root=${root}`);
  console.log(state.url);
});

async function shutdown(signal) {
  await appendLog(`SHUTDOWN ${signal}`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
