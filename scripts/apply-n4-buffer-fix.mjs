import { readFile, writeFile } from 'node:fs/promises';

const path = 'apps/desktop/src/main/engines/native-engine-protocol.ts';
const source = (await readFile(path, 'utf8')).replace(/\r\n/gu, '\n');
const before = 'export function encodeNativeFrame(requestId: bigint, kind: NativeMessageKind, payload = Buffer.alloc(0)): Buffer {';
const after = 'export function encodeNativeFrame(requestId: bigint, kind: NativeMessageKind, payload: Buffer<ArrayBufferLike> = Buffer.alloc(0)): Buffer {';

if (source.includes(before)) {
  await writeFile(path, source.replace(before, after), 'utf8');
  console.log('N4 Buffer type fix applied.');
} else if (source.includes(after)) {
  await writeFile(path, source, 'utf8');
  console.log('N4 Buffer type fix is already applied.');
} else {
  throw new Error('N4 encodeNativeFrame signature was not found.');
}
