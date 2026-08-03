import { createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const path = join(process.cwd(), 'resources', 'update', 'trust.json');
let trust;
try {
  trust = JSON.parse(await readFile(path, 'utf8'));
} catch {
  throw new Error('Prepared resources/update/trust.json is required for a signed Windows build.');
}
if (trust?.schemaVersion !== 1 || !Array.isArray(trust.keys) || trust.keys.length < 1) {
  throw new Error('Prepared update trust is invalid.');
}
for (const key of trust.keys) {
  if (key?.algorithm !== 'ed25519' || typeof key.keyId !== 'string' || typeof key.publicKey !== 'string') {
    throw new Error('Prepared update trust key is invalid.');
  }
  const publicKey = createPublicKey({ key: Buffer.from(key.publicKey, 'base64'), format: 'der', type: 'spki' });
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('Prepared update trust key must be Ed25519.');
}
console.log('Prepared packaged update trust validated.');
