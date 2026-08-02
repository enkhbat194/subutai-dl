import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.log('Subutai updater rollback acceptance is Windows-only; skipped on this platform.');
  process.exit(0);
}

const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const watchdogSource = join(rootDirectory, 'apps', 'desktop', 'resources', 'updater', 'update-watchdog.ps1');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rm(`${path}.bak`, { force: true });
  try { await rename(path, `${path}.bak`); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await rename(temporary, path);
}

async function createFixture(base, name, options = {}) {
  const fixture = join(base, name);
  const updaterRoot = join(fixture, 'Updater');
  const installRoot = join(fixture, 'Programs');
  const installedExecutablePath = join(installRoot, 'Subutai Download Manager', 'Subutai Download Manager.exe');
  const transactionId = randomUUID();
  const previousInstallerPath = join(updaterRoot, 'packages', '1.0.0', 'Subutai-Setup-1.0.0-rollback.exe');
  const targetInstallerPath = join(updaterRoot, 'staged', transactionId, 'target-installer.exe');
  const watchdogPath = join(updaterRoot, 'watchdog', 'update-watchdog.ps1');
  const transactionPath = join(updaterRoot, 'update-transaction.json');
  const markerPath = join(updaterRoot, 'test-evidence', 'rollback.marker');
  const previousInstaller = Buffer.from('verified-previous-installer');
  const targetInstaller = Buffer.from('target-installer');

  for (const path of [previousInstallerPath, targetInstallerPath, watchdogPath, installedExecutablePath]) {
    await mkdir(dirname(path), { recursive: true });
  }
  await writeFile(previousInstallerPath, previousInstaller);
  await writeFile(targetInstallerPath, targetInstaller);
  await copyFile(watchdogSource, watchdogPath);
  await writeFile(installedExecutablePath, 'installed-new-version');

  const now = Date.now();
  const journal = {
    schemaVersion: 1,
    transactionId,
    currentVersion: '1.0.0',
    targetVersion: '1.1.0',
    previousWorkingVersion: '1.0.0',
    updateState: options.updateState ?? 'awaiting-health',
    rollbackState: options.rollbackState ?? 'ready',
    createdAt: new Date(now - 5_000).toISOString(),
    updatedAt: new Date(now - 1_000).toISOString(),
    previousInstallerPath,
    previousInstallerSha256: options.previousInstallerSha256 ?? sha256(previousInstaller),
    targetInstallerPath,
    targetInstallerSha256: sha256(targetInstaller),
    watchdogPath,
    watchdogSha256: sha256(await readFile(watchdogPath)),
    installedExecutablePath,
    startupAttemptCount: options.startupAttemptCount ?? 1,
    maxStartupAttempts: options.maxStartupAttempts ?? 3,
    rollbackAttemptCount: options.rollbackAttemptCount ?? 0,
    healthDeadline: options.healthDeadline ?? new Date(now - 1_000).toISOString(),
  };
  await atomicJson(transactionPath, journal);
  return { fixture, updaterRoot, installRoot, installedExecutablePath, transactionPath, markerPath, journal };
}

