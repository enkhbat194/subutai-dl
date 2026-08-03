import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const UPDATE_MANIFEST_ASSET_NAME = 'subutai-update-manifest.json';
export const UPDATE_TRUST_STATE_KEY = 'verified-update-release';
const RELEASES_API_URL = 'https://api.github.com/repos/enkhbat194/subutai-releases/releases?per_page=50';
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(beta|rc)\.([1-9]\d*))?$/u;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export type UpdateChannel = 'stable' | 'beta';

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: 'beta' | 'rc' | null;
  prereleaseNumber: number;
}

export interface SignedUpdateArtifact {
  name: string;
  sha256: string;
  sha512?: string;
}

export interface SignedUpdatePayload {
  schemaVersion: 1;
  tag: string;
  version: string;
  channel: UpdateChannel;
  issuedAt: string;
  artifacts: {
    latest: SignedUpdateArtifact;
    setup: SignedUpdateArtifact;
    portable: SignedUpdateArtifact;
    signatures: SignedUpdateArtifact;
    checksums: SignedUpdateArtifact;
    blockmaps: SignedUpdateArtifact[];
  };
}

export interface SignedUpdateEnvelope {
  schemaVersion: 1;
  algorithm: 'ed25519';
  keyId: string;
  payload: string;
  signature: string;
}

export interface UpdateTrustConfig {
  schemaVersion: 1;
  keys: Array<{
    keyId: string;
    algorithm: 'ed25519';
    publicKey: string;
  }>;
}

interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: GitHubReleaseAsset[];
}

export interface VerifiedUpdateRelease {
  payload: SignedUpdatePayload;
  latestYaml: string;
  feedUrl: string;
}

