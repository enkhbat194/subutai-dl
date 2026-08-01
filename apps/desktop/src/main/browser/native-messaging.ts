import { spawn } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  BrowserEnqueueMessage,
  BrowserNativeMessage,
  BrowserNativeResponse,
  DownloadCreateRequest,
} from '@subutai/shared';

const NATIVE_HOST_NAME = 'com.subutai.download_manager';
const FIREFOX_EXTENSION_ID = 'subutai-download@subutai.local';
const MAX_INBOUND_MESSAGE_BYTES = 64 * 1024 * 1024;
const MAX_HEADER_COUNT = 128;
const MAX_HEADER_VALUE_LENGTH = 16 * 1024;
const PAYLOAD_ARGUMENT = '--subutai-browser-file=';

export function isNativeMessagingInvocation(args: readonly string[]): boolean {
  return args.some((argument) =>
    argument.startsWith('chrome-extension://')
    || argument.startsWith('moz-extension://')
    || argument === FIREFOX_EXTENSION_ID
    || argument.toLowerCase().includes(`${NATIVE_HOST_NAME}.firefox.json`),
  );
}

function readOneNativeMessage(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let expectedLength: number | null = null;

    const cleanup = (): void => {
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.off('error', onError);
    };

    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    const onEnd = (): void => {
      cleanup();
      reject(new Error('Native messaging input ended before a complete message was received.'));
    };

    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      if (expectedLength === null && buffer.length >= 4) {
        expectedLength = buffer.readUInt32LE(0);
        if (expectedLength <= 0 || expectedLength > MAX_INBOUND_MESSAGE_BYTES) {
          cleanup();
          reject(new Error('Native messaging payload size is invalid.'));
          return;
        }
      }

      if (expectedLength !== null && buffer.length >= expectedLength + 4) {
        const payload = buffer.subarray(4, expectedLength + 4).toString('utf8');
        cleanup();
        try {
          resolve(JSON.parse(payload) as unknown);
        } catch {
          reject(new Error('Native messaging payload is not valid JSON.'));
        }
      }
    };

    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
    process.stdin.once('error', onError);
    process.stdin.resume();
  });
}

function writeNativeResponse(response: BrowserNativeResponse): void {
  const payload = Buffer.from(JSON.stringify(response), 'utf8');
  if (payload.length > 1024 * 1024) throw new Error('Native messaging response is too large.');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(payload.length, 0);
  process.stdout.write(Buffer.concat([header, payload]));
}

function cleanHeaders(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(value).slice(0, MAX_HEADER_COUNT)) {
    const name = rawName.trim();
    if (!name || /[\r\n:]/u.test(name) || typeof rawValue !== 'string') continue;
    const headerValue = rawValue.replace(/[\r\n]+/gu, ' ').trim().slice(0, MAX_HEADER_VALUE_LENGTH);
    if (headerValue) result[name] = headerValue;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function validateMessage(value: unknown): BrowserNativeMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Native message must be an object.');
  }

  const message = value as Record<string, unknown>;
  const requestId = typeof message.requestId === 'string' && message.requestId.length <= 128
    ? message.requestId
    : crypto.randomUUID();

  if (message.type === 'ping') return { type: 'ping', requestId };
  if (message.type !== 'enqueue') throw new Error('Unsupported native message type.');
  if (typeof message.url !== 'string' || message.url.length > 16_384) throw new Error('Download URL is invalid.');

  const parsed = new URL(message.url);
  if (!['http:', 'https:', 'ftp:', 'sftp:'].includes(parsed.protocol)) {
    throw new Error(`Unsupported download protocol: ${parsed.protocol}`);
  }

  const source = message.source;
  if (source !== 'chrome' && source !== 'edge' && source !== 'firefox') {
    throw new Error('Browser source is invalid.');
  }

  const result: BrowserEnqueueMessage = {
    type: 'enqueue',
    requestId,
    url: parsed.toString(),
    source,
  };

  if (typeof message.filename === 'string' && message.filename.trim()) {
    result.filename = message.filename.trim().slice(0, 255);
  }
  if (typeof message.sourcePageUrl === 'string' && message.sourcePageUrl.length <= 16_384) {
    result.sourcePageUrl = message.sourcePageUrl;
  }
  if (typeof message.connections === 'number' && Number.isFinite(message.connections)) {
    result.connections = Math.max(1, Math.min(32, Math.trunc(message.connections)));
  }
  const headers = cleanHeaders(message.headers);
  if (headers) result.headers = headers;
  return result;
}

async function launchDesktopWithPayload(message: BrowserEnqueueMessage): Promise<void> {
  const payloadPath = join(tmpdir(), `subutai-browser-${process.pid}-${crypto.randomUUID()}.json`);
  await writeFile(payloadPath, JSON.stringify(message), { encoding: 'utf8', mode: 0o600, flag: 'wx' });

  const appArgument = `${PAYLOAD_ARGUMENT}${payloadPath}`;
  const args = process.defaultApp && process.argv[1]
    ? [process.argv[1], appArgument]
    : [appArgument];

  const child = spawn(process.execPath, args, {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  });
  child.unref();
}

export async function runNativeMessagingHost(): Promise<void> {
  let requestId: string = crypto.randomUUID();
  try {
    const message = validateMessage(await readOneNativeMessage());
    requestId = message.requestId;
    if (message.type === 'enqueue') await launchDesktopWithPayload(message);
    writeNativeResponse({ ok: true, requestId, accepted: message.type === 'enqueue' ? 1 : 0 });
  } catch (error) {
    const response: BrowserNativeResponse = {
      ok: false,
      requestId,
      error: error instanceof Error ? error.message : String(error),
    };
    writeNativeResponse(response);
    process.exitCode = 1;
  }
}

export async function consumeBrowserPayloadArguments(
  args: readonly string[],
  enqueue: (request: DownloadCreateRequest) => Promise<unknown>,
): Promise<number> {
  const paths = args
    .filter((argument) => argument.startsWith(PAYLOAD_ARGUMENT))
    .map((argument) => argument.slice(PAYLOAD_ARGUMENT.length))
    .filter(Boolean);

  let accepted = 0;
  for (const payloadPath of paths) {
    try {
      const raw = await readFile(payloadPath, 'utf8');
      const message = validateMessage(JSON.parse(raw) as unknown);
      if (message.type !== 'enqueue') continue;
      const request: DownloadCreateRequest = {
        url: message.url,
        destination: '',
        source: message.source,
        connections: message.connections ?? 16,
      };
      if (message.filename) request.filename = message.filename;
      if (message.headers) request.headers = message.headers;
      if (message.sourcePageUrl) request.sourcePageUrl = message.sourcePageUrl;
      await enqueue(request);
      accepted += 1;
    } finally {
      await rm(payloadPath, { force: true }).catch(() => undefined);
    }
  }
  return accepted;
}
