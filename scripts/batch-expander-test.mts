import assert from 'node:assert/strict';
import { previewBatch } from '../apps/desktop/src/main/batch/batch-expander.ts';

const padded = previewBatch({ input: 'https://example.test/file_[001-003].zip' });
assert.deepEqual(padded.urls, [
  'https://example.test/file_001.zip',
  'https://example.test/file_002.zip',
  'https://example.test/file_003.zip',
]);

const descending = previewBatch({ input: 'https://example.test/{10..04..2}.jpg' });
assert.deepEqual(descending.urls, [
  'https://example.test/10.jpg',
  'https://example.test/08.jpg',
  'https://example.test/06.jpg',
  'https://example.test/04.jpg',
]);

const nested = previewBatch({ input: 'https://example.test/set_[01-02]/part_{1..3}.bin' });
assert.equal(nested.total, 6);
assert.equal(nested.urls[5], 'https://example.test/set_02/part_3.bin');

const mixed = previewBatch({ input: [
  'https://example.test/a.zip',
  'https://example.test/a.zip',
  'not-a-url',
  'ftp://example.test/file_[1-2].bin',
].join('\n') });
assert.equal(mixed.total, 3);
assert.equal(mixed.duplicateCount, 1);
assert.deepEqual(mixed.invalidLines, ['not-a-url']);

const limited = previewBatch({ input: 'https://example.test/[0001-9999].bin', maxItems: 25 });
assert.equal(limited.total, 25);
assert.equal(limited.truncated, true);

console.log('Subutai batch expansion tests passed.');
