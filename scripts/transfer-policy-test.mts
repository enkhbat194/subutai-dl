import assert from 'node:assert/strict';
import {
  DEFAULT_TRANSFER_SETTINGS,
  normalizeTransferSettings,
  resolveProxyUrl,
  ariaSpeed,
  ytDlpSpeed,
} from '../apps/desktop/src/main/network/transfer-policy.ts';

const normalized = normalizeTransferSettings(DEFAULT_TRANSFER_SETTINGS, {
  globalSpeedLimitBytesPerSecond: 12_500_000,
  defaultDownloadSpeedLimitBytesPerSecond: -100,
  proxyMode: 'manual',
  proxyUrl: 'proxy.example.test:8080',
  proxyUsername: 'user name',
  retryMaxAttempts: 500,
  retryBaseDelaySeconds: -5,
  connectTimeoutSeconds: 0,
  transferTimeoutSeconds: 99999,
}, true);

assert.equal(normalized.globalSpeedLimitBytesPerSecond, 12_500_000);
assert.equal(normalized.defaultDownloadSpeedLimitBytesPerSecond, 0);
assert.equal(normalized.retryMaxAttempts, 100);
assert.equal(normalized.retryBaseDelaySeconds, 0);
assert.equal(normalized.connectTimeoutSeconds, 1);
assert.equal(normalized.transferTimeoutSeconds, 3600);
assert.equal(normalized.proxyPasswordSet, true);

const proxy = resolveProxyUrl(normalized, 'p@ss word');
assert.equal(proxy, 'http://user%20name:p%40ss%20word@proxy.example.test:8080/');
assert.equal(resolveProxyUrl({ ...normalized, proxyMode: 'off' }, 'secret'), null);
assert.equal(ariaSpeed(0), '0');
assert.equal(ariaSpeed(1_234_567.8), '1234567');
assert.equal(ytDlpSpeed(0), null);
assert.equal(ytDlpSpeed(8_000_000), '8000000');

assert.throws(() => resolveProxyUrl({ ...normalized, proxyUrl: 'http://[' }, ''), /Proxy URL/);
console.log('Subutai transfer policy tests passed.');
