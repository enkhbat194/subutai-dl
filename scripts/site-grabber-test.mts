import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { SiteGrabberService } from '../apps/desktop/src/main/site-grabber/site-grabber-service.ts';
import {
  extensionOf,
  extractPageLinks,
  kindOfExtension,
} from '../apps/desktop/src/main/site-grabber/site-parser.ts';

const parsedLinks = extractPageLinks(`
  <a href="/docs/manual.pdf">Manual</a>
  <img src='/images/photo.jpg'>
  <div style="background:url(/archives/data.zip)"></div>
  <a href="mailto:test@example.com">mail</a>
`, 'https://example.test/root/index.html');
assert.deepEqual(parsedLinks, [
  'https://example.test/docs/manual.pdf',
  'https://example.test/images/photo.jpg',
  'https://example.test/archives/data.zip',
]);
assert.equal(extensionOf('https://example.test/a/video.MP4?token=x'), '.mp4');
assert.equal(kindOfExtension('.pdf'), 'document');
assert.equal(kindOfExtension('.mkv'), 'video');

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(`
      <a href="/page2">Page 2</a>
      <a href="/files/manual.pdf">Manual</a>
      <img src="/images/photo.jpg">
      <style>body { background-image: url('/archives/site.zip'); }</style>
      <a href="https://outside.example/file.pdf">Outside</a>
    `);
    return;
  }
  if (url.pathname === '/page2') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(`
      <a href="/media/movie.mp4">Movie</a>
      <a href="/private/secret.pdf">Secret</a>
      <a href="/page3">Too deep</a>
    `);
    return;
  }
  if (url.pathname === '/page3') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('<a href="/files/deep.pdf">Deep</a>');
    return;
  }
  response.setHeader('content-type', 'application/octet-stream');
  response.end('test-resource');
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server failed to start.');
  const changes: number[] = [];
  const service = new SiteGrabberService((job) => changes.push(job.resources.length));
  const started = service.start({
    rootUrl: `http://127.0.0.1:${address.port}/`,
    destination: '',
    maxDepth: 1,
    maxPages: 10,
    maxResources: 20,
    sameHostOnly: true,
    includeSubdomains: false,
    includeExtensions: ['.pdf', '.jpg', '.zip', '.mp4'],
    excludePatterns: ['/private/'],
  });
  await service.waitForCompletion(started.id);
  const completed = service.get(started.id);

  assert.equal(completed.status, 'completed');
  assert.equal(completed.scannedPages, 2);
  assert.deepEqual(
    completed.resources.map((resource) => new URL(resource.url).pathname).sort(),
    ['/archives/site.zip', '/files/manual.pdf', '/images/photo.jpg', '/media/movie.mp4'],
  );
  assert.equal(completed.resources.some((resource) => resource.url.includes('outside.example')), false);
  assert.equal(completed.resources.some((resource) => resource.url.includes('/private/')), false);
  assert.equal(completed.resources.some((resource) => resource.url.includes('/files/deep.pdf')), false);
  assert.ok(changes.length > 1, 'Crawler should emit progress snapshots.');

  const restored = new SiteGrabberService(() => undefined);
  restored.restore([{ ...completed, status: 'running', completedAt: undefined }]);
  const interrupted = restored.get(completed.id);
  assert.equal(interrupted.status, 'failed');
  assert.match(interrupted.error ?? '', /тасалдсан/);
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

console.log('Subutai site grabber tests passed.');
