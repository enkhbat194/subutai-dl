import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import {
  DEFAULT_HEALTH_TIMEOUT_MS,
  DEFAULT_MAX_STARTUP_ATTEMPTS,
  type UpdateTransactionJournal,
  assertPathInside,
  assertSafeVersion,
  assertSupportedInstalledExecutable,
  cachedInstallerManifestPath,
  sha256File,
  supportedInstallRoots,
  updaterRootPath,
  writeUpdateJournal,
} from './update-journal.ts';

interface CachedInstallerManifest {
  schemaVersion: 1;
  version: string;
  installerPath: string;
  sha256: string;
  cachedAt: string;
}

export interface PrepareUpdateTransactionOptions {
  rootPath?: string;
  currentVersion: string;
  targetVersion: string;
  downloadedInstallerPath: string;
  installedExecutablePath: string;
  watchdogSourcePath: string;
  healthTimeoutMs?: number;
  maxStartupAttempts?: number;
  allowedInstallRoots?: string[];
}

async function loadCachedInstaller(version: string, rootPath: string): Promise<CachedInstallerManifest> {
  const value = JSON.parse(await readFile(cachedInstallerManifestPath(version, rootPath), 'utf8')) as CachedInstallerManifest;
  if (value.schemaVersion !== 1 || value.version !== version) throw new Error('Cached rollback package metadata is invalid.');
  if (!/^[a-f0-9]{64}$/u.test(value.sha256)) throw new Error('Cached rollback package hash is invalid.');
  if (Number.isNaN(Date.parse(value.cachedAt))) throw new Error('Cached rollback timestamp is invalid.');
  assertPathInside(join(rootPath, 'packages', version), value.installerPath, 'Cached rollback package');
  if (!basename(value.installerPath).toLowerCase().endsWith('.exe')) throw new Error('Cached rollback package is not an executable installer.');
  if (await sha256File(value.installerPath) !== value.sha256) throw new Error('Cached rollback installer checksum mismatch.');
  return value;
}

export async function prepareUpdateTransaction(
  options: PrepareUpdateTransactionOptions,
): Promise<UpdateTransactionJournal> {
  const rootPath = updaterRootPath(options.rootPath);
  const allowedRoots = options.allowedInstallRoots ?? supportedInstallRoots();
  assertSafeVersion(options.currentVersion, 'Current version');
  assertSafeVersion(options.targetVersion, 'Target version');
  if (options.currentVersion === options.targetVersion) throw new Error('Target version must differ from current version.');
  assertSupportedInstalledExecutable(options.installedExecutablePath, allowedRoots);
  if (!isAbsolute(options.downloadedInstallerPath) || !options.downloadedInstallerPath.toLowerCase().endsWith('.exe')) {
    throw new Error('Downloaded update installer path is invalid.');
  }
  if (!isAbsolute(options.watchdogSourcePath)) throw new Error('Updater watchdog source path is invalid.');

  const previous = await loadCachedInstaller(options.currentVersion, rootPath);
  const transactionId = randomUUID();
  const stagedDirectory = join(rootPath, 'staged', transactionId);
  const targetInstallerPath = join(stagedDirectory, 'target-installer.exe');
  const watchdogDirectory = join(rootPath, 'watchdog');
  const watchdogPath = join(watchdogDirectory, 'update-watchdog.ps1');
  await mkdir(stagedDirectory, { recursive: true });
  await mkdir(watchdogDirectory, { recursive: true });
  await copyFile(options.downloadedInstallerPath, targetInstallerPath);
  await copyFile(options.watchdogSourcePath, watchdogPath);

  const [sourceHash, targetInstallerSha256, watchdogSha256] = await Promise.all([
    sha256File(options.downloadedInstallerPath),
    sha256File(targetInstallerPath),
    sha256File(watchdogPath),
  ]);
  if (sourceHash !== targetInstallerSha256) throw new Error('Staged update installer checksum mismatch.');

  const now = new Date();
  const timeout = Math.max(15_000, Math.min(600_000, options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS));
  const maxAttempts = Math.max(1, Math.min(10, Math.trunc(options.maxStartupAttempts ?? DEFAULT_MAX_STARTUP_ATTEMPTS)));
  const journal: UpdateTransactionJournal = {
    schemaVersion: 1,
    transactionId,
    currentVersion: options.currentVersion,
    targetVersion: options.targetVersion,
    previousWorkingVersion: options.currentVersion,
    updateState: 'staged',
    rollbackState: 'ready',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    previousInstallerPath: previous.installerPath,
    previousInstallerSha256: previous.sha256,
    targetInstallerPath,
    targetInstallerSha256,
    watchdogPath,
    watchdogSha256,
    installedExecutablePath: resolve(options.installedExecutablePath),
    startupAttemptCount: 0,
    maxStartupAttempts: maxAttempts,
    rollbackAttemptCount: 0,
    healthDeadline: new Date(now.getTime() + timeout).toISOString(),
  };
  await writeUpdateJournal(journal, { rootPath, allowedInstallRoots: allowedRoots });
  return journal;
}
