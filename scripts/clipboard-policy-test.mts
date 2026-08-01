import assert from 'node:assert/strict';
import {
  DEFAULT_CLIPBOARD_SETTINGS,
  extractClipboardUrls,
  normalizeClipboardSettings,
} from '../apps/desktop/src/main/clipboard/clipboard-policy.ts';

const settings = normalizeClipboardSettings(DEFAULT_CLIPBOARD_SETTINGS, {
  enabled: true,
  captureMultipleUrls: true,
  cooldownMs: 100,
  maxHistory: 1000,
  ignoredHosts: ['ads.example.test'],
  ignoredExtensions: ['jpg', '.css'],
});

assert.equal(settings.cooldownMs, 1000);
assert.equal(settings.maxHistory, 500);
assert.deepEqual(settings.ignoredExtensions, ['.jpg', '.css']);

const urls = extractClipboardUrls([
  'Download https://example.test/file.zip).',
  'repeat https://example.test/file.zip',
  'ignore https://ads.example.test/tracker.bin',
  'ignore https://cdn.example.test/photo.JPG',
  'keep ftp://files.example.test/archive.7z!',
].join('\n'), settings);

assert.deepEqual(urls, [
  'https://example.test/file.zip',
  'ftp://files.example.test/archive.7z',
]);

const single = extractClipboardUrls(
  'https://example.test/a.zip https://example.test/b.zip',
  { ...settings, captureMultipleUrls: false },
);
assert.deepEqual(single, ['https://example.test/a.zip']);

assert.deepEqual(extractClipboardUrls('not a URL', settings), []);
console.log('Subutai clipboard policy tests passed.');
