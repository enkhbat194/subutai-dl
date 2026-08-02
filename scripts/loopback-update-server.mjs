import http from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const root = resolve(process.argv[2] ?? '');
const portFile = resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
  throw new Error('Usage: node scripts/loopback-update-server.mjs <root> <port-file>');
}

const contentTypes = new Map([
  ['.yml', 'text/yaml; charset=utf-8'],
  ['.yaml', 'text/yaml; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.exe', 'application/octet-stream'],
  ['.blockmap', 'application/octet-stream'],
  ['.sha256', 'text/plain; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

function safePath(urlValue) {
  const pathname = decodeURIComponent(new URL(urlValue, 'http://127.0.0.1').pathname);
  const relative = normalize(pathname).replace(/^[/\\]+/u, '');
  const candidate = resolve(join(root, relative));
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error('Requested path escaped the update feed root.');
  }
  return candidate;
}

const server = http.createServer(async (request, response) => {
  try {
    if (!request.url || !['GET', 'HEAD'].includes(request.method ?? '')) {
      response.writeHead(405).end();
      return;
    }
    const filePath = safePath(request.url);
    const details = await stat(filePath);
    if (!details.isFile()) throw new Error('Not a file');
    response.writeHead(200, {
      'Content-Type': contentTypes.get(extname(filePath).toLowerCase()) ?? 'application/octet-stream',
      'Content-Length': details.size,
      'Cache-Control': 'no-store',
      'Accept-Ranges': 'bytes',
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    response.end(await readFile(filePath));
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
});

server.listen(0, '127.0.0.1', async () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback server did not expose a TCP port.');
  await writeFile(portFile, String(address.port), 'utf8');
  console.log(`Subutai loopback update feed: http://127.0.0.1:${address.port}/`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
