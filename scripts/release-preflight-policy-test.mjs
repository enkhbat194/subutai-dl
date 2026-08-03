import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const readText = async (path) => readFile(new URL(path, import.meta.url), 'utf8');

const packages = [
  ['root', await readJson('../package.json')],
  ['desktop', await readJson('../apps/desktop/package.json')],
  ['extension', await readJson('../apps/extension/package.json')],
  ['shared', await readJson('../packages/shared/package.json')],
];

const expectedVersion = packages[0][1].version;
const supportedVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:beta|rc)\.[1-9]\d*)?$/u;

assert.match(expectedVersion, supportedVersion, 'Root package version is not a supported release version.');
for (const [name, packageJson] of packages) {
  assert.equal(packageJson.version, expectedVersion, `${name} package version must match ${expectedVersion}.`);
}

const [releaseWorkflow, releaseGate, projectStatus, releasing] = await Promise.all([
  readText('../.github/workflows/release.yml'),
  readText('../docs/DIRECT_1_0_RELEASE_GATE.md'),
  readText('../docs/PROJECT_STATUS.md'),
  readText('../docs/releasing.md'),
]);

const requiredSecrets = [
  'SUBUTAI_RELEASES_TOKEN',
  'WIN_CSC_LINK',
  'WIN_CSC_KEY_PASSWORD',
  'SUBUTAI_UPDATE_SIGNING_KEY_BASE64',
  'SUBUTAI_UPDATE_PUBLIC_KEY_BASE64',
];

for (const secret of requiredSecrets) {
  assert.ok(releaseWorkflow.includes(secret), `Release workflow must require ${secret}.`);
  assert.ok(releaseGate.includes(secret), `Release gate must document ${secret}.`);
  assert.ok(projectStatus.includes(secret), `Project status must document ${secret}.`);
  assert.ok(releasing.includes(secret), `Release process must document ${secret}.`);
}

for (const phrase of ['clean physical Windows 10', 'clean physical Windows 11']) {
  assert.ok(releaseGate.toLowerCase().includes(phrase.toLowerCase()), `Release gate must require ${phrase}.`);
  assert.ok(projectStatus.toLowerCase().includes(phrase.toLowerCase()), `Project status must require ${phrase}.`);
}

assert.ok(releaseGate.includes(`v${expectedVersion}`), 'Release gate must name the exact candidate tag.');
assert.ok(releasing.includes(`v${expectedVersion}`), 'Release process must name the exact candidate tag.');

console.log(`Subutai release preflight policy validated: ${expectedVersion}`);
