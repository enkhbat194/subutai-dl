const RELEASE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(beta|rc)\.([1-9]\d*))?$/u;
const MAX_COMPONENT = 65535;
const BETA_BASE = 10000;
const RC_BASE = 30000;
const STABLE_COMPONENT = 60000;

export function browserManifestVersionForRelease(version) {
  const match = RELEASE_VERSION_PATTERN.exec(version);
  if (!match) throw new Error(`Unsupported Subutai release version: ${version}`);

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const channel = match[4] ?? null;
  const sequence = match[5] ? Number(match[5]) : 0;

  for (const [name, component] of [['major', major], ['minor', minor], ['patch', patch]]) {
    if (component > MAX_COMPONENT) throw new Error(`Browser manifest ${name} version component exceeds ${MAX_COMPONENT}.`);
  }

  let channelComponent = STABLE_COMPONENT;
  if (channel === 'beta') channelComponent = BETA_BASE + sequence;
  if (channel === 'rc') channelComponent = RC_BASE + sequence;
  if (channelComponent > MAX_COMPONENT) {
    throw new Error(`Browser manifest prerelease sequence exceeds the supported range for ${version}.`);
  }

  return `${major}.${minor}.${patch}.${channelComponent}`;
}
