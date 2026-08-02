const IPC_MAGIC = Buffer.from('SUBIPC01', 'ascii');
const START_MAGIC = Buffer.from('SUBSTRT1', 'ascii');
const STATUS_MAGIC = Buffer.from('SUBSTAT1', 'ascii');
const IPC_PROTOCOL_VERSION = 1;
const DESKTOP_PAYLOAD_SCHEMA_VERSION = 1;
const MAX_IPC_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_IPC_BUFFER_BYTES = MAX_IPC_PAYLOAD_BYTES + 1024 * 1024;
const MAX_FIELD_BYTES = 1024 * 1024;
const FIXED_BODY_BYTES = 8 + 2 + 1 + 1 + 8 + 4 + 8;
const UINT64_MASK = (1n << 64n) - 1n;

export const enum NativeMessageKind {
  Hello = 1,
  HelloAck = 2,
  ProbeRequest = 3,
  ProbeResult = 4,
  StartRequest = 5,
  PauseRequest = 6,
  ResumeRequest = 7,
  CancelRequest = 8,
  StatusRequest = 9,
  StatusEvent = 10,
  Error = 11,
  Shutdown = 12,
}

export type NativeTaskState = 'waiting' | 'active' | 'paused' | 'complete' | 'error' | 'removed';

export interface NativeStartPayload {
  taskId: string;
  url: string;
  destination: string;
  maximumConnections: number;
  minimumChunkBytes: bigint;
  checkpointBytes: bigint;
  headers: Record<string, string>;
}

export interface NativeStatusPayload {
  taskId: string;
  state: NativeTaskState;
  totalBytes: bigint;
  completedBytes: bigint;
  bytesPerSecond: bigint;
  activeConnections: number;
  filePath: string;
  errorCode: string;
  errorMessage: string;
}

export interface NativeFrame {
  requestId: bigint;
  kind: NativeMessageKind;
  payload: Buffer;
}

export function encodeNativeFrame(requestId: bigint, kind: NativeMessageKind, payload: Buffer<ArrayBufferLike> = Buffer.alloc(0)): Buffer {
  if (payload.length > MAX_IPC_PAYLOAD_BYTES) throw new Error(`Native IPC payload is too large: ${payload.length}`);
  const bodyLength = FIXED_BODY_BYTES + payload.length;
  const output = Buffer.allocUnsafe(4 + bodyLength);
  output.writeUInt32LE(bodyLength, 0);
  IPC_MAGIC.copy(output, 4);
  output.writeUInt16LE(IPC_PROTOCOL_VERSION, 12);
  output.writeUInt8(kind, 14);
  output.writeUInt8(0, 15);
  output.writeBigUInt64LE(requestId & UINT64_MASK, 16);
  output.writeUInt32LE(payload.length, 24);
  payload.copy(output, 28);
  output.writeBigUInt64LE(checksum64(output.subarray(4, 28 + payload.length)), 28 + payload.length);
  return output;
}

export class NativeFrameDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): NativeFrame[] {
    if (chunk.length === 0) return [];
    const nextLength = this.buffer.length + chunk.length;
    if (nextLength > MAX_IPC_BUFFER_BYTES) throw new Error(`Native IPC buffer limit exceeded: ${nextLength}`);
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    const frames: NativeFrame[] = [];
    while (this.buffer.length >= 4) {
      const bodyLength = this.buffer.readUInt32LE(0);
      if (bodyLength < FIXED_BODY_BYTES || bodyLength > MAX_IPC_BUFFER_BYTES) {
        throw new Error(`Invalid native IPC body length: ${bodyLength}`);
      }
      const frameLength = 4 + bodyLength;
      if (this.buffer.length < frameLength) break;
      frames.push(decodeNativeFrame(this.buffer.subarray(0, frameLength)));
      this.buffer = this.buffer.subarray(frameLength);
    }
    return frames;
  }

  finish(): void {
    if (this.buffer.length !== 0) throw new Error(`Native IPC stream ended with ${this.buffer.length} buffered bytes`);
  }
}

export function encodeStartPayload(value: NativeStartPayload): Buffer {
  if (!value.taskId.trim() || !value.url.trim() || !value.destination.trim()) {
    throw new Error('Native start payload requires task id, URL and destination');
  }
  const maximumConnections = Math.max(1, Math.min(32, Math.trunc(value.maximumConnections)));
  const headers = Object.entries(value.headers).filter(([, headerValue]) => headerValue.trim().length > 0);
  if (headers.length > 256) throw new Error(`Too many native request headers: ${headers.length}`);
  const parts: Buffer[] = [START_MAGIC, u16(DESKTOP_PAYLOAD_SCHEMA_VERSION)];
  parts.push(stringField(value.taskId));
  parts.push(stringField(value.url));
  parts.push(stringField(value.destination));
  parts.push(u32(maximumConnections));
  parts.push(u64(value.minimumChunkBytes));
  parts.push(u64(value.checkpointBytes));
  parts.push(u32(headers.length));
  for (const [name, headerValue] of headers) {
    parts.push(stringField(name));
    parts.push(stringField(headerValue));
  }
  return Buffer.concat(parts);
}

