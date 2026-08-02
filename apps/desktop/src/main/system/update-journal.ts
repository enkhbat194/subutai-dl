import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const UPDATE_JOURNAL_SCHEMA_VERSION = 1 as const;
export const DEFAULT_HEALTH_TIMEOUT_MS = 300_000;
export const DEFAULT_MAX_STARTUP_ATTEMPTS = 3;

export type UpdateTransactionState =
  | 'staged'
  | 'awaiting-health'
  | 'committed'
  | 'rollback-running'
  | 'rolled-back'
  | 'failed-safe';
export type RollbackState = 'not-required' | 'ready' | 'running' | 'succeeded' | 'blocked';

export interface UpdateTransactionJournal {
  schemaVersion: typeof UPDATE_JOURNAL_SCHEMA_VERSION;
  transactionId: string;
  currentVersion: string;
  targetVersion: string;
  previousWorkingVersion: string;
  updateState: UpdateTransactionState;
  rollbackState: RollbackState;
  createdAt: string;
  updatedAt: string;
  previousInstallerPath: string;
  previousInstallerSha256: string;
  targetInstallerPath: string;
  targetInstallerSha256: string;
  watchdogPath: string;
  watchdogSha256: string;
  installedExecutablePath: string;
  startupAttemptCount: number;
  maxStartupAttempts: number;
  rollbackAttemptCount: number;
  healthDeadline: string;
  lastLaunchAt?: string;
  healthConfirmedAt?: string;
  intentionalExitAt?: string;
  rollbackStartedAt?: string;
  rollbackCompletedAt?: string;
  lastError?: string;
}

export interface ReadJournalOptions {
  rootPath?: string;
  allowedInstallRoots?: string[];
}

const UPDATE_STATES = new Set<UpdateTransactionState>([
  'staged', 'awaiting-health', 'committed', 'rollback-running', 'rolled-back', 'failed-safe',
]);
const ROLLBACK_STATES = new Set<RollbackState>([
  'not-required', 'ready', 'running', 'succeeded', 'blocked',
]);

export function updaterRootPath(override?: string): string {
  const local = process.env.LOCALAPPDATA?.trim() || join(homedir(), 'AppData', 'Local');
  return resolve(override?.trim() || join(local, 'Subutai', 'Updater'));
}

export function updateJournalPath(rootPath = updaterRootPath()): string {
  return join(resolve(rootPath), 'update-transaction.json');
}

export function cachedInstallerManifestPath(version: string, rootPath = updaterRootPath()): string {
  assertSafeVersion(version, 'Cached installer version');
  return join(resolve(rootPath), 'packages', version, 'package.json');
}

