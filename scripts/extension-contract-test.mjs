import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserManifestVersionForRelease } from './extension-version.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = join(root, 'apps', 'extension');
const chromiumRoot = join(extensionRoot, 'chromium');
const firefoxRoot = join(extensionRoot, 'firefox');
const distRoot = join(extensionRoot, 'dist');
const chromium = JSON.parse(await readFile(join(chromiumRoot, 'manifest.json'), 'utf8'));
const firefox = JSON.parse(await readFile(join(firefoxRoot, 'manifest.json'), 'utf8'));
const builtChromium = JSON.parse(await readFile(join(distRoot, 'chromium', 'manifest.json'), 'utf8'));
const builtFirefox = JSON.parse(await readFile(join(distRoot, 'firefox', 'manifest.json'), 'utf8'));
const buildInfo = JSON.parse(await readFile(join(distRoot, 'BUILD_INFO.json'), 'utf8'));
const extensionPackage = JSON.parse(await readFile(join(extensionRoot, 'package.json'), 'utf8'));
const background = await readFile(join(chromiumRoot, 'background.js'), 'utf8');
const expectedManifestVersion = browserManifestVersionForRelease(extensionPackage.version);

assert.equal(chromium.manifest_version, 3);
assert.equal(firefox.manifest_version, 3);
for (const permission of ['nativeMessaging', 'downloads', 'contextMenus', 'cookies', 'webRequest']) {
  assert.ok(chromium.permissions.includes(permission), `Chromium permission missing: ${permission}`);
  assert.ok(firefox.permissions.includes(permission), `Firefox permission missing: ${permission}`);
}
assert.deepEqual(chromium.host_permissions, ['<all_urls>']);
assert.equal(firefox.browser_specific_settings.gecko.id, 'subutai-download@subutai.local');
assert.equal(builtChromium.version, expectedManifestVersion, 'Built Chromium manifest version must match the release version mapping.');
assert.equal(builtFirefox.version, expectedManifestVersion, 'Built Firefox manifest version must match the release version mapping.');
assert.equal(buildInfo.version, extensionPackage.version, 'Extension BUILD_INFO release version must match the workspace package.');
assert.equal(buildInfo.manifestVersion, expectedManifestVersion, 'Extension BUILD_INFO manifest version must match built manifests.');

const publicKey = Buffer.from(chromium.key, 'base64');
const digest = createHash('sha256').update(publicKey).digest().subarray(0, 16);
const alphabet = 'abcdefghijklmnop';
const extensionId = [...digest].map((byte) => alphabet[byte >> 4] + alphabet[byte & 15]).join('');
assert.equal(extensionId, 'bblhcboekmbodhhgfonhggdhejlfgiep');

for (const requiredFragment of [
  "const HOST_NAME = 'com.subutai.download_manager'",
  'api.downloads.onCreated.addListener',
  'api.contextMenus.onClicked.addListener',
  'api.runtime.sendNativeMessage',
  'api.cookies.getAll',
  'api.webRequest.onBeforeSendHeaders.addListener',
]) {
  assert.ok(background.includes(requiredFragment), `Background integration missing: ${requiredFragment}`);
}
assert.ok(!background.includes('eval('));
assert.ok(!background.includes('new Function('));
assert.ok(!background.includes('http://localhost'));
console.log(`Browser integration contract passed for release ${extensionPackage.version}, manifest ${expectedManifestVersion}, Chromium ${extensionId} and Firefox.`);