function runWatchdog(fixture) {
  const args = [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', join(fixture.updaterRoot, 'watchdog', 'update-watchdog.ps1'),
    '-TransactionPath', fixture.transactionPath,
    '-ParentProcessId', '0',
    '-PollMilliseconds', '100',
    '-TestMode',
    '-TestAllowedInstallRoot', fixture.installRoot,
    '-TestRollbackMarker', fixture.markerPath,
  ];
  const child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolvePromise) => {
    child.on('exit', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

const workspace = await mkdtemp(join(tmpdir(), 'subutai-updater-acceptance-'));
try {
  const healthy = await createFixture(workspace, 'healthy', {
    healthDeadline: new Date(Date.now() + 5_000).toISOString(),
  });
  const healthyRun = runWatchdog(healthy);
  await delay(350);
  const healthyJournal = JSON.parse(await readFile(healthy.transactionPath, 'utf8'));
  healthyJournal.updateState = 'committed';
  healthyJournal.rollbackState = 'not-required';
  healthyJournal.healthConfirmedAt = new Date().toISOString();
  await atomicJson(healthy.transactionPath, healthyJournal);
  const healthyResult = await healthyRun;
  assert.equal(healthyResult.code, 0, healthyResult.stderr);
  assert.equal(await exists(healthy.markerPath), false);
  console.log('Healthy update transaction acceptance passed.');

  const failed = await createFixture(workspace, 'failed-startup');
  const userData = join(failed.fixture, 'UserData');
  await mkdir(userData, { recursive: true });
  const preservation = {
    settings: '{"trayEnabled":true}',
    queue: '{"id":"queued-job"}',
    partial: 'partial-download-metadata',
    database: 'sqlite-user-database-fixture',
  };
  for (const [name, content] of Object.entries(preservation)) await writeFile(join(userData, name), content);
  const failedResult = await runWatchdog(failed);
  assert.equal(failedResult.code, 0, failedResult.stderr);
  assert.equal(await exists(failed.markerPath), true);
  const rolledBackJournal = JSON.parse(await readFile(failed.transactionPath, 'utf8'));
  assert.equal(rolledBackJournal.updateState, 'rolled-back');
  assert.equal(rolledBackJournal.rollbackState, 'succeeded');
  const bridge = JSON.parse(await readFile(join(failed.updaterRoot, 'browser-registration-fixture.json'), 'utf8'));
  assert.deepEqual(bridge, {
    chrome: failed.installedExecutablePath,
    edge: failed.installedExecutablePath,
    firefox: failed.installedExecutablePath,
  });
  for (const [name, content] of Object.entries(preservation)) {
    assert.equal(await readFile(join(userData, name), 'utf8'), content);
  }
  console.log('Failed startup rollback, user-data preservation and browser bridge acceptance passed.');

  const markerBefore = await readFile(failed.markerPath, 'utf8');
  const repeatedResult = await runWatchdog(failed);
  assert.equal(repeatedResult.code, 0, repeatedResult.stderr);
  assert.equal(await readFile(failed.markerPath, 'utf8'), markerBefore);
  console.log('Repeated rollback invocation remained bounded.');

  const checksum = await createFixture(workspace, 'checksum-mismatch', {
    previousInstallerSha256: '0'.repeat(64),
  });
  const checksumResult = await runWatchdog(checksum);
  assert.notEqual(checksumResult.code, 0);
  assert.equal(await exists(checksum.markerPath), false);
  const checksumJournal = JSON.parse(await readFile(checksum.transactionPath, 'utf8'));
  assert.equal(checksumJournal.updateState, 'failed-safe');
  assert.equal(checksumJournal.rollbackState, 'blocked');
  console.log('Installer checksum mismatch fail-safe acceptance passed.');

  const corrupt = await createFixture(workspace, 'corrupt-journal');
  await rm(`${corrupt.transactionPath}.bak`, { force: true });
  await writeFile(corrupt.transactionPath, '{corrupt');
  const corruptResult = await runWatchdog(corrupt);
  assert.notEqual(corruptResult.code, 0);
  assert.equal(await exists(corrupt.markerPath), false);
  const corruptEvidence = JSON.parse(await readFile(join(corrupt.updaterRoot, 'watchdog-evidence.json'), 'utf8'));
  assert.equal(corruptEvidence.outcome, 'corrupt-journal-no-action');
  console.log('Corrupt journal fail-safe acceptance passed.');

  const attemptLimit = await createFixture(workspace, 'attempt-limit', {
    startupAttemptCount: 3,
    maxStartupAttempts: 3,
    healthDeadline: new Date(Date.now() + 60_000).toISOString(),
  });
  const attemptResult = await runWatchdog(attemptLimit);
  assert.equal(attemptResult.code, 0, attemptResult.stderr);
  assert.equal(await exists(attemptLimit.markerPath), true);
  const attemptJournal = JSON.parse(await readFile(attemptLimit.transactionPath, 'utf8'));
  assert.equal(attemptJournal.rollbackAttemptCount, 1);
  assert.equal(attemptJournal.updateState, 'rolled-back');
  console.log('Bounded repeated startup failure acceptance passed.');

  console.log('Subutai transactional updater and rollback acceptance passed.');
} finally {
  await rm(workspace, { recursive: true, force: true });
}
