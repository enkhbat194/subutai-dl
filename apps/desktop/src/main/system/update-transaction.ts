import { spawn } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  DEFAULT_HEALTH_TIMEOUT_MS,
  type ReadJournalOptions,
  type UpdateTransactionJournal,
  readUpdateJournal,
  readUpdateJournalSync,
  redactUpdateError,
  sha256File,
  updateJournalPath,
  updaterRootPath,
  writeUpdateJournal,
  writeUpdateJournalSync,
} from './update-journal.ts';

export * from './update-journal.ts';
export * from './update-staging.ts';

const WATCHDOG_STARTUP_TIMEOUT_MS = 5_000;
const WATCHDOG_STARTUP_POLL_MS = 100;

async function replaceJournal(
  rootPath: string,
  allowedInstallRoots: string[] | undefined,
  updater: (journal: UpdateTransactionJournal) => UpdateTransactionJournal | null,
): Promise<UpdateTransactionJournal | null> {
  const journalOptions: ReadJournalOptions = allowedInstallRoots
    ? { rootPath, allowedInstallRoots }
    : { rootPath };
  const journal = await readUpdateJournal(journalOptions);
  if (!journal) return null;
  const next = updater({ ...journal });
  if (!next) return null;
  next.updatedAt = new Date().toISOString();
  await writeUpdateJournal(next, journalOptions);
  return next;
}

function powerShellExecutablePath(): string {
  const windowsRoot = process.env.SystemRoot?.trim() || process.env.WINDIR?.trim();
  if (windowsRoot) {
    const systemPowerShell = join(
      windowsRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    if (existsSync(systemPowerShell)) return systemPowerShell;
  }
  return 'powershell.exe';
}

async function waitForWatchdogStartup(
  child: ReturnType<typeof spawn>,
  launcherLogPath: string,
  startupOffset: number,
): Promise<void> {
  const deadline = Date.now() + WATCHDOG_STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const log = readFileSync(launcherLogPath);
      const newOutput = log.subarray(Math.min(startupOffset, log.length)).toString('utf8');
      if (newOutput.includes('watchdog-started')) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (child.exitCode !== null) {
      throw new Error(`Updater watchdog exited before startup acknowledgement with code ${child.exitCode}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, WATCHDOG_STARTUP_POLL_MS));
  }
  throw new Error(`Updater watchdog did not acknowledge startup within ${WATCHDOG_STARTUP_TIMEOUT_MS}ms.`);
}

export async function armUpdateTransaction(
  rootPath?: string,
  allowedInstallRoots?: string[],
): Promise<UpdateTransactionJournal> {
  const root = updaterRootPath(rootPath);
  const result = await replaceJournal(root, allowedInstallRoots, (journal) => {
    if (journal.updateState !== 'staged') throw new Error('Update transaction is not staged.');
    journal.updateState = 'awaiting-health';
    journal.rollbackState = 'ready';
    return journal;
  });
  if (!result) throw new Error('Staged update transaction is missing.');
  return result;
}

export async function beginStartupHealthAttempt(
  currentVersion: string,
  options: ReadJournalOptions & { healthTimeoutMs?: number } = {},
): Promise<UpdateTransactionJournal | null> {
  const root = updaterRootPath(options.rootPath);
  const timeout = Math.max(15_000, Math.min(600_000, options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS));
  return replaceJournal(root, options.allowedInstallRoots, (journal) => {
    if (journal.updateState !== 'awaiting-health' || journal.targetVersion !== currentVersion) return null;
    const now = new Date();
    journal.startupAttemptCount += 1;
    journal.lastLaunchAt = now.toISOString();
    journal.healthDeadline = new Date(now.getTime() + timeout).toISOString();
    delete journal.intentionalExitAt;
    return journal;
  });
}

export async function confirmUpdateHealth(
  currentVersion: string,
  options: ReadJournalOptions = {},
): Promise<UpdateTransactionJournal | null> {
  return replaceJournal(updaterRootPath(options.rootPath), options.allowedInstallRoots, (journal) => {
    if (journal.updateState !== 'awaiting-health' || journal.targetVersion !== currentVersion) return null;
    journal.updateState = 'committed';
    journal.rollbackState = 'not-required';
    journal.healthConfirmedAt = new Date().toISOString();
    delete journal.intentionalExitAt;
    delete journal.lastError;
    return journal;
  });
}

export async function recordStartupHealthFailure(
  currentVersion: string,
  error: unknown,
  options: ReadJournalOptions = {},
): Promise<UpdateTransactionJournal | null> {
  return replaceJournal(updaterRootPath(options.rootPath), options.allowedInstallRoots, (journal) => {
    if (journal.updateState !== 'awaiting-health' || journal.targetVersion !== currentVersion) return null;
    journal.lastError = redactUpdateError(error);
    return journal;
  });
}

export function recordIntentionalExitSync(
  currentVersion: string,
  options: ReadJournalOptions = {},
): void {
  const journal = readUpdateJournalSync(options);
  if (!journal || journal.updateState !== 'awaiting-health' || journal.targetVersion !== currentVersion) return;
  journal.intentionalExitAt = new Date().toISOString();
  journal.updatedAt = journal.intentionalExitAt;
  writeUpdateJournalSync(journal, options);
}

export async function launchUpdateWatchdog(
  journal: UpdateTransactionJournal,
  parentProcessId = process.pid,
): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Transactional updater watchdog requires Windows.');
  if (await sha256File(journal.watchdogPath) !== journal.watchdogSha256) {
    throw new Error('Updater watchdog checksum mismatch.');
  }
  if (!Number.isSafeInteger(parentProcessId) || parentProcessId < 0) {
    throw new Error('Updater watchdog parent process identifier is invalid.');
  }

  const rootPath = dirname(dirname(journal.watchdogPath));
  const launcherLogPath = join(rootPath, 'watchdog-launcher.log');
  const childOutputPath = join(rootPath, 'watchdog-child.log');
  appendFileSync(
    launcherLogPath,
    `${new Date().toISOString()} launcher-requested transaction=${journal.transactionId}\n`,
    'utf8',
  );
  const startupOffset = statSync(launcherLogPath).size;
  const watchdogArguments = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    journal.watchdogPath,
    '-TransactionPath',
    updateJournalPath(rootPath),
    '-ParentProcessId',
    String(parentProcessId),
    '-LauncherLogPath',
    launcherLogPath,
  ];

  const childOutputFile = openSync(childOutputPath, 'a');
  let child: ReturnType<typeof spawn> | null = null;
  try {
    child = await new Promise<ReturnType<typeof spawn>>((resolve, reject) => {
      const spawned = spawn(powerShellExecutablePath(), watchdogArguments, {
        windowsHide: true,
        detached: false,
        stdio: ['ignore', childOutputFile, childOutputFile],
      });
      spawned.once('error', reject);
      spawned.once('spawn', () => resolve(spawned));
    });
    await waitForWatchdogStartup(child, launcherLogPath, startupOffset);
    appendFileSync(
      launcherLogPath,
      `${new Date().toISOString()} watchdog-start-acknowledged transaction=${journal.transactionId}\n`,
      'utf8',
    );
    child.unref();
  } catch (error) {
    if (child) {
      if (child.exitCode === null) child.kill();
      child.unref();
    }
    try {
      appendFileSync(
        launcherLogPath,
        `${new Date().toISOString()} watchdog-start-failed ${redactUpdateError(error)}\n`,
        'utf8',
      );
    } catch {
      // Preserve the original spawn error.
    }
    throw error;
  } finally {
    closeSync(childOutputFile);
  }
}
