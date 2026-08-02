import { readFileSync, writeFileSync } from 'node:fs';

const path = 'engines/native/tests/failure_injection.rs';
const original = readFileSync(path, 'utf8');
const newline = original.includes('\r\n') ? '\r\n' : '\n';
let source = original.replace(/\r\n/gu, '\n');
const before = `    request.requested_segments = 1;\n    request.minimum_segment_size = 2 * 1024 * 1024;`;
const after = `    request.requested_segments = 1;\n    request.adaptive.minimum_connections = 1;\n    request.minimum_segment_size = 2 * 1024 * 1024;`;

if (source.includes(after)) {
  console.log('Failure-test connection policy is already current.');
} else if (source.includes(before)) {
  source = source.replace(before, after);
  writeFileSync(path, source.replace(/\n/gu, newline));
  console.log('Failure-test connection policy updated.');
} else {
  throw new Error('Failure-test request helper contract was not found.');
}
