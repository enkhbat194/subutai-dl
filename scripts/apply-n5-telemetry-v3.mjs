import { readFileSync, writeFileSync } from 'node:fs';

function update(path, transform) {
  const original = readFileSync(path, 'utf8');
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const next = transform(original.replace(/\r\n/gu, '\n'));
  writeFileSync(path, next.replace(/\n/gu, newline));
}

function replaceOnce(source, path, before, after) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`${path}: expected source block was not found`);
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${path}: expected source block is not unique`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function replaceAllRequired(source, path, before, after, minimum = 1) {
  const count = source.split(before).length - 1;
  if (count < minimum) throw new Error(`${path}: expected at least ${minimum} matches, found ${count}`);
  return source.split(before).join(after);
}

update('engines/native/src/desktop_protocol.rs', (initial) => {
  const path = 'engines/native/src/desktop_protocol.rs';
  let source = replaceOnce(
    initial,
    path,
    `pub const DESKTOP_PAYLOAD_SCHEMA_VERSION: u16 = 2;\nconst START_MAGIC`,
    `pub const DESKTOP_PAYLOAD_SCHEMA_VERSION: u16 = 2;\npub const DESKTOP_STATUS_PAYLOAD_SCHEMA_VERSION: u16 = 3;\nconst LEGACY_DESKTOP_STATUS_PAYLOAD_SCHEMA_VERSION: u16 = 2;\nconst START_MAGIC`,
  );
  source = replaceOnce(
    source,
    path,
    `    pub bytes_per_second: u64,\n    pub active_connections: u32,\n    pub file_path: String,`,
    `    pub bytes_per_second: u64,\n    pub active_connections: u32,\n    pub connection_limit: u32,\n    pub peak_connections: u32,\n    pub queued_segments: u32,\n    pub replacement_count: u64,\n    pub retry_count: u64,\n    pub elapsed_milliseconds: u64,\n    pub file_path: String,`,
  );
  source = replaceOnce(
    source,
    path,
    `    output.extend_from_slice(&DESKTOP_PAYLOAD_SCHEMA_VERSION.to_le_bytes());\n    write_string(&mut output, &value.task_id)?;\n    output.push(value.state as u8);\n    output.extend_from_slice(&value.total_bytes.to_le_bytes());\n    output.extend_from_slice(&value.completed_bytes.to_le_bytes());\n    output.extend_from_slice(&value.bytes_per_second.to_le_bytes());\n    output.extend_from_slice(&value.active_connections.to_le_bytes());\n    write_string(&mut output, &value.file_path)?;`,
    `    output.extend_from_slice(&DESKTOP_STATUS_PAYLOAD_SCHEMA_VERSION.to_le_bytes());\n    write_string(&mut output, &value.task_id)?;\n    output.push(value.state as u8);\n    output.extend_from_slice(&value.total_bytes.to_le_bytes());\n    output.extend_from_slice(&value.completed_bytes.to_le_bytes());\n    output.extend_from_slice(&value.bytes_per_second.to_le_bytes());\n    output.extend_from_slice(&value.active_connections.to_le_bytes());\n    output.extend_from_slice(&value.connection_limit.to_le_bytes());\n    output.extend_from_slice(&value.peak_connections.to_le_bytes());\n    output.extend_from_slice(&value.queued_segments.to_le_bytes());\n    output.extend_from_slice(&value.replacement_count.to_le_bytes());\n    output.extend_from_slice(&value.retry_count.to_le_bytes());\n    output.extend_from_slice(&value.elapsed_milliseconds.to_le_bytes());\n    write_string(&mut output, &value.file_path)?;`,
  );
  source = replaceOnce(
    source,
    path,
    `pub fn decode_status_event(input: &[u8]) -> Result<DesktopStatusEvent, DesktopProtocolError> {\n    let mut cursor = Cursor::new(input);\n    if cursor.take(STATUS_MAGIC.len())? != STATUS_MAGIC {\n        return Err(DesktopProtocolError::InvalidMagic);\n    }\n    read_schema(&mut cursor)?;\n    let value = DesktopStatusEvent {\n        task_id: cursor.read_string()?,\n        state: DesktopTaskState::try_from(cursor.read_u8()?)?,\n        total_bytes: cursor.read_u64()?,\n        completed_bytes: cursor.read_u64()?,\n        bytes_per_second: cursor.read_u64()?,\n        active_connections: cursor.read_u32()?,\n        file_path: cursor.read_string()?,\n        error_code: cursor.read_string()?,\n        error_message: cursor.read_string()?,\n    };\n    cursor.finish()?;\n    Ok(value)\n}`,
    `pub fn decode_status_event(input: &[u8]) -> Result<DesktopStatusEvent, DesktopProtocolError> {\n    let mut cursor = Cursor::new(input);\n    if cursor.take(STATUS_MAGIC.len())? != STATUS_MAGIC {\n        return Err(DesktopProtocolError::InvalidMagic);\n    }\n    let schema = cursor.read_u16()?;\n    if schema != DESKTOP_STATUS_PAYLOAD_SCHEMA_VERSION\n        && schema != LEGACY_DESKTOP_STATUS_PAYLOAD_SCHEMA_VERSION\n    {\n        return Err(DesktopProtocolError::UnsupportedSchema(schema));\n    }\n    let task_id = cursor.read_string()?;\n    let state = DesktopTaskState::try_from(cursor.read_u8()?)?;\n    let total_bytes = cursor.read_u64()?;\n    let completed_bytes = cursor.read_u64()?;\n    let bytes_per_second = cursor.read_u64()?;\n    let active_connections = cursor.read_u32()?;\n    let (connection_limit, peak_connections, queued_segments, replacement_count, retry_count, elapsed_milliseconds) =\n        if schema == DESKTOP_STATUS_PAYLOAD_SCHEMA_VERSION {\n            (\n                cursor.read_u32()?,\n                cursor.read_u32()?,\n                cursor.read_u32()?,\n                cursor.read_u64()?,\n                cursor.read_u64()?,\n                cursor.read_u64()?,\n            )\n        } else {\n            (active_connections, active_connections, 0, 0, 0, 0)\n        };\n    let value = DesktopStatusEvent {\n        task_id,\n        state,\n        total_bytes,\n        completed_bytes,\n        bytes_per_second,\n        active_connections,\n        connection_limit,\n        peak_connections,\n        queued_segments,\n        replacement_count,\n        retry_count,\n        elapsed_milliseconds,\n        file_path: cursor.read_string()?,\n        error_code: cursor.read_string()?,\n        error_message: cursor.read_string()?,\n    };\n    cursor.finish()?;\n    Ok(value)\n}`,
  );
  source = replaceAllRequired(
    source,
    path,
    `            active_connections: 3,\n            file_path:`,
    `            active_connections: 3,\n            connection_limit: 5,\n            peak_connections: 6,\n            queued_segments: 7,\n            replacement_count: 8,\n            retry_count: 9,\n            elapsed_milliseconds: 10,\n            file_path:`,
  );
  source = replaceAllRequired(
    source,
    path,
    `            active_connections: 0,\n            file_path:`,
    `            active_connections: 0,\n            connection_limit: 0,\n            peak_connections: 0,\n            queued_segments: 0,\n            replacement_count: 0,\n            retry_count: 0,\n            elapsed_milliseconds: 0,\n            file_path:`,
  );
  source = replaceOnce(
    source,
    path,
    `    #[test]\n    fn malformed_payloads_are_rejected() {`,
    `    #[test]\n    fn status_decoder_accepts_schema_v2_without_telemetry() {\n        let mut encoded = Vec::new();\n        encoded.extend_from_slice(STATUS_MAGIC);\n        encoded.extend_from_slice(&LEGACY_DESKTOP_STATUS_PAYLOAD_SCHEMA_VERSION.to_le_bytes());\n        write_string(&mut encoded, "legacy").unwrap();\n        encoded.push(DesktopTaskState::Active as u8);\n        encoded.extend_from_slice(&100_u64.to_le_bytes());\n        encoded.extend_from_slice(&50_u64.to_le_bytes());\n        encoded.extend_from_slice(&25_u64.to_le_bytes());\n        encoded.extend_from_slice(&2_u32.to_le_bytes());\n        write_string(&mut encoded, r"C:\\legacy.bin").unwrap();\n        write_string(&mut encoded, "").unwrap();\n        write_string(&mut encoded, "").unwrap();\n\n        let decoded = decode_status_event(&encoded).expect("decode legacy status");\n        assert_eq!(decoded.active_connections, 2);\n        assert_eq!(decoded.connection_limit, 2);\n        assert_eq!(decoded.peak_connections, 2);\n        assert_eq!(decoded.queued_segments, 0);\n        assert_eq!(decoded.replacement_count, 0);\n        assert_eq!(decoded.retry_count, 0);\n        assert_eq!(decoded.elapsed_milliseconds, 0);\n    }\n\n    #[test]\n    fn malformed_payloads_are_rejected() {`,
  );
  return source;
});

