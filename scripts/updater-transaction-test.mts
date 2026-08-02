import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  armUpdateTransaction,
  beginStartupHealthAttempt,
  confirmUpdateHealth,
  prepareUpdateTransaction,
  readUpdateJournal,
  recordIntentionalExitSync,
  redactUpdateError,
  updateJournalPath,
  writeUpdateJournal,
} from '../apps/desktop/src/main/system/update-transaction.ts';

function hash(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function writeCachedInstaller(root: string, version: string, content: string): Promise<string> {
  const directory = join(root, 'packages', version);
  await mkdir(directory, { recursive: true });
  const installerPath = resolve(directory, `Subutai-Setup-${version}-rollback.exe`);
  await writeFile(installerPath, content);
  await writeFile(join(directory, 'package.json'), JSON.stringify({
    schemaVersion: 1,
    version,
    installerPath,
    sha256: hash(content),
    cachedAt: '2026-08-03T00:00:00.000Z',
  }, null, 2));
  return installerPath;
}

const fixture = await mkdtemp(join(tmpdir(), 'subutai-updater-'));
try {
  const root = resolve(fixture, 'Updater');
  const installRoot = resolve(fixture, 'Programs');
  const installedExecutablePath = resolve(installRoot, 'Subutai Download Manager', 'Subutai Download Manager.exe');
  await mkdir(dirname(installedExecutablePath), { recursive: true });
  await writeFile(installedExecutablePath, 'installed-v1');
  await writeCachedInstaller(root, '1.0.0', 'verified-old-installer');

  const downloadedInstallerPath = resolve(fixture, 'Subutai-Setup-1.1.0-x64.exe');
  const watchdogSourcePath = resolve(fixture, 'update-watchdog.ps1');
  await writeFile(downloadedInstallerPath, 'target-installer');
  await writeFile(watchdogSourcePath, 'Write-Output watchdog');

  const staged = await prepareUpdateTransaction({
    rootPath: root,
    currentVersion: '1.0.0',
    targetVersion: '1.1.0',
    downloadedInstallerPath,
    installedExecutablePath,
    watchdogSourcePath,
    allowedInstallRoots: [installRoot],
    healthTimeoutMs: 15_000,
  });
  assert.equal(staged.updateState, 'staged');
  assert.equal(staged.previousWorkingVersion, '1.0.0');
  assert.equal(staged.targetVersion, '1.1.0');
  assert.equal(staged.previousInstallerSha256, hash('verified-old-installer'));
  assert.equal(staged.targetInstallerSha256, hash('target-installer'));

  const armed = await armUpdateTransaction(root, [installRoot]);
  assert.equal(armed.updateState, 'awaiting-health');
  const attempt = await beginStartupHealthAttempt('1.1.0', {
    rootPath: root,
    allowedInstallRoots: [installRoot],
    healthTimeoutMs: 15_000,
  });
  assert.equal(attempt?.startupAttemptCount, 1);

  recordIntentionalExitSync('1.1.0', { rootPath: root, allowedInstallRoots: [installRoot] });
  const intentional = await readUpdateJournal({ rootPath: root, allowedInstallRoots: [installRoot] });
  assert.ok(intentional?.intentionalExitAt);
  if (!intentional) throw new Error('Expected update journal.');
  delete intentional.intentionalExitAt;
  await writeUpdateJournal(intentional, { rootPath: root, allowedInstallRoots: [installRoot] });

  const committed = await confirmUpdateHealth('1.1.0', { rootPath: root, allowedInstallRoots: [installRoot] });
  assert.equal(committed?.updateState, 'committed');
  assert.equal(committed?.rollbackState, 'not-required');
  assert.equal(await beginStartupHealthAttempt('1.1.0', { rootPath: root, allowedInstallRoots: [installRoot] }), null);

  const journalPath = updateJournalPath(root);
  await copyFile(journalPath, `${journalPath}.bak`);
  await rm(journalPath);
  const recovered = await readUpdateJournal({ rootPath: root, allowedInstallRoots: [installRoot] });
  assert.equal(recovered?.updateState, 'committed');
  await copyFile(`${journalPath}.bak`, journalPath);
  await writeFile(journalPath, '{broken json');
  await assert.rejects(
    readUpdateJournal({ rootPath: root, allowedInstallRoots: [installRoot] }),
    /journal is corrupt/iu,
  );
  await copyFile(`${journalPath}.bak`, journalPath);

  assert.equal(
    redactUpdateError('https://user:secret@example.test/file?token=abc&signature=def proxyPassword=hunter2'),
    'https://user:[redacted]@example.test/file?token=[redacted]&signature=[redacted] proxyPassword=[redacted]',
  );

  const mismatchRoot = resolve(fixture, 'MismatchUpdater');
  const mismatchInstaller = await writeCachedInstaller(mismatchRoot, '2.0.0', 'original');
  await writeFile(mismatchInstaller, 'tampered');
  await assert.rejects(
    prepareUpdateTransaction({
      rootPath: mismatchRoot,
      currentVersion: '2.0.0',
      targetVersion: '2.1.0',
      downloadedInstallerPath,
      installedExecutablePath,
      watchdogSourcePath,
      allowedInstallRoots: [installRoot],
    }),
    /checksum mismatch/iu,
  );

  const traversalRoot = resolve(fixture, 'TraversalUpdater');
  const outsideInstaller = resolve(fixture, 'outside.exe');
  await writeFile(outsideInstaller, 'outside');
  const traversalManifest = join(traversalRoot, 'packages', '3.0.0', 'package.json');
  await mkdir(dirname(traversalManifest), { recursive: true });
  await writeFile(traversalManifest, JSON.stringify({
    schemaVersion: 1,
    version: '3.0.0',
    installerPath: outsideInstaller,
    sha256: hash('outside'),
    cachedAt: '2026-08-03T00:00:00.000Z',
  }));
  await assert.rejects(
    prepareUpdateTransaction({
      rootPath: traversalRoot,
      currentVersion: '3.0.0',
      targetVersion: '3.1.0',
      downloadedInstallerPath,
      installedExecutablePath,
      watchdogSourcePath,
      allowedInstallRoots: [installRoot],
    }),
    /outside the controlled/iu,
  );

  console.log('Subutai updater transaction tests passed.');
} finally {
  await rm(fixture, { recursive: true, force: true });
}
