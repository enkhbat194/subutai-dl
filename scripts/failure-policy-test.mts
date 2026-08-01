import assert from 'node:assert/strict';
import {
  canAutoRetry,
  classifyDownloadFailure,
  isAutoRecoverableFailure,
} from '../apps/desktop/src/main/resilience/failure-policy.ts';

assert.equal(classifyDownloadFailure('HTTP 503 Service Unavailable'), 'server');
assert.equal(classifyDownloadFailure('socket ETIMEDOUT while connecting'), 'network');
assert.equal(classifyDownloadFailure('DNS name resolution failed'), 'network');
assert.equal(classifyDownloadFailure('HTTP 403 Forbidden'), 'authentication');
assert.equal(classifyDownloadFailure('ENOSPC: no space left on device'), 'disk');
assert.equal(classifyDownloadFailure('download cancelled by user'), 'cancelled');
assert.equal(classifyDownloadFailure('unrecognized engine error'), 'unknown');
assert.equal(isAutoRecoverableFailure('network'), true);
assert.equal(isAutoRecoverableFailure('server'), true);
assert.equal(isAutoRecoverableFailure('authentication'), false);

const base = {
  id: 'job',
  url: 'https://example.test/file.bin',
  filename: 'file.bin',
  destination: '/tmp',
  engine: 'subutai',
  status: 'failed',
  downloadedBytes: 0,
  totalBytes: null,
  speedBytesPerSecond: 0,
  etaSeconds: null,
  connections: 4,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

assert.equal(canAutoRetry({ ...base, failureKind: 'network', retryCount: 0 }), true);
assert.equal(canAutoRetry({ ...base, failureKind: 'server', retryCount: 4 }), true);
assert.equal(canAutoRetry({ ...base, failureKind: 'network', retryCount: 5 }), false);
assert.equal(canAutoRetry({ ...base, failureKind: 'disk', retryCount: 0 }), false);
assert.equal(canAutoRetry({ ...base, status: 'paused', failureKind: 'network', retryCount: 0 }), false);

console.log('Subutai failure policy tests passed.');
