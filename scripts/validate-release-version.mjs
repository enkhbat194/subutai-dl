import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const rootPackage = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const desktopPackage = JSON.parse(await readFile(new URL('../apps/desktop/package.json', import.meta.url), 'utf8'));
const githubTag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME ?? '' : '';
const requestedTag = process.argv[2] || process.env.RELEASE_TAG || githubTag;
const numericIdentifier = '(?:0|[1-9]\\d*)';
const releaseVersionPattern = new RegExp(`^${numericIdentifier}\\.${numericIdentifier}\\.${numericIdentifier}(?:-(?:beta|rc)\\.[1-9]\\d*)?$`);
const releaseTagPattern = new RegExp(`^v${numericIdentifier}\\.${numericIdentifier}\\.${numericIdentifier}(?:-(?:beta|rc)\\.[1-9]\\d*)?$`);

assert.match(rootPackage.version, releaseVersionPattern, 'Root package version must be stable, beta.N or rc.N semver.');
assert.equal(desktopPackage.version, rootPackage.version, 'Root and desktop package versions must match.');

if (requestedTag) {
  assert.match(requestedTag, releaseTagPattern, 'Release tag must use v<major>.<minor>.<patch>, optionally followed by -beta.N or -rc.N.');
  assert.equal(requestedTag.slice(1), desktopPackage.version, `Tag ${requestedTag} does not match package version ${desktopPackage.version}.`);
}

console.log(`Subutai release version validated: ${desktopPackage.version}${requestedTag ? ` (${requestedTag})` : ''}`);
