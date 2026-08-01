import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const rootPackage = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const desktopPackage = JSON.parse(await readFile(new URL('../apps/desktop/package.json', import.meta.url), 'utf8'));
const githubTag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME ?? '' : '';
const requestedTag = process.argv[2] || process.env.RELEASE_TAG || githubTag;

assert.match(rootPackage.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'Root package version must be valid semver.');
assert.equal(desktopPackage.version, rootPackage.version, 'Root and desktop package versions must match.');

if (requestedTag) {
  assert.match(requestedTag, /^v\d+\.\d+\.\d+$/, 'Stable release tag must use v<major>.<minor>.<patch>.');
  assert.match(desktopPackage.version, /^\d+\.\d+\.\d+$/, 'Stable release package version must not contain a prerelease suffix.');
  assert.equal(requestedTag.slice(1), desktopPackage.version, `Tag ${requestedTag} does not match package version ${desktopPackage.version}.`);
}

console.log(`Subutai release version validated: ${desktopPackage.version}${requestedTag ? ` (${requestedTag})` : ''}`);