update('engines/native/src/desktop_main.rs', (initial) => {
  const path = 'engines/native/src/desktop_main.rs';
  let source = replaceOnce(
    initial,
    path,
    `            active_connections: u32::try_from(progress.active_connections).unwrap_or(u32::MAX),\n            file_path:`,
    `            active_connections: u32::try_from(progress.active_connections).unwrap_or(u32::MAX),\n            connection_limit: u32::try_from(progress.connection_limit).unwrap_or(u32::MAX),\n            peak_connections: u32::try_from(progress.peak_connections).unwrap_or(u32::MAX),\n            queued_segments: u32::try_from(progress.queued_segments).unwrap_or(u32::MAX),\n            replacement_count: progress.replacement_count,\n            retry_count: progress.retry_count,\n            elapsed_milliseconds: u64::try_from(progress.elapsed.as_millis()).unwrap_or(u64::MAX),\n            file_path:`,
  );
  source = replaceAllRequired(
    source,
    path,
    `                active_connections: 0,\n                file_path:`,
    `                active_connections: 0,\n                connection_limit: 0,\n                peak_connections: 0,\n                queued_segments: 0,\n                replacement_count: 0,\n                retry_count: 0,\n                elapsed_milliseconds: 0,\n                file_path:`,
    4,
  );
  source = replaceOnce(
    source,
    path,
    `        active_connections: 0,\n        file_path:`,
    `        active_connections: 0,\n        connection_limit: 0,\n        peak_connections: 0,\n        queued_segments: 0,\n        replacement_count: 0,\n        retry_count: 0,\n        elapsed_milliseconds: 0,\n        file_path:`,
  );
  return source;
});

