import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DownloadJob } from '../packages/shared/src/index.ts';
import {
  activeDownloadUrl,
  applyMirrorTransition,
  mirrorReasonFromFailure,
  nextMirrorSource,
  normalizeMirrorUrls,
  validateMirrorIntegrity,
} from '../apps/desktop/src/main/resilience/mirror-policy.ts';

const expectedSha256 = 'a'.repeat(64);
const mirrors = normalizeMirrorUrls('https://primary.test/file.bin', [
  ' https://mirror-one.test/file.bin ',
  'https://primary.test/file.bin',
  'https://mirror-one.test/file.bin',
  'https://mirror-two.test/file.bin?token=two',
]);
assert.deepEqual(mirrors, [
  'https://mirror-one.test/file.bin',
  'https://mirror-two.test/file.bin?token=two',
]);
validateMirrorIntegrity(mirrors, expectedSha256);
assert.throws(() => validateMirrorIntegrity(mirrors, undefined), /SHA-256/u);
assert.throws(
  () => normalizeMirrorUrls('https://primary.test/file.bin', ['ftp://mirror.test/file.bin']),
  /HTTP\/HTTPS/u,
);
assert.throws(
  () => normalizeMirrorUrls('https://primary.test/file.bin', Array.from({ length: 17 }, (_, index) => `https://m${index}.test/file`)),
  /16/u,
);

const job: DownloadJob = {
  id: 'mirror-test',
  url: 'https://primary.test/file.bin',
  filename: 'file.bin',
  destination: 'C:\\Downloads',
  engine: 'subutai',
  status: 'failed',
  downloadedBytes: 8192,
  totalBytes: 32768,
  speedBytesPerSecond: 100,
  etaSeconds: 10,
  connections: 4,
  createdAt: '2026-08-02T00:00:00.000Z',
  updatedAt: '2026-08-02T00:00:00.000Z',
  expectedSha256,
  mirrorUrls: mirrors,
  mirrorIndex: 0,
  activeSourceUrl: 'https://primary.test/file.bin',
  mirrorFallbackCount: 0,
  engineTaskId: 'direct:old-task',
  failureKind: 'network',
  error: 'connection reset',
  actualSha256: 'b'.repeat(64),
};

assert.equal(activeDownloadUrl(job), job.url);
assert.equal(mirrorReasonFromFailure('network'), 'network');
assert.equal(mirrorReasonFromFailure('server'), 'server');
assert.equal(mirrorReasonFromFailure('disk'), null);
assert.equal(mirrorReasonFromFailure('authentication'), null);

const first = nextMirrorSource(job, 'network');
assert.deepEqual(first, {
  index: 1,
  url: 'https://mirror-one.test/file.bin',
  reason: 'network',
});
assert.ok(first);
applyMirrorTransition(job, first, '2026-08-02T01:00:00.000Z');
assert.equal(job.status, 'queued');
assert.equal(job.mirrorIndex, 1);
assert.equal(job.activeSourceUrl, mirrors[0]);
assert.equal(job.mirrorFallbackCount, 1);
assert.equal(job.downloadedBytes, 0);
assert.equal(job.totalBytes, null);
assert.equal(job.engineTaskId, undefined);
assert.equal(job.error, undefined);
assert.equal(job.actualSha256, undefined);

const second = nextMirrorSource(job, 'integrity');
assert.deepEqual(second, {
  index: 2,
  url: 'https://mirror-two.test/file.bin?token=two',
  reason: 'integrity',
});
assert.ok(second);
applyMirrorTransition(job, second);
assert.equal(activeDownloadUrl(job), mirrors[1]);
assert.equal(job.mirrorFallbackCount, 2);
assert.equal(nextMirrorSource(job, 'server'), null);

const unsafeJob = { ...job, mirrorIndex: 0, expectedSha256: undefined };
assert.equal(nextMirrorSource(unsafeJob, 'network'), null);
const mediaJob = { ...job, engine: 'media' as const, mirrorIndex: 0 };
assert.equal(nextMirrorSource(mediaJob, 'network'), null);

const runtime = await readFile(join(process.cwd(), 'apps', 'desktop', 'src', 'main', 'subutai-runtime.ts'), 'utf8');
for (const contract of [
  'url: activeDownloadUrl(job)',
  'async function failoverToNextMirror(',
  "mirrorSwitched = await failoverToNextMirror(job, 'remote-change')",
  "await failoverToNextMirror(job, 'integrity')",
  'await removeDownloadFiles(destinationPath, false)',
  'job.mirrorIndex = 0',
  'job.activeSourceUrl = job.url',
]) {
  assert.ok(runtime.includes(contract), `desktop runtime is missing mirror contract: ${contract}`);
}

console.log('Subutai mirror policy passed: validated sources, SHA-256 requirement, ordered failover, no loops, safe reasons and runtime wiring.');
