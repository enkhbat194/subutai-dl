import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const harness = readFileSync(join(root, 'scripts', 'restart-recovery-harness.mjs'), 'utf8');
const workflow = readFileSync(join(root, '.github', 'workflows', 'restart-recovery.yml'), 'utf8');
const packageJson = readFileSync(join(root, 'package.json'), 'utf8');
const nativeWorkflow = readFileSync(join(root, '.github', 'workflows', 'native-engine.yml'), 'utf8');
const acceptanceWorkflow = readFileSync(
  join(root, '.github', 'workflows', 'n5-production-acceptance.yml'),
  'utf8',
);
const releaseWorkflow = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8');

function requireText(source, expected, label) {
  if (!source.includes(expected)) throw new Error(`${label} is missing required contract: ${expected}`);
}

for (const required of [
  "case 'prepare'",
  "case 'verify'",
  "case 'status'",
  "case 'cleanup'",
  "case 'self-test'",
  'SUBUTAI_RESTART_REQUIRE_BOOT_CHANGE',
  '--require-boot-change',
  'preparedBootTime',
  'verifiedBootTime',
  'bootChanged',
  'Get-CimInstance Win32_OperatingSystem',
  'LOCALAPPDATA',
  'taskkill.exe',
  '.subutai.part',
  '.subutai.job.a',
  '.subutai.job.b',
  'expectedSha256',
  'finalSha256',
  'Restart recovery state remained after successful completion',
]) {
  requireText(harness, required, 'Restart recovery harness');
}

for (const required of [
  'workflow_dispatch:',
  '- prepare',
  '- verify',
  '- status',
  '- cleanup',
  'require_boot_change:',
  'contents: read',
  'cancel-in-progress: false',
  'runs-on: [self-hosted, Windows, X64, subutai]',
  'restart-recovery-harness.mjs prepare',
  'restart-recovery-harness.mjs", "verify',
  'Restart Windows manually',
  'run.cmd',
]) {
  requireText(workflow, required, 'Manual restart recovery workflow');
}

if (/^\s*(?:push|pull_request|schedule):/mu.test(workflow)) {
  throw new Error('Restart recovery workflow must remain manual-only.');
}
if (/\b(?:Restart-Computer|Stop-Computer|SetSuspendState|psshutdown)\b/iu.test(`${harness}\n${workflow}`)) {
  throw new Error('Restart recovery automation must never invoke Windows restart or suspend commands.');
}
if (/\bshutdown(?:\.exe)?\s+\/[rsh]/iu.test(`${harness}\n${workflow}`)) {
  throw new Error('Restart recovery automation must never invoke shutdown/restart flags.');
}
if (/rundll32(?:\.exe)?\s+powrprof/iu.test(`${harness}\n${workflow}`)) {
  throw new Error('Restart recovery automation must never invoke SetSuspendState through rundll32.');
}

requireText(packageJson, '"test:native-restart-harness"', 'Package scripts');
for (const [source, label] of [
  [nativeWorkflow, 'Native Engine workflow'],
  [acceptanceWorkflow, 'N5 acceptance workflow'],
  [releaseWorkflow, 'Stable release workflow'],
]) {
  requireText(source, 'pnpm test:native-restart-harness', label);
  requireText(source, 'SUBUTAI_RESTART_WORKSPACE', label);
}

console.log('Subutai restart recovery policy passed: two-phase durable state, boot fingerprint, integrity verification, manual-only workflow and no automated OS restart.');
