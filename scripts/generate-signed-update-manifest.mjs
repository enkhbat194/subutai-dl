import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = join(root, 'apps', 'desktop', 'release');
const packageJson = JSON.parse(await readFile(join(root, 'apps', 'desktop', 'package.json'), 'utf8'));
const version = packageJson.version;
const tag = process.argv[2] || process.env.RELEASE_TAG || '';
const keyId = process.env.SUBUTAI_UPDATE_KEY_ID?.trim() || 'subutai-release-ed25519-v1';
const privateKeyBase64 = process.env.SUBUTAI_UPDATE_SIGNING_KEY_BASE64?.trim() ?? '';
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(beta|rc)\.([1-9]\d*))?$/u;

if (!versionPattern.test(version) || tag !== `v${version}`) throw new Error('Release tag and package version do not match.');
if (!privateKeyBase64) throw new Error('SUBUTAI_UPDATE_SIGNING_KEY_BASE64 is required.');
const privateKey = createPrivateKey({ key: Buffer.from(privateKeyBase64, 'base64'), format: 'der', type: 'pkcs8' });
if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Update manifest signing key must be Ed25519.');

const names = await readdir(releaseDir);
const one = (pattern, label) => {
  const matches = names.filter((name) => pattern.test(name));
  if (matches.length !== 1) throw new Error(`Expected exactly one ${label}; found ${matches.length}.`);
  return matches[0];
};
const setupName = one(new RegExp(`^Subutai-Setup-${version.replaceAll('.', '\\.')}-.+\\.exe$`, 'u'), 'Setup installer');
const portableName = one(new RegExp(`^Subutai-Portable-${version.replaceAll('.', '\\.')}-.+\\.exe$`, 'u'), 'Portable executable');
const blockmapNames = names.filter((name) => name.endsWith('.blockmap')).sort();
if (blockmapNames.length === 0) throw new Error('No updater blockmap was generated.');

async function artifact(name, sha512) {
  const bytes = await readFile(join(releaseDir, name));
  return {
    name: basename(name),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ...(sha512 ? { sha512 } : {}),
  };
}

const latestText = await readFile(join(releaseDir, 'latest.yml'), 'utf8');
const latestVersion = /^version:\s*([^\r\n]+)\s*$/mu.exec(latestText)?.[1]?.trim();
const latestPath = /^path:\s*([^\r\n]+)\s*$/mu.exec(latestText)?.[1]?.trim();
const latestSha512 = /^sha512:\s*([^\r\n]+)\s*$/mu.exec(latestText)?.[1]?.trim();
if (latestVersion !== version || latestPath !== setupName || !latestSha512) {
  throw new Error('latest.yml does not match the release Setup installer.');
}

const payload = {
  schemaVersion: 1,
  tag,
  version,
  channel: version.includes('-') ? 'beta' : 'stable',
  issuedAt: new Date().toISOString(),
  artifacts: {
    latest: await artifact('latest.yml'),
    setup: await artifact(setupName, latestSha512),
    portable: await artifact(portableName),
    signatures: await artifact('SIGNATURES.json'),
    checksums: await artifact('SHA256SUMS.txt'),
    blockmaps: await Promise.all(blockmapNames.map((name) => artifact(name))),
  },
};
const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
const envelope = {
  schemaVersion: 1,
  algorithm: 'ed25519',
  keyId,
  payload: payloadBytes.toString('base64'),
  signature: sign(null, payloadBytes, privateKey).toString('base64'),
};
await writeFile(join(releaseDir, 'subutai-update-manifest.json'), `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
console.log(`Generated signed ${payload.channel} update manifest for ${tag}.`);
