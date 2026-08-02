import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const resilience = readFileSync(join(root, 'scripts', 'resilience-download-test.mjs'), 'utf8');
const acceptance = readFileSync(join(root, 'scripts', 'n5-windows-acceptance.ps1'), 'utf8');
const releaseWorkflow = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8');
const acceptanceWorkflow = readFileSync(
  join(root, '.github', 'workflows', 'n5-production-acceptance.yml'),
  'utf8',
);

function requireText(source, expected, label) {
  if (!source.includes(expected)) throw new Error(`${label} is missing required contract: ${expected}`);
}

if (/aria2(?:c\.exe)?/iu.test(resilience)) {
  throw new Error('Resilience acceptance must not execute the replaced direct-download engine.');
}
requireText(resilience, "'subutai-engine.exe'", 'Native resilience suite');
requireText(resilience, "'download-segmented'", 'Native resilience suite');
requireText(resilience, 'Process-kill resume passed', 'Native resilience suite');
requireText(resilience, 'Network drop/rebind recovery checksum passed', 'Native resilience suite');

for (const required of [
  'Portable package launch acceptance passed.',
  'Installed Setup launch and browser bridge registration passed.',
  'Uninstall and browser bridge cleanup acceptance passed.',
  'subutai-engine-host.exe',
  'browser-extension\\chromium\\manifest.json',
  'browser-extension\\firefox\\manifest.json',
]) {
  requireText(acceptance, required, 'Windows acceptance script');
}

for (const required of [
  'pnpm test:resilience',
  'pnpm test:production-acceptance',
  './scripts/n5-windows-acceptance.ps1',
]) {
  requireText(releaseWorkflow, required, 'Stable release workflow');
  requireText(acceptanceWorkflow, required, 'N5 acceptance workflow');
}

if (!acceptanceWorkflow.includes('runs-on: [self-hosted, Windows, X64, subutai]')) {
  throw new Error('N5 acceptance must execute on the real Subutai Windows runner.');
}
if (!acceptanceWorkflow.includes('contents: read')) {
  throw new Error('N5 acceptance workflow must be check-only with read repository permissions.');
}
if (acceptanceWorkflow.includes('softprops/action-gh-release')) {
  throw new Error('N5 acceptance workflow must not publish a release.');
}

console.log('Subutai N5 production acceptance policy passed: native resilience, Setup/Portable, browser bridge, uninstall and release gating.');
