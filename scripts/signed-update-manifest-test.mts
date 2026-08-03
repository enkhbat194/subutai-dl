import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  assertUpdateNotReplayed,
  assertUpdaterResultMatchesManifest,
  compareReleaseVersions,
  releaseChannelForVersion,
  selectUpdateRelease,
  verifySignedUpdateEnvelope,
  type GitHubRelease,
  type SignedUpdatePayload,
} from '../apps/desktop/src/main/system/signed-update-manifest.ts';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const keyId = 'subutai-release-ed25519-test';
const trust = {
  schemaVersion: 1,
  keys: [{
    keyId,
    algorithm: 'ed25519',
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  }],
};
const hash = 'a'.repeat(64);
const payload: SignedUpdatePayload = {
  schemaVersion: 1,
  tag: 'v1.2.3-rc.2',
  version: '1.2.3-rc.2',
  channel: 'beta',
  issuedAt: new Date().toISOString(),
  artifacts: {
    latest: { name: 'latest.yml', sha256: hash },
    setup: { name: 'Subutai-Setup-1.2.3-rc.2-x64.exe', sha256: hash, sha512: Buffer.alloc(64, 1).toString('base64') },
    portable: { name: 'Subutai-Portable-1.2.3-rc.2-x64.exe', sha256: hash },
    signatures: { name: 'SIGNATURES.json', sha256: hash },
    checksums: { name: 'SHA256SUMS.txt', sha256: hash },
    blockmaps: [{ name: 'Subutai-Setup-1.2.3-rc.2-x64.exe.blockmap', sha256: hash }],
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

assert.deepEqual(verifySignedUpdateEnvelope(envelope, trust, 'beta'), payload);
assert.throws(() => verifySignedUpdateEnvelope({ ...envelope, signature: Buffer.alloc(64).toString('base64') }, trust, 'beta'), /signature is invalid/u);
assert.throws(() => verifySignedUpdateEnvelope(envelope, trust, 'stable'), /channel/u);
assert.equal(releaseChannelForVersion('2.0.0'), 'stable');
assert.equal(releaseChannelForVersion('2.0.0-beta.1'), 'beta');
assert.equal(compareReleaseVersions('2.0.0-rc.1', '2.0.0-beta.9'), 1);
assert.equal(compareReleaseVersions('2.0.0', '2.0.0-rc.9'), 1);
assert.throws(() => releaseChannelForVersion('2.0.0-alpha.1'), /Unsupported/u);
assert.doesNotThrow(() => assertUpdateNotReplayed(payload, '1.2.2', '1.2.3-beta.9'));
assert.throws(() => assertUpdateNotReplayed(payload, '1.2.3', null), /older than the installed/u);
assert.throws(() => assertUpdateNotReplayed(payload, '1.2.0', '1.2.3'), /last verified/u);

const releases: GitHubRelease[] = [
  { tag_name: 'v1.2.3-beta.2', draft: false, prerelease: true, assets: [] },
  { tag_name: 'v1.2.3-rc.1', draft: false, prerelease: true, assets: [] },
  { tag_name: 'v1.2.3', draft: false, prerelease: false, assets: [] },
  { tag_name: 'v9.0.0', draft: true, prerelease: false, assets: [] },
];
assert.equal(selectUpdateRelease(releases, 'beta').tag_name, 'v1.2.3-rc.1');
assert.equal(selectUpdateRelease(releases, 'stable').tag_name, 'v1.2.3');

const verified = {
  payload,
  latestYaml: 'version: 1.2.3-rc.2\n',
  feedUrl: 'https://github.com/enkhbat194/subutai-releases/releases/download/v1.2.3-rc.2/',
};
assert.doesNotThrow(() => assertUpdaterResultMatchesManifest({
  version: payload.version,
  files: [{ url: payload.artifacts.setup.name, sha512: payload.artifacts.setup.sha512 }],
}, verified));
assert.throws(() => assertUpdaterResultMatchesManifest({
  version: payload.version,
  files: [{ url: payload.artifacts.setup.name, sha512: 'tampered' }],
}, verified), /digest/u);

console.log('Subutai signed update manifest policy passed: Ed25519 trust, tamper rejection, stable/beta separation, prerelease ordering, downgrade/replay prevention and installer digest binding are locked.');
