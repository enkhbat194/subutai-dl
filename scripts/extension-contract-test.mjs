import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const chromiumRoot = join(root, 'apps', 'extension', 'chromium');
const firefoxRoot = join(root, 'apps', 'extension', 'firefox');
const chromium = JSON.parse(await readFile(join(chromiumRoot, 'manifest.json'), 'utf8'));
const firefox = JSON.parse(await readFile(join(firefoxRoot, 'manifest.json'), 'utf8'));
const background = await readFile(join(chromiumRoot, 'background.js'), 'utf8');

assert.equal(chromium.manifest_version, 3);
assert.equal(firefox.manifest_version, 3);
for (const permission of ['nativeMessaging', 'downloads', 'contextMenus', 'cookies', 'webRequest']) {
  assert.ok(chromium.permissions.includes(permission), `Chromium permission missing: ${permission}`);
  assert.ok(firefox.permissions.includes(permission), `Firefox permission missing: ${permission}`);
}
assert.deepEqual(chromium.host_permissions, ['<all_urls>']);
assert.equal(firefox.browser_specific_settings.gecko.id, 'subutai-download@subutai.local');

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
console.log(`Browser integration contract passed for Chromium ${extensionId} and Firefox.`);