function parseVersion(value: string): ParsedVersion {
  const match = VERSION_PATTERN.exec(value);
  if (!match) throw new Error(`Unsupported Subutai release version: ${value}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: (match[4] as 'beta' | 'rc' | undefined) ?? null,
    prereleaseNumber: match[5] ? Number(match[5]) : 0,
  };
}

export function releaseChannelForVersion(version: string): UpdateChannel {
  return parseVersion(version).prerelease === null ? 'stable' : 'beta';
}

export function compareReleaseVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (a.prerelease === null || b.prerelease === null) {
    if (a.prerelease === b.prerelease) return 0;
    return a.prerelease === null ? 1 : -1;
  }
  const rank = { beta: 0, rc: 1 } as const;
  if (rank[a.prerelease] !== rank[b.prerelease]) {
    return rank[a.prerelease] > rank[b.prerelease] ? 1 : -1;
  }
  return Math.sign(a.prereleaseNumber - b.prereleaseNumber);
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is invalid.`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is invalid.`);
  return value;
}

function validateArtifact(value: unknown, label: string, requireSha512 = false): SignedUpdateArtifact {
  const object = requireObject(value, label);
  const name = requireString(object.name, `${label} name`);
  const sha256 = requireString(object.sha256, `${label} SHA-256`).toLowerCase();
  if (!SHA256_PATTERN.test(sha256)) throw new Error(`${label} SHA-256 is invalid.`);
  const sha512 = object.sha512 === undefined ? undefined : requireString(object.sha512, `${label} SHA-512`);
  if (requireSha512 && (!sha512 || !BASE64_PATTERN.test(sha512))) throw new Error(`${label} SHA-512 is invalid.`);
  return sha512 ? { name, sha256, sha512 } : { name, sha256 };
}

export function validateSignedUpdatePayload(value: unknown, expectedChannel?: UpdateChannel): SignedUpdatePayload {
  const object = requireObject(value, 'Signed update payload');
  if (object.schemaVersion !== 1) throw new Error('Unsupported signed update payload schema.');
  const version = requireString(object.version, 'Signed update version');
  const tag = requireString(object.tag, 'Signed update tag');
  const channel = requireString(object.channel, 'Signed update channel') as UpdateChannel;
  const derivedChannel = releaseChannelForVersion(version);
  if (tag !== `v${version}`) throw new Error('Signed update tag and version do not match.');
  if (channel !== derivedChannel || (expectedChannel && channel !== expectedChannel)) {
    throw new Error('Signed update channel does not match the release version or installed channel.');
  }
  const issuedAt = requireString(object.issuedAt, 'Signed update issue time');
  const issuedAtMs = Date.parse(issuedAt);
  if (Number.isNaN(issuedAtMs) || issuedAtMs > Date.now() + 5 * 60_000) {
    throw new Error('Signed update issue time is invalid.');
  }
  const artifacts = requireObject(object.artifacts, 'Signed update artifacts');
  if (!Array.isArray(artifacts.blockmaps) || artifacts.blockmaps.length === 0) {
    throw new Error('Signed update blockmap list is invalid.');
  }
  const validated: SignedUpdatePayload = {
    schemaVersion: 1,
    tag,
    version,
    channel,
    issuedAt,
    artifacts: {
      latest: validateArtifact(artifacts.latest, 'latest.yml'),
      setup: validateArtifact(artifacts.setup, 'Setup installer', true),
      portable: validateArtifact(artifacts.portable, 'Portable executable'),
      signatures: validateArtifact(artifacts.signatures, 'Authenticode evidence'),
      checksums: validateArtifact(artifacts.checksums, 'Checksum evidence'),
      blockmaps: artifacts.blockmaps.map((item, index) => validateArtifact(item, `Blockmap ${index + 1}`)),
    },
  };
  if (validated.artifacts.latest.name !== 'latest.yml') throw new Error('Signed updater metadata filename is invalid.');
  if (validated.artifacts.signatures.name !== 'SIGNATURES.json') throw new Error('Signed Authenticode evidence filename is invalid.');
  if (validated.artifacts.checksums.name !== 'SHA256SUMS.txt') throw new Error('Signed checksum evidence filename is invalid.');
  if (!validated.artifacts.setup.name.includes(`-${version}-`) || !validated.artifacts.setup.name.endsWith('.exe')) {
    throw new Error('Signed Setup installer filename does not match the release version.');
  }
  if (!validated.artifacts.portable.name.includes(`-${version}-`) || !validated.artifacts.portable.name.endsWith('.exe')) {
    throw new Error('Signed Portable filename does not match the release version.');
  }
  if (validated.artifacts.blockmaps.some((artifact) => !artifact.name.endsWith('.blockmap'))) {
    throw new Error('Signed blockmap filename is invalid.');
  }
  return validated;
}

export function verifySignedUpdateEnvelope(
  envelopeValue: unknown,
  trustValue: unknown,
  expectedChannel?: UpdateChannel,
): SignedUpdatePayload {
  const envelope = requireObject(envelopeValue, 'Signed update envelope');
  if (envelope.schemaVersion !== 1 || envelope.algorithm !== 'ed25519') {
    throw new Error('Unsupported signed update envelope.');
  }
  const keyId = requireString(envelope.keyId, 'Signed update key ID');
  const payloadBase64 = requireString(envelope.payload, 'Signed update payload encoding');
  const signatureBase64 = requireString(envelope.signature, 'Signed update signature');
  if (!BASE64_PATTERN.test(payloadBase64) || !BASE64_PATTERN.test(signatureBase64)) {
    throw new Error('Signed update envelope contains invalid base64.');
  }
  const trust = requireObject(trustValue, 'Update trust config');
  if (trust.schemaVersion !== 1 || !Array.isArray(trust.keys)) throw new Error('Update trust config is invalid.');
  const trustedKey = trust.keys
    .map((value) => requireObject(value, 'Trusted update key'))
    .find((value) => value.keyId === keyId && value.algorithm === 'ed25519');
  if (!trustedKey) throw new Error('Signed update key is not trusted.');
  const publicKeyBase64 = requireString(trustedKey.publicKey, 'Trusted update public key');
  if (!BASE64_PATTERN.test(publicKeyBase64)) throw new Error('Trusted update public key is invalid.');
  const payloadBytes = Buffer.from(payloadBase64, 'base64');
  const signatureBytes = Buffer.from(signatureBase64, 'base64');
  const publicKey = createPublicKey({ key: Buffer.from(publicKeyBase64, 'base64'), format: 'der', type: 'spki' });
  if (!verify(null, payloadBytes, publicKey, signatureBytes)) throw new Error('Signed update manifest signature is invalid.');
  let payloadValue: unknown;
  try {
    payloadValue = JSON.parse(payloadBytes.toString('utf8')) as unknown;
  } catch {
    throw new Error('Signed update payload is not valid JSON.');
  }
  return validateSignedUpdatePayload(payloadValue, expectedChannel);
}

function assetUrl(release: GitHubRelease, name: string): string {
  const matches = release.assets.filter((asset) => asset.name === name);
  if (matches.length !== 1) throw new Error(`Release ${release.tag_name} must contain exactly one ${name} asset.`);
  const url = new URL(matches[0]!.browser_download_url);
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') {
    throw new Error(`Release ${release.tag_name} contains an untrusted asset URL.`);
  }
  return url.toString();
}

export function selectUpdateRelease(releases: GitHubRelease[], channel: UpdateChannel): GitHubRelease {
  const eligible = releases.filter((release) => {
    if (release.draft || !release.tag_name.startsWith('v')) return false;
    try {
      const releaseChannel = releaseChannelForVersion(release.tag_name.slice(1));
      return releaseChannel === channel && release.prerelease === (channel === 'beta');
    } catch {
      return false;
    }
  });
  eligible.sort((left, right) => compareReleaseVersions(right.tag_name.slice(1), left.tag_name.slice(1)));
  const selected = eligible[0];
  if (!selected) throw new Error(`No ${channel} Subutai release is available.`);
  return selected;
}

async function fetchJson(fetcher: typeof fetch, url: string): Promise<unknown> {
  const response = await fetcher(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Subutai-Desktop-Updater' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Update service returned HTTP ${response.status}.`);
  return response.json() as Promise<unknown>;
}

