import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const privateKeyBase64 = process.env.SUBUTAI_UPDATE_SIGNING_KEY_BASE64?.trim() ?? '';
const publicKeyBase64 = process.env.SUBUTAI_UPDATE_PUBLIC_KEY_BASE64?.trim() ?? '';
const keyId = process.env.SUBUTAI_UPDATE_KEY_ID?.trim() || 'subutai-release-ed25519-v1';

if (!privateKeyBase64 || !publicKeyBase64) {
  throw new Error('SUBUTAI_UPDATE_SIGNING_KEY_BASE64 and SUBUTAI_UPDATE_PUBLIC_KEY_BASE64 are required.');
}
if (!/^[a-z0-9][a-z0-9._-]{2,63}$/u.test(keyId)) throw new Error('SUBUTAI_UPDATE_KEY_ID is invalid.');

const privateKey = createPrivateKey({ key: Buffer.from(privateKeyBase64, 'base64'), format: 'der', type: 'pkcs8' });
const publicKey = createPublicKey({ key: Buffer.from(publicKeyBase64, 'base64'), format: 'der', type: 'spki' });
if (privateKey.asymmetricKeyType !== 'ed25519' || publicKey.asymmetricKeyType !== 'ed25519') {
  throw new Error('Update manifest keys must be Ed25519 keys.');
}
const challenge = randomBytes(32);
if (!verify(null, challenge, publicKey, sign(null, challenge, privateKey))) {
  throw new Error('Update manifest private and public keys do not match.');
}

const output = join(root, 'apps', 'desktop', 'resources', 'update', 'trust.json');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify({
  schemaVersion: 1,
  keys: [{ keyId, algorithm: 'ed25519', publicKey: publicKeyBase64 }],
}, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
console.log(`Prepared packaged update trust for key ${keyId}.`);
