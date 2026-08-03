import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const releaseWorkflowPath = join(root, '.github', 'workflows', 'release.yml');
const packageValidationPath = join(root, 'scripts', 'validate-windows-package.ps1');
const mediaInstallerPath = join(root, 'scripts', 'install-temporary-media-tools.ps1');
const desktopPackagePath = join(root, 'apps', 'desktop', 'package.json');
const legacyResourcePath = join(
  root,
  'apps',
  'desktop',
  'resources',
  'engines',
  'win32-x64',
  'aria2c.exe',
);

const releaseWorkflow = readFileSync(releaseWorkflowPath, 'utf8');
const packageValidation = readFileSync(packageValidationPath, 'utf8');
const mediaInstaller = readFileSync(mediaInstallerPath, 'utf8');
const desktopPackage = JSON.parse(readFileSync(desktopPackagePath, 'utf8'));

function requireText(source, expected, label) {
  if (!source.includes(expected)) {
    throw new Error(`${label} is missing required text: ${expected}`);
  }
}

const prohibitedReleasePatterns = [
  /choco\s+install/iu,
  /Get-ChildItem[^\r\n]*aria2/iu,
  /Copy-Item[^\r\n]*aria2/iu,
];
if (prohibitedReleasePatterns.some((pattern) => pattern.test(releaseWorkflow))) {
  throw new Error('Release workflow must not install Chocolatey or the replaced direct-download engine.');
}
if (existsSync(legacyResourcePath)) {
  throw new Error(`Legacy direct-download resource still exists: ${legacyResourcePath}`);
}

requireText(releaseWorkflow, './scripts/install-temporary-media-tools.ps1', 'Release workflow');
requireText(releaseWorkflow, 'pnpm test:native-engine', 'Release workflow');
requireText(releaseWorkflow, 'pnpm test:release-engine', 'Release workflow');
requireText(releaseWorkflow, 'pnpm --filter @subutai/desktop build:win:signed', 'Release workflow');
requireText(mediaInstaller, 'Get-FileHash', 'Pinned media installer');
requireText(mediaInstaller, 'yt-dlp.exe', 'Pinned media installer');
requireText(mediaInstaller, 'ffmpeg.exe', 'Pinned media installer');
requireText(mediaInstaller, 'aria2c.exe', 'Pinned media installer negative assertion');
requireText(packageValidation, 'subutai-engine-host.exe', 'Windows package validation');
requireText(packageValidation, 'aria2c.exe', 'Windows package validation negative assertion');
requireText(packageValidation, 'Legacy direct-download engine must not be packaged', 'Windows package validation');
requireText(packageValidation, 'yt-dlp.exe', 'Windows package validation');
requireText(packageValidation, 'ffmpeg.exe', 'Windows package validation');

const resources = Array.isArray(desktopPackage.build?.extraResources)
  ? desktopPackage.build.extraResources
  : [];
const nativeHostResource = resources.find((entry) =>
  typeof entry?.from === 'string'
  && entry.from.endsWith('subutai-engine-host.exe')
  && entry.to === 'engines/subutai-engine-host.exe',
);
if (!nativeHostResource) {
  throw new Error('Desktop package does not embed subutai-engine-host.exe at the required engine path.');
}

console.log('Subutai release engine packaging policy passed.');