update('apps/desktop/src/main/engines/native-engine-protocol.ts', (initial) => {
  const path = 'apps/desktop/src/main/engines/native-engine-protocol.ts';
  let source = replaceOnce(
    initial,
    path,
    `const DESKTOP_PAYLOAD_SCHEMA_VERSION = 2;`,
    `const DESKTOP_PAYLOAD_SCHEMA_VERSION = 2;\nconst STATUS_PAYLOAD_SCHEMA_VERSION = 3;\nconst LEGACY_STATUS_PAYLOAD_SCHEMA_VERSION = 2;`,
  );
  source = replaceOnce(
    source,
    path,
    `  bytesPerSecond: bigint;\n  activeConnections: number;\n  filePath: string;`,
    `  bytesPerSecond: bigint;\n  activeConnections: number;\n  connectionLimit: number;\n  peakConnections: number;\n  queuedSegments: number;\n  replacementCount: bigint;\n  retryCount: bigint;\n  elapsedMilliseconds: bigint;\n  filePath: string;`,
  );
  source = replaceOnce(
    source,
    path,
    `export function decodeStatusPayload(payload: Buffer): NativeStatusPayload {\n  const cursor = new PayloadCursor(payload);\n  if (!cursor.take(STATUS_MAGIC.length).equals(STATUS_MAGIC)) throw new Error('Invalid native status payload magic');\n  const schema = cursor.readU16();\n  if (schema !== DESKTOP_PAYLOAD_SCHEMA_VERSION) throw new Error(\`Unsupported native status schema: \${schema}\`);\n  const taskId = cursor.readString();\n  const state = decodeTaskState(cursor.readU8());\n  const totalBytes = cursor.readU64();\n  const completedBytes = cursor.readU64();\n  const bytesPerSecond = cursor.readU64();\n  const activeConnections = cursor.readU32();\n  const filePath = cursor.readString();\n  const errorCode = cursor.readString();\n  const errorMessage = cursor.readString();\n  cursor.finish();\n  return {\n    taskId,\n    state,\n    totalBytes,\n    completedBytes,\n    bytesPerSecond,\n    activeConnections,\n    filePath,\n    errorCode,\n    errorMessage,\n  };\n}`,
    `export function decodeStatusPayload(payload: Buffer): NativeStatusPayload {\n  const cursor = new PayloadCursor(payload);\n  if (!cursor.take(STATUS_MAGIC.length).equals(STATUS_MAGIC)) throw new Error('Invalid native status payload magic');\n  const schema = cursor.readU16();\n  if (schema !== STATUS_PAYLOAD_SCHEMA_VERSION && schema !== LEGACY_STATUS_PAYLOAD_SCHEMA_VERSION) {\n    throw new Error(\`Unsupported native status schema: \${schema}\`);\n  }\n  const taskId = cursor.readString();\n  const state = decodeTaskState(cursor.readU8());\n  const totalBytes = cursor.readU64();\n  const completedBytes = cursor.readU64();\n  const bytesPerSecond = cursor.readU64();\n  const activeConnections = cursor.readU32();\n  const hasTelemetry = schema === STATUS_PAYLOAD_SCHEMA_VERSION;\n  const connectionLimit = hasTelemetry ? cursor.readU32() : activeConnections;\n  const peakConnections = hasTelemetry ? cursor.readU32() : activeConnections;\n  const queuedSegments = hasTelemetry ? cursor.readU32() : 0;\n  const replacementCount = hasTelemetry ? cursor.readU64() : 0n;\n  const retryCount = hasTelemetry ? cursor.readU64() : 0n;\n  const elapsedMilliseconds = hasTelemetry ? cursor.readU64() : 0n;\n  const filePath = cursor.readString();\n  const errorCode = cursor.readString();\n  const errorMessage = cursor.readString();\n  cursor.finish();\n  return {\n    taskId,\n    state,\n    totalBytes,\n    completedBytes,\n    bytesPerSecond,\n    activeConnections,\n    connectionLimit,\n    peakConnections,\n    queuedSegments,\n    replacementCount,\n    retryCount,\n    elapsedMilliseconds,\n    filePath,\n    errorCode,\n    errorMessage,\n  };\n}`,
  );
  return source;
});

