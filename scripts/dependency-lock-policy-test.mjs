import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const packagePath = join(root, 'package.json');
const lockPath = join(root, 'pnpm-lock.yaml');
const nativeWorkflowPath = join(root, '.github', 'workflows', 'native-engine.yml');
const releaseWorkflowPath = join(root, '.github', 'workflows', 'release.yml');

if (!existsSync(lockPath)) {
  throw new Error('pnpm-lock.yaml is required for reproducible Subutai builds.');
}

const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
const lockfile = readFileSync(lockPath, 'utf8');
const nativeWorkflow = readFileSync(nativeWorkflowPath, 'utf8');
const releaseWorkflow = readFileSync(releaseWorkflowPath, 'utf8');

if (packageJson.packageManager !== 'pnpm@10.15.0') {
  throw new Error(`Expected packageManager pnpm@10.15.0; received ${String(packageJson.packageManager)}.`);
}

const requiredLockText = [
  "lockfileVersion: '9.0'",
  'importers:',
  '  .: {}',
  '  apps/desktop:',
  '  apps/extension: {}',
  '  packages/shared:',
];
for (const expected of requiredLockText) {
  if (!lockfile.includes(expected)) {
    throw new Error(`pnpm-lock.yaml is missing required workspace data: ${expected}`);
  }
}

for (const [label, workflow] of [
  ['Native-engine workflow', nativeWorkflow],
  ['Release workflow', releaseWorkflow],
]) {
  if (!workflow.includes('pnpm install --frozen-lockfile')) {
    throw new Error(`${label} must install from the committed lockfile.`);
  }
  if (workflow.includes('pnpm install --no-frozen-lockfile')) {
    throw new Error(`${label} must not regenerate dependencies during verification or release.`);
  }
  if (!workflow.includes('pnpm test:dependency-lock')) {
    throw new Error(`${label} must execute the dependency-lock policy gate.`);
  }
}

console.log('Subutai dependency lock policy passed: pnpm 10.15.0, lockfile v9, frozen CI and release installs.');
