import { readFile } from 'node:fs/promises';

const files = {
  vite: await readFile('apps/desktop/electron.vite.config.ts', 'utf8'),
  runtime: await readFile('apps/desktop/src/main/system/real-update-acceptance.ts', 'utf8'),
  driver: await readFile('apps/desktop/src/main/system/real-update-acceptance-driver.ts', 'utf8'),
  workflow: await readFile('.github/workflows/real-update-acceptance.yml', 'utf8'),
  harness: await readFile('scripts/real-two-installer-update-acceptance.ps1', 'utf8'),
};

const required = [
  [files.vite, '__SUBUTAI_REAL_UPDATE_ACCEPTANCE_BUILD__', 'compile-time acceptance gate'],
  [files.runtime, "process.env.SUBUTAI_REAL_UPDATE_ACCEPTANCE !== '1'", 'runtime opt-in gate'],
  [files.runtime, 'Real updater acceptance feed must use a loopback HTTP address.', 'loopback-only feed validation'],
  [files.driver, 'configureRealUpdateAcceptanceUpdater(autoUpdater)', 'acceptance updater driver wiring'],
  [files.workflow, 'contents: read', 'read-only workflow permissions'],
  [files.workflow, './scripts/real-two-installer-update-acceptance.ps1', 'real installer harness execution'],
  [files.harness, '--publish never', 'no-publication build'],
  [files.harness, 'healthy-update', 'healthy update assertion'],
  [files.harness, 'rolled-back', 'rollback assertion'],
  [files.harness, 'rollbackAttemptCount -gt 1', 'rollback loop bound'],
];

for (const [source, token, label] of required) {
  if (!source.includes(token)) throw new Error(`Missing ${label}: ${token}`);
}

for (const forbidden of ['gh release create', 'git tag', 'npm publish', 'electron-builder --publish always']) {
  if (Object.values(files).some((source) => source.includes(forbidden))) {
    throw new Error(`Real update acceptance must not publish: ${forbidden}`);
  }
}

console.log('Real update acceptance policy passed.');