update('packages/shared/src/index.ts', (initial) => {
  const path = 'packages/shared/src/index.ts';
  let source = replaceOnce(
    initial,
    path,
    `export interface DownloadJob {`,
    `export interface NativeTransferTelemetry {\n  activeConnections: number;\n  connectionLimit: number;\n  peakConnections: number;\n  queuedSegments: number;\n  replacementCount: number;\n  retryCount: number;\n  elapsedMilliseconds: number;\n}\n\nexport interface DownloadJob {`,
  );
  source = replaceOnce(
    source,
    path,
    `  retryCount?: number;\n  lastRetryAt?: string;`,
    `  retryCount?: number;\n  nativeTelemetry?: NativeTransferTelemetry;\n  lastRetryAt?: string;`,
  );
  return source;
});

update('apps/desktop/src/main/engines/native-engine-service.ts', (initial) => {
  const path = 'apps/desktop/src/main/engines/native-engine-service.ts';
  let source = replaceOnce(
    initial,
    path,
    `import type { TransferSettings } from '@subutai/shared';`,
    `import type { NativeTransferTelemetry, TransferSettings } from '@subutai/shared';`,
  );
  source = replaceOnce(
    source,
    path,
    `  connections: string;\n  errorCode?: string;`,
    `  connections: string;\n  telemetry?: NativeTransferTelemetry;\n  errorCode?: string;`,
  );
  source = replaceOnce(
    source,
    path,
    `  private applyStatus(task: NativeTask, event: NativeStatusPayload): void {\n    if (event.taskId !== task.id) {`,
    `  private applyStatus(task: NativeTask, event: NativeStatusPayload): void {\n    if (event.taskId !== task.id) {`,
  );
  source = replaceOnce(
    source,
    path,
    `    const status: NativeEngineTaskStatus = {\n      gid: task.id,`,
    `    let telemetry: NativeTransferTelemetry = {\n      activeConnections: event.activeConnections,\n      connectionLimit: event.connectionLimit,\n      peakConnections: event.peakConnections,\n      queuedSegments: event.queuedSegments,\n      replacementCount: safeBigIntNumber(event.replacementCount),\n      retryCount: safeBigIntNumber(event.retryCount),\n      elapsedMilliseconds: safeBigIntNumber(event.elapsedMilliseconds),\n    };\n    if (event.state !== 'active' && isEmptyTelemetry(telemetry) && task.status.telemetry) {\n      telemetry = { ...task.status.telemetry, activeConnections: 0, queuedSegments: 0 };\n    }\n    const status: NativeEngineTaskStatus = {\n      gid: task.id,`,
  );
  source = replaceOnce(
    source,
    path,
    `      connections: String(event.activeConnections),\n      files: [{`,
    `      connections: String(event.activeConnections),\n      telemetry,\n      files: [{`,
  );
  source = replaceOnce(
    source,
    path,
    `function initialStatus(id: string, destinationPath: string): NativeEngineTaskStatus {`,
    `function safeBigIntNumber(value: bigint): number {\n  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);\n}\n\nfunction isEmptyTelemetry(value: NativeTransferTelemetry): boolean {\n  return value.activeConnections === 0\n    && value.connectionLimit === 0\n    && value.peakConnections === 0\n    && value.queuedSegments === 0\n    && value.replacementCount === 0\n    && value.retryCount === 0\n    && value.elapsedMilliseconds === 0;\n}\n\nfunction initialStatus(id: string, destinationPath: string): NativeEngineTaskStatus {`,
  );
  source = replaceOnce(
    source,
    path,
    `function cloneStatus(status: NativeEngineTaskStatus): NativeEngineTaskStatus {\n  const clone: NativeEngineTaskStatus = { ...status };\n  if (status.files) clone.files = status.files.map((file) => ({ ...file }));`,
    `function cloneStatus(status: NativeEngineTaskStatus): NativeEngineTaskStatus {\n  const clone: NativeEngineTaskStatus = { ...status };\n  if (status.telemetry) clone.telemetry = { ...status.telemetry };\n  if (status.files) clone.files = status.files.map((file) => ({ ...file }));`,
  );
  return source;
});

