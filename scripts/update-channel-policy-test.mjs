import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const desktopPackage = JSON.parse(
  readFileSync(join(root, 'apps', 'desktop', 'package.json'), 'utf8'),
);
const releaseWorkflow = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8');
const runtime = readFileSync(join(root, 'apps', 'desktop', 'src', 'main', 'system', 'signed-update-manifest.ts'), 'utf8');

function requireText(source, expected, label) {
  if (!source.includes(expected)) {
    throw new Error(`${label} is missing required public update-channel contract: ${expected}`);
  }
}

const publishers = desktopPackage.build?.publish;
if (!Array.isArray(publishers) || publishers.length !== 1) {
  throw new Error('Desktop package must configure exactly one production update provider.');
}

const provider = publishers[0];
if (
  provider?.provider !== 'github'
  || provider.owner !== 'enkhbat194'
  || provider.repo !== 'subutai-releases'
  || provider.releaseType !== 'release'
) {
  throw new Error('Desktop updater must use the public enkhbat194/subutai-releases GitHub release channel.');
}
if (provider.private === true || provider.token) {
  throw new Error('Packaged clients must access the public update channel anonymously.');
}

for (const required of [
  'SUBUTAI_RELEASES_TOKEN: ${{ secrets.SUBUTAI_RELEASES_TOKEN }}',
  'repository: enkhbat194/subutai-releases',
  'token: ${{ secrets.SUBUTAI_RELEASES_TOKEN }}',
  'SUBUTAI_RELEASES_TOKEN is required to publish to enkhbat194/subutai-releases.',
  "prerelease: ${{ contains(env.RELEASE_TAG, '-') }}",
  'apps/desktop/release/subutai-update-manifest.json',
]) {
  requireText(releaseWorkflow, required, 'Release workflow');
}

for (const required of [
  "export type UpdateChannel = 'stable' | 'beta'",
  "release.prerelease === (channel === 'beta')",
  "autoUpdater.setFeedURL({ provider: 'generic', url: verifiedRelease.feedUrl })",
  "autoUpdater.allowDowngrade = false",
]) {
  const source = required.startsWith('autoUpdater')
    ? readFileSync(join(root, 'apps', 'desktop', 'src', 'main', 'system', 'system-runtime.ts'), 'utf8')
    : runtime;
  requireText(source, required, 'Signed update runtime');
}

if (releaseWorkflow.includes('target_commitish: ${{ github.sha }}')) {
  throw new Error('A private source commit SHA cannot be used as the tag target in the public binary repository.');
}

console.log('Subutai public update-channel policy passed: packaged clients read anonymous public releases while publishing requires a dedicated cross-repository secret.');
