import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserManifestVersionForRelease } from './extension-version.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = join(root, 'apps', 'extension');
const chromiumSource = join(extensionRoot, 'chromium');
const firefoxSource = join(extensionRoot, 'firefox');
const output = join(extensionRoot, 'dist');
const sharedFiles = ['background.js', 'popup.html', 'popup.css', 'popup.js'];

const extensionPackage = JSON.parse(await readFile(join(extensionRoot, 'package.json'), 'utf8'));
const releaseVersion = extensionPackage.version;
const manifestVersion = browserManifestVersionForRelease(releaseVersion);

await rm(output, { recursive: true, force: true });
await mkdir(join(output, 'chromium'), { recursive: true });
await mkdir(join(output, 'firefox'), { recursive: true });
await cp(chromiumSource, join(output, 'chromium'), { recursive: true });
await cp(join(firefoxSource, 'manifest.json'), join(output, 'firefox', 'manifest.json'));
for (const filename of sharedFiles) {
  await cp(join(chromiumSource, filename), join(output, 'firefox', filename));
}

const chromiumManifest = JSON.parse(await readFile(join(chromiumSource, 'manifest.json'), 'utf8'));
const firefoxManifest = JSON.parse(await readFile(join(firefoxSource, 'manifest.json'), 'utf8'));
chromiumManifest.version = manifestVersion;
firefoxManifest.version = manifestVersion;
await writeFile(join(output, 'chromium', 'manifest.json'), `${JSON.stringify(chromiumManifest, null, 2)}\n`);
await writeFile(join(output, 'firefox', 'manifest.json'), `${JSON.stringify(firefoxManifest, null, 2)}\n`);
await writeFile(join(output, 'BUILD_INFO.json'), `${JSON.stringify({
  product: 'Subutai Download Manager Integration',
  version: releaseVersion,
  manifestVersion,
  chromiumExtensionId: 'bblhcboekmbodhhgfonhggdhejlfgiep',
  firefoxExtensionId: firefoxManifest.browser_specific_settings.gecko.id,
  browsers: ['Google Chrome', 'Microsoft Edge', 'Mozilla Firefox'],
}, null, 2)}\n`);

console.log(`Built browser extensions ${releaseVersion} (manifest ${manifestVersion}) in ${output}`);