update('apps/desktop/src/main/engines/subutai-engine.ts', (initial) => {
  const path = 'apps/desktop/src/main/engines/subutai-engine.ts';
  let source = replaceOnce(
    initial,
    path,
    `  MediaProbeResult,\n  SubutaiEngineHealth,`,
    `  MediaProbeResult,\n  NativeTransferTelemetry,\n  SubutaiEngineHealth,`,
  );
  source = replaceOnce(
    source,
    path,
    `  connections: string;\n  errorCode?: string;`,
    `  connections: string;\n  telemetry?: NativeTransferTelemetry;\n  errorCode?: string;`,
  );
  return source;
});

update('apps/desktop/src/main/subutai-runtime.ts', (initial) => {
  const path = 'apps/desktop/src/main/subutai-runtime.ts';
  let source = replaceOnce(
    initial,
    path,
    `  job.engineTaskId = await engine.addDownload(options);`,
    `  if (job.engine !== 'media') delete job.nativeTelemetry;\n  job.engineTaskId = await engine.addDownload(options);`,
  );
  source = replaceOnce(
    source,
    path,
    `  job.connections = job.engine === 'media' ? 1 : Math.max(0, Number(status.connections) || job.connections);`,
    `  if (job.engine === 'media') job.connections = 1;\n  else if (status.telemetry) job.nativeTelemetry = { ...status.telemetry };`,
  );
  source = replaceOnce(
    source,
    path,
    `  applyMirrorTransition(job, transition);\n  return true;`,
    `  applyMirrorTransition(job, transition);\n  delete job.nativeTelemetry;\n  return true;`,
  );
  source = replaceOnce(
    source,
    path,
    `  job.remoteRestartCount = (job.remoteRestartCount ?? 0) + 1;`,
    `  delete job.nativeTelemetry;\n  job.remoteRestartCount = (job.remoteRestartCount ?? 0) + 1;`,
  );
  source = replaceOnce(
    source,
    path,
    `    restored.mirrorFallbackCount ??= restored.mirrorIndex;\n    order += 1;`,
    `    restored.mirrorFallbackCount ??= restored.mirrorIndex;\n    if (restored.nativeTelemetry) {\n      restored.nativeTelemetry.activeConnections = 0;\n      restored.nativeTelemetry.queuedSegments = 0;\n    }\n    order += 1;`,
  );
  return source;
});

update('package.json', (initial) => replaceOnce(
  initial,
  'package.json',
  `    "test:mirror": "node --experimental-strip-types scripts/mirror-policy-test.mts",`,
  `    "test:mirror": "node --experimental-strip-types scripts/mirror-policy-test.mts",\n    "test:telemetry": "node --experimental-strip-types scripts/telemetry-policy-test.mts",`,
));

console.log('N5 telemetry schema v3 migration applied.');