async function fetchText(fetcher: typeof fetch, url: string): Promise<string> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Update asset returned HTTP ${response.status}.`);
  return response.text();
}

export function assertUpdateNotReplayed(
  payload: SignedUpdatePayload,
  currentVersion: string,
  highestVerifiedVersion: string | null,
): void {
  if (compareReleaseVersions(payload.version, currentVersion) < 0) {
    throw new Error('Signed update is older than the installed application.');
  }
  if (highestVerifiedVersion && compareReleaseVersions(payload.version, highestVerifiedVersion) < 0) {
    throw new Error('Signed update is older than the last verified release.');
  }
}

export async function prepareVerifiedUpdateRelease(options: {
  currentVersion: string;
  resourcesPath: string;
  highestVerifiedVersion: string | null;
  fetcher?: typeof fetch;
}): Promise<VerifiedUpdateRelease> {
  const channel = releaseChannelForVersion(options.currentVersion);
  const trust = JSON.parse(await readFile(join(options.resourcesPath, 'update', 'trust.json'), 'utf8')) as unknown;
  const fetcher = options.fetcher ?? fetch;
  const releasesValue = await fetchJson(fetcher, RELEASES_API_URL);
  if (!Array.isArray(releasesValue)) throw new Error('Update service returned an invalid release list.');
  const release = selectUpdateRelease(releasesValue as GitHubRelease[], channel);
  const latestUrl = assetUrl(release, 'latest.yml');
  const [envelope, latestYaml] = await Promise.all([
    fetchJson(fetcher, assetUrl(release, UPDATE_MANIFEST_ASSET_NAME)),
    fetchText(fetcher, latestUrl),
  ]);
  const payload = verifySignedUpdateEnvelope(envelope, trust, channel);
  if (payload.tag !== release.tag_name) throw new Error('Signed update manifest does not match the selected GitHub release.');
  const latestHash = createHash('sha256').update(latestYaml, 'utf8').digest('hex');
  if (latestHash !== payload.artifacts.latest.sha256) throw new Error('latest.yml does not match the signed update manifest.');
  assertUpdateNotReplayed(payload, options.currentVersion, options.highestVerifiedVersion);
  return { payload, latestYaml, feedUrl: new URL('.', latestUrl).toString() };
}

export function assertUpdaterResultMatchesManifest(
  updateInfo: { version: string; files?: Array<{ url: string; sha512?: string }> },
  verified: VerifiedUpdateRelease,
): void {
  if (updateInfo.version !== verified.payload.version) throw new Error('Updater result version does not match the signed manifest.');
  const setup = updateInfo.files?.find((file) => {
    try {
      return decodeURIComponent(new URL(file.url, verified.feedUrl).pathname.split('/').pop() ?? '')
        === verified.payload.artifacts.setup.name;
    } catch {
      return false;
    }
  });
  if (!setup || setup.sha512 !== verified.payload.artifacts.setup.sha512) {
    throw new Error('Updater installer digest does not match the signed manifest.');
  }
}
