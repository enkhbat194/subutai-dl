import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  PUBLIC_UPDATE_ERROR_MESSAGE,
  toSanitizedUpdateFailure,
} from '../apps/desktop/src/main/system/update-error.ts';

const root = resolve(import.meta.dirname, '..');
const runtime = readFileSync(
  join(root, 'apps', 'desktop', 'src', 'main', 'system', 'system-runtime.ts'),
  'utf8',
);

const raw = [
  'HttpError: 404 Not Found',
  'authorization: Bearer top-secret-token',
  'cookie: session=private-cookie',
  'set-cookie: gh_session=private-session',
  'https://user:password@example.test/releases.atom?token=query-token&signature=query-signature',
].join('\n');

const failure = toSanitizedUpdateFailure(new Error(raw));
assert.equal(failure.publicMessage, PUBLIC_UPDATE_ERROR_MESSAGE);
assert.equal(
  failure.publicMessage,
  'Шинэчлэлийн серверт хандаж чадсангүй. Дараа дахин оролдоно уу.',
);
assert.doesNotMatch(failure.publicMessage, /404|github|header|cookie|request|token/iu);
assert.match(failure.diagnosticMessage, /404 Not Found/u);
assert.doesNotMatch(
  failure.diagnosticMessage,
  /top-secret-token|private-cookie|private-session|password|query-token|query-signature/iu,
);
assert.match(failure.diagnosticMessage, /authorization: \[redacted\]/iu);
assert.match(failure.diagnosticMessage, /cookie: \[redacted\]/iu);
assert.match(failure.diagnosticMessage, /set-cookie: \[redacted\]/iu);
assert.match(failure.diagnosticMessage, /token=\[redacted\]/iu);
assert.match(failure.diagnosticMessage, /signature=\[redacted\]/iu);

const longFailure = toSanitizedUpdateFailure('x'.repeat(10_000));
assert.equal(longFailure.diagnosticMessage.length, 2_000);

for (const required of [
  "import { toSanitizedUpdateFailure } from './update-error';",
  'function recordUpdateFailure(error: unknown): void',
  'recordUpdateFailure(error);',
]) {
  assert.ok(runtime.includes(required), `Updater runtime is missing the public-error boundary: ${required}`);
}

assert.doesNotMatch(
  runtime,
  /setUpdate\(\{\s*status:\s*'error',\s*error:\s*(?:error\.message|error instanceof Error)/u,
  'Updater runtime must not copy raw updater errors into renderer-visible state.',
);

console.log('Subutai updater public-error policy passed: renderer messages are generic while bounded diagnostics redact headers, credentials, cookies and secret query values.');