function comparablePath(value: string): string {
  const normalized = resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function isPathInside(parentPath: string, childPath: string): boolean {
  const offset = relative(comparablePath(parentPath), comparablePath(childPath));
  return offset === '' || (!offset.startsWith(`..${sep}`) && offset !== '..' && !isAbsolute(offset));
}

export function assertPathInside(parentPath: string, childPath: string, label: string): void {
  if (!isAbsolute(childPath) || !isPathInside(parentPath, childPath)) {
    throw new Error(`${label} is outside the controlled Subutai updater directory.`);
  }
}

export function assertSafeVersion(value: string, label: string): void {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u.test(value)) throw new Error(`${label} is invalid.`);
}

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${label} is not a SHA-256 digest.`);
}

function assertIsoDate(value: string, label: string): void {
  if (!value || Number.isNaN(Date.parse(value))) throw new Error(`${label} is invalid.`);
}

export function supportedInstallRoots(): string[] {
  return [
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs') : '',
    process.env.ProgramFiles || '',
    process.env['ProgramFiles(x86)'] || '',
  ].filter(Boolean).map((entry) => resolve(entry));
}

export function assertSupportedInstalledExecutable(
  executablePath: string,
  allowedRoots = supportedInstallRoots(),
): void {
  if (basename(executablePath).toLowerCase() !== 'subutai download manager.exe') {
    throw new Error('Installed executable name is not the controlled Subutai executable.');
  }
  if (allowedRoots.length === 0 || !allowedRoots.some((root) => isPathInside(root, executablePath))) {
    throw new Error('Transactional update is unavailable for this custom or portable installation path.');
  }
}

export function redactUpdateError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/([?&](?:token|access_token|auth|authorization|signature|sig|key|password|proxyPassword)=)[^&\s]+/giu, '$1[redacted]')
    .replace(/(https?:\/\/[^\s/@:]+:)[^@\s]+@/giu, '$1[redacted]@')
    .replace(/(proxy(?:Password)?\s*[=:]\s*)[^\s,;]+/giu, '$1[redacted]')
    .slice(0, 2_000);
}

export async function sha256File(filePath: string): Promise<string> {
  const handle = await open(filePath, 'r');
  const hash = createHash('sha256');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

async function atomicWriteText(filePath: string, text: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  const backupPath = `${filePath}.bak`;
  const handle = await open(temporaryPath, 'wx');
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  let movedCurrent = false;
  try {
    await rm(backupPath, { force: true });
    try {
      await rename(filePath, backupPath);
      movedCurrent = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (movedCurrent && !existsSync(filePath) && existsSync(backupPath)) {
      await rename(backupPath, filePath).catch(() => undefined);
    }
    throw error;
  }
}

function atomicWriteTextSync(filePath: string, text: string): void {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  const backupPath = `${filePath}.bak`;
  const descriptor = openSync(temporaryPath, 'wx');
  try {
    writeFileSync(descriptor, text, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  let movedCurrent = false;
  try {
    rmSync(backupPath, { force: true });
    try {
      renameSync(filePath, backupPath);
      movedCurrent = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    renameSync(temporaryPath, filePath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    if (movedCurrent && !existsSync(filePath) && existsSync(backupPath)) renameSync(backupPath, filePath);
    throw error;
  }
}

export function validateUpdateJournal(
  value: unknown,
  rootPath: string,
  allowedInstallRoots: string[],
): UpdateTransactionJournal {
  if (!value || typeof value !== 'object') throw new Error('Update transaction journal is not an object.');
  const journal = value as UpdateTransactionJournal;
  if (journal.schemaVersion !== UPDATE_JOURNAL_SCHEMA_VERSION) throw new Error('Unsupported update journal schema.');
  if (!/^[0-9a-f-]{36}$/iu.test(journal.transactionId)) throw new Error('Update transaction ID is invalid.');
  assertSafeVersion(journal.currentVersion, 'Current version');
  assertSafeVersion(journal.targetVersion, 'Target version');
  assertSafeVersion(journal.previousWorkingVersion, 'Previous working version');
  if (!UPDATE_STATES.has(journal.updateState)) throw new Error('Update transaction state is invalid.');
  if (!ROLLBACK_STATES.has(journal.rollbackState)) throw new Error('Rollback state is invalid.');
  assertIsoDate(journal.createdAt, 'Created timestamp');
  assertIsoDate(journal.updatedAt, 'Updated timestamp');
  assertIsoDate(journal.healthDeadline, 'Health deadline');
  assertSha256(journal.previousInstallerSha256, 'Previous installer hash');
  assertSha256(journal.targetInstallerSha256, 'Target installer hash');
  assertSha256(journal.watchdogSha256, 'Watchdog hash');
  assertPathInside(rootPath, journal.previousInstallerPath, 'Previous installer');
  assertPathInside(rootPath, journal.targetInstallerPath, 'Target installer');
  assertPathInside(rootPath, journal.watchdogPath, 'Watchdog');
  assertPathInside(join(rootPath, 'packages', journal.previousWorkingVersion), journal.previousInstallerPath, 'Previous installer');
  assertPathInside(join(rootPath, 'staged', journal.transactionId), journal.targetInstallerPath, 'Target installer');
  assertPathInside(join(rootPath, 'watchdog'), journal.watchdogPath, 'Watchdog');
  assertSupportedInstalledExecutable(journal.installedExecutablePath, allowedInstallRoots);
  if (!Number.isInteger(journal.startupAttemptCount) || journal.startupAttemptCount < 0) {
    throw new Error('Startup attempt count is invalid.');
  }
  if (!Number.isInteger(journal.maxStartupAttempts) || journal.maxStartupAttempts < 1 || journal.maxStartupAttempts > 10) {
    throw new Error('Maximum startup attempt count is invalid.');
  }
  if (!Number.isInteger(journal.rollbackAttemptCount) || journal.rollbackAttemptCount < 0 || journal.rollbackAttemptCount > 1) {
    throw new Error('Rollback attempt count is invalid.');
  }
  return journal;
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
}

export async function readUpdateJournal(options: ReadJournalOptions = {}): Promise<UpdateTransactionJournal | null> {
  const rootPath = updaterRootPath(options.rootPath);
  const filePath = updateJournalPath(rootPath);
  const allowedRoots = options.allowedInstallRoots ?? supportedInstallRoots();
  try {
    await stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const backupPath = `${filePath}.bak`;
    try {
      await stat(backupPath);
      return validateUpdateJournal(await readJson(backupPath), rootPath, allowedRoots);
    } catch (backupError) {
      if ((backupError as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error(`Update transaction journal recovery failed safely: ${redactUpdateError(backupError)}`);
    }
  }
  try {
    return validateUpdateJournal(await readJson(filePath), rootPath, allowedRoots);
  } catch (error) {
    throw new Error(`Update transaction journal is corrupt: ${redactUpdateError(error)}`);
  }
}

export async function writeUpdateJournal(
  journal: UpdateTransactionJournal,
  options: ReadJournalOptions = {},
): Promise<void> {
  const rootPath = updaterRootPath(options.rootPath);
  const allowedRoots = options.allowedInstallRoots ?? supportedInstallRoots();
  const validated = validateUpdateJournal(journal, rootPath, allowedRoots);
  await atomicWriteText(updateJournalPath(rootPath), `${JSON.stringify(validated, null, 2)}\n`);
}

export function writeUpdateJournalSync(
  journal: UpdateTransactionJournal,
  options: ReadJournalOptions = {},
): void {
  const rootPath = updaterRootPath(options.rootPath);
  const allowedRoots = options.allowedInstallRoots ?? supportedInstallRoots();
  const validated = validateUpdateJournal(journal, rootPath, allowedRoots);
  atomicWriteTextSync(updateJournalPath(rootPath), `${JSON.stringify(validated, null, 2)}\n`);
}

export function readUpdateJournalSync(options: ReadJournalOptions = {}): UpdateTransactionJournal | null {
  const rootPath = updaterRootPath(options.rootPath);
  const filePath = updateJournalPath(rootPath);
  const allowedRoots = options.allowedInstallRoots ?? supportedInstallRoots();
  try {
    return validateUpdateJournal(JSON.parse(readFileSync(filePath, 'utf8')) as unknown, rootPath, allowedRoots);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