export function decodeStatusPayload(payload: Buffer): NativeStatusPayload {
  const cursor = new PayloadCursor(payload);
  if (!cursor.take(STATUS_MAGIC.length).equals(STATUS_MAGIC)) throw new Error('Invalid native status payload magic');
  const schema = cursor.readU16();
  if (schema !== DESKTOP_PAYLOAD_SCHEMA_VERSION) throw new Error(`Unsupported native status schema: ${schema}`);
  const taskId = cursor.readString();
  const state = decodeTaskState(cursor.readU8());
  const totalBytes = cursor.readU64();
  const completedBytes = cursor.readU64();
  const bytesPerSecond = cursor.readU64();
  const activeConnections = cursor.readU32();
  const filePath = cursor.readString();
  const errorCode = cursor.readString();
  const errorMessage = cursor.readString();
  cursor.finish();
  return {
    taskId,
    state,
    totalBytes,
    completedBytes,
    bytesPerSecond,
    activeConnections,
    filePath,
    errorCode,
    errorMessage,
  };
}

function decodeNativeFrame(frame: Buffer): NativeFrame {
  const bodyLength = frame.readUInt32LE(0);
  if (frame.length !== 4 + bodyLength) throw new Error('Native IPC frame length mismatch');
  if (!frame.subarray(4, 12).equals(IPC_MAGIC)) throw new Error('Invalid native IPC magic');
  const version = frame.readUInt16LE(12);
  if (version !== IPC_PROTOCOL_VERSION) throw new Error(`Unsupported native IPC version: ${version}`);
  const kind = frame.readUInt8(14) as NativeMessageKind;
  const flags = frame.readUInt8(15);
  if (flags !== 0) throw new Error(`Unsupported native IPC flags: ${flags}`);
  const requestId = frame.readBigUInt64LE(16);
  const payloadLength = frame.readUInt32LE(24);
  if (payloadLength > MAX_IPC_PAYLOAD_BYTES) throw new Error(`Native IPC payload is too large: ${payloadLength}`);
  const payloadEnd = 28 + payloadLength;
  if (payloadEnd + 8 !== frame.length) throw new Error('Native IPC payload length mismatch');
  const expectedChecksum = frame.readBigUInt64LE(payloadEnd);
  const actualChecksum = checksum64(frame.subarray(4, payloadEnd));
  if (expectedChecksum !== actualChecksum) throw new Error('Native IPC checksum mismatch');
  return { requestId, kind, payload: Buffer.from(frame.subarray(28, payloadEnd)) };
}

function decodeTaskState(value: number): NativeTaskState {
  switch (value) {
    case 1: return 'waiting';
    case 2: return 'active';
    case 3: return 'paused';
    case 4: return 'complete';
    case 5: return 'error';
    case 6: return 'removed';
    default: throw new Error(`Invalid native task state: ${value}`);
  }
}

function checksum64(input: Buffer): bigint {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x00000100000001b3n;
  for (const byte of input) hash = ((hash ^ BigInt(byte)) * prime) & UINT64_MASK;
  return hash;
}

function stringField(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > MAX_FIELD_BYTES) throw new Error(`Native payload field is too large: ${bytes.length}`);
  return Buffer.concat([u32(bytes.length), bytes]);
}

function u16(value: number): Buffer {
  const output = Buffer.allocUnsafe(2);
  output.writeUInt16LE(value, 0);
  return output;
}

function u32(value: number): Buffer {
  const output = Buffer.allocUnsafe(4);
  output.writeUInt32LE(value, 0);
  return output;
}

function u64(value: bigint): Buffer {
  if (value <= 0n || value > UINT64_MASK) throw new Error(`Invalid native u64 value: ${value}`);
  const output = Buffer.allocUnsafe(8);
  output.writeBigUInt64LE(value, 0);
  return output;
}

class PayloadCursor {
  private offset = 0;

  constructor(private readonly input: Buffer) {}

  take(length: number): Buffer {
    const end = this.offset + length;
    if (!Number.isSafeInteger(end) || end > this.input.length) throw new Error('Native payload ended unexpectedly');
    const value = this.input.subarray(this.offset, end);
    this.offset = end;
    return value;
  }

  readU8(): number {
    return this.take(1).readUInt8(0);
  }

  readU16(): number {
    return this.take(2).readUInt16LE(0);
  }

  readU32(): number {
    return this.take(4).readUInt32LE(0);
  }

  readU64(): bigint {
    return this.take(8).readBigUInt64LE(0);
  }

  readString(): string {
    const length = this.readU32();
    if (length > MAX_FIELD_BYTES) throw new Error(`Native payload field is too large: ${length}`);
    return this.take(length).toString('utf8');
  }

  finish(): void {
    if (this.offset !== this.input.length) throw new Error(`Native payload has ${this.input.length - this.offset} trailing bytes`);
  }
}
