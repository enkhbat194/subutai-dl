import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (path: string): string => readFileSync(join(root, path), 'utf8');
const rustProtocol = read('engines/native/src/desktop_protocol.rs');
const rustHost = read('engines/native/src/desktop_main.rs');
const tsProtocol = read('apps/desktop/src/main/engines/native-engine-protocol.ts');
const nativeService = read('apps/desktop/src/main/engines/native-engine-service.ts');
const engineFacade = read('apps/desktop/src/main/engines/subutai-engine.ts');
const shared = read('packages/shared/src/index.ts');
const runtime = read('apps/desktop/src/main/subutai-runtime.ts');

function requireText(source: string, expected: string, label: string): void {
  if (!source.includes(expected)) throw new Error(`${label} is missing required telemetry contract: ${expected}`);
}

for (const [field, progressField] of [
  ['connection_limit', 'connection_limit'],
  ['peak_connections', 'peak_connections'],
  ['queued_segments', 'queued_segments'],
  ['replacement_count', 'replacement_count'],
  ['retry_count', 'retry_count'],
  ['elapsed_milliseconds', 'elapsed'],
] as const) {
  requireText(rustProtocol, `pub ${field}:`, 'Rust desktop status protocol');
  requireText(rustHost, `${field}:`, 'Rust desktop host telemetry field');
  requireText(rustHost, `progress.${progressField}`, 'Rust desktop host progress source');
}
requireText(rustProtocol, 'DESKTOP_STATUS_PAYLOAD_SCHEMA_VERSION: u16 = 3', 'Rust status schema');
requireText(rustProtocol, 'LEGACY_DESKTOP_STATUS_PAYLOAD_SCHEMA_VERSION', 'Rust v2 compatibility');
requireText(rustProtocol, 'status_decoder_accepts_schema_v2_without_telemetry', 'Rust compatibility test');

for (const field of [
  'connectionLimit',
  'peakConnections',
  'queuedSegments',
  'replacementCount',
  'retryCount',
  'elapsedMilliseconds',
]) {
  requireText(tsProtocol, `${field}:`, 'TypeScript native status payload');
  requireText(nativeService, `${field}:`, 'Native service telemetry mapping');
  requireText(shared, `${field}: number`, 'Shared persisted telemetry');
}
requireText(tsProtocol, 'STATUS_PAYLOAD_SCHEMA_VERSION = 3', 'TypeScript status schema');
requireText(tsProtocol, 'LEGACY_STATUS_PAYLOAD_SCHEMA_VERSION = 2', 'TypeScript v2 compatibility');
requireText(nativeService, 'telemetry?: NativeTransferTelemetry', 'Native task status');
requireText(engineFacade, 'telemetry?: NativeTransferTelemetry', 'Engine facade status');
requireText(shared, 'nativeTelemetry?: NativeTransferTelemetry', 'Download job persistence');
requireText(runtime, 'job.nativeTelemetry = { ...status.telemetry }', 'Runtime telemetry persistence');
requireText(runtime, 'restored.nativeTelemetry.activeConnections = 0', 'Restart telemetry normalization');

if (/job\.connections\s*=\s*job\.engine\s*===\s*['"]media['"]/u.test(runtime)) {
  throw new Error('Configured direct connection count must not be overwritten by active telemetry.');
}

console.log('Subutai telemetry schema v3 policy passed: Rust/TypeScript compatibility, native mapping and persisted job wiring.');
